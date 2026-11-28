//! `fetchVersionsBatched` of `src/util/catalog/registry.ts`: one packument per package name, asked with the abbreviated
//! metadata `Accept` header, at most eight at a time, each with the 15 seconds Node gives it.
//!
//! A request that fails is the name's entry in `failed`, as in Node (it catches everything); a second failure is not
//! reproduced, because Node lists the names in the order the requests ended. What Node would do differently from this
//! client is the reason to hand the run over instead:
//!
//! - a redirect (`fetch` follows more of them than the client does), a body larger than the client's cap, and a
//!   body that is not decoded the way `response.json()` decodes it (byte-order mark, invalid UTF-8);
//! - an answer that parses as JSON in a way this crate's reader does not (a repeated key, a fraction), or whose
//!   `dist-tags.latest` or `versions` is not the text or the object the comparison reads;
//! - a version key that is not a strict semver, which `rcompare` would throw on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use super::npmrc::Npmrc;
use super::version::is_strict_semver;
use crate::http::node_fetch::{fetch_config, url_is_plain};
use crate::http::{HttpClient, HttpConfig, HttpError};
use crate::json::{self, Json};

/// `DEFAULT_FETCH_TIMEOUT`.
const TIMEOUT: Duration = Duration::from_secs(15);

/// `maxConcurrentRequests` when the command gives none.
const CONCURRENCY: usize = 8;

/// `Accept` of the abbreviated metadata, the one Node asks for when it needs no publish times.
const ACCEPT: &str = "application/vnd.npm.install-v1+json";

/// `RegistryVersionInfo`: the `latest` dist-tag (`""` when there is none) and the version keys in registry order.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Info {
    pub(super) latest: String,
    pub(super) versions: Vec<String>,
}

/// What a request came to.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    Info(Info),
    Failed,
}

/// The package that could not be fetched, if one could not, and the others' versions.
pub(super) struct Fetched {
    pub(super) failed: Vec<String>,
    pub(super) versions: HashMap<String, Info>,
}

/// What `fetchPackageVersions` makes of a 2xx body, or the reason it is Node's.
fn read_body(text: &str) -> Result<Answer, String> {
    if text.starts_with('\u{feff}') {
        return Err("the answer starts with a byte-order mark".to_owned());
    }

    let Some(document) = json::parse(text) else {
        // `response.json()` rejects text that is no JSON at all, and that is a failed fetch; a document this crate's
        // reader leaves alone (a repeated key, a fraction) is one Node reads its own way.
        return if serde_json::from_str::<serde_json::Value>(text).is_err() {
            Ok(Answer::Failed)
        } else {
            Err("the answer is JSON that this crate does not read the way JavaScript does".to_owned())
        };
    };

    let Json::Object(_) = &document else {
        // `null` throws at the first property read; any other value has no `dist-tags` and no `versions`.
        return Ok(if document == Json::Null {
            Answer::Failed
        } else {
            Answer::Info(Info { latest: String::new(), versions: Vec::new() })
        });
    };

    let latest = match document.get("dist-tags") {
        Some(Json::Object(_)) => match document.get("dist-tags").and_then(|tags| tags.get("latest")) {
            None | Some(Json::Null) => String::new(),
            Some(Json::Str(latest)) => latest.clone(),
            Some(_) => return Err("`dist-tags.latest` is not text".to_owned()),
        },
        _ => String::new(),
    };

    let versions = match document.get("versions") {
        None | Some(Json::Null) => Vec::new(),
        Some(Json::Object(entries)) => entries.iter().map(|(version, _)| version.clone()).collect(),
        Some(_) => return Err("`versions` is not an object".to_owned()),
    };

    if let Some(odd) = versions.iter().find(|version| !is_strict_semver(version)) {
        return Err(format!("the version key {odd:?} is not a plain semver"));
    }

    Ok(Answer::Info(Info { latest, versions }))
}

/// One packument: the URL `fetchPackageVersions` builds, then the answer.
fn fetch_one(client: &HttpClient, registry: &Npmrc, name: &str) -> Result<Answer, String> {
    let base = registry.registry_for(name);
    let url = format!("{}/{name}", base.strip_suffix('/').unwrap_or(base));

    if !url_is_plain(&url) {
        return Err(format!("the URL {url:?} is not one `fetch` and the client read alike"));
    }

    match client.get(&url, &[("accept", ACCEPT)]) {
        Ok(response) => match response.text() {
            Ok(text) => read_body(text),
            Err(error) => Err(format!("the answer is not UTF-8 text: {error}")),
        },
        Err(
            error
            @ (HttpError::Redirect(_) | HttpError::TooLarge { .. } | HttpError::Decode(_) | HttpError::Request(_)),
        ) => Err(error.to_string()),
        // A refusal, a status outside 2xx, a timeout: Node's `catch` puts the name in `failed`.
        Err(_) => Ok(Answer::Failed),
    }
}

/// Every name's packument. `Err` is the reason to hand the run to Node.
pub(super) fn fetch_all(names: &[String], registry: &Npmrc) -> Result<Fetched, String> {
    let client = HttpClient::new(fetch_config(HttpConfig::from_env(TIMEOUT, TIMEOUT), TIMEOUT));
    let next = AtomicUsize::new(0);
    let answers: Mutex<Vec<Option<Answer>>> = Mutex::new((0..names.len()).map(|_| None).collect());
    let failed: Mutex<Vec<usize>> = Mutex::new(Vec::new());
    let stop: Mutex<Option<String>> = Mutex::new(None);

    thread::scope(|scope| {
        for _ in 0..CONCURRENCY.min(names.len()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::SeqCst);

                if index >= names.len() || stop.lock().expect("stop lock").is_some() {
                    return;
                }

                match fetch_one(&client, registry, &names[index]) {
                    Ok(Answer::Failed) => {
                        failed.lock().expect("failed lock").push(index);
                        answers.lock().expect("answers lock")[index] = Some(Answer::Failed);
                    }
                    Ok(answer) => answers.lock().expect("answers lock")[index] = Some(answer),
                    Err(reason) => {
                        stop.lock().expect("stop lock").get_or_insert(reason);

                        return;
                    }
                }
            });
        }
    });

    if let Some(reason) = stop.into_inner().expect("stop lock") {
        return Err(reason);
    }

    let mut versions = HashMap::new();

    for (name, answer) in names.iter().zip(answers.into_inner().expect("answers lock")) {
        if let Some(Answer::Info(info)) = answer {
            versions.insert(name.clone(), info);
        }
    }

    // Node lists the names in the order their requests ended, which depends on how long each took (a timeout ends after a 404
    // that started later). One failure has one order; with more, the order is Node's to produce.
    let failed = failed.into_inner().expect("failed lock");

    if failed.len() > 1 {
        return Err("more than one package could not be fetched, and Node lists them in the order the requests ended"
            .to_owned());
    }

    Ok(Fetched { failed: failed.into_iter().map(|index| names[index].clone()).collect(), versions })
}

#[cfg(test)]
mod server_tests {
    use super::*;
    use crate::inspect::tests::{ok, Registry};

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| (*name).to_owned()).collect()
    }

    fn packument(latest: &str) -> serde_json::Value {
        serde_json::json!({ "dist-tags": { "latest": latest }, "versions": { "1.0.0": {}, latest: {} } })
    }

    fn config(registry: &Registry) -> Npmrc {
        super::super::npmrc::parse(&format!("registry={}/\n", registry.url())).expect("a registry line")
    }

    #[test]
    fn answers_are_read_and_one_failure_is_listed() {
        let registry = Registry::start(
            [
                ("/a".to_owned(), ok(&packument("1.2.0"))),
                ("/@s/b".to_owned(), ok(&packument("2.0.0"))),
                ("/c".to_owned(), (500, "boom".to_owned(), Vec::new())),
                ("/d".to_owned(), (200, "<html>".to_owned(), Vec::new())),
            ]
            .into_iter()
            .collect(),
        );
        let fetched = fetch_all(&names(&["a", "c", "@s/b"]), &config(&registry)).expect("fetches");

        assert_eq!(fetched.failed, ["c"]);
        assert_eq!(
            fetched.versions["a"],
            Info { latest: "1.2.0".into(), versions: vec!["1.0.0".into(), "1.2.0".into()] }
        );
        assert_eq!(fetched.versions["@s/b"].latest, "2.0.0");
        assert_eq!(fetched.versions.len(), 2);
        assert!(registry
            .paths
            .lock()
            .unwrap()
            .iter()
            .all(|head| head.to_ascii_lowercase().contains("accept: application/vnd.npm.install-v1+json")));
        assert_eq!(fetch_all(&names(&["d"]), &config(&registry)).expect("fetches").failed, ["d"]);
        assert_eq!(fetch_all(&names(&["unknown"]), &config(&registry)).expect("fetches").failed, ["unknown"]);
    }

    #[test]
    fn two_failures_are_handed_to_node_because_their_order_is_the_order_they_ended_in() {
        let registry = Registry::start([("/a".to_owned(), ok(&packument("1.2.0")))].into_iter().collect());

        assert!(fetch_all(&names(&["a", "ghost", "phantom"]), &config(&registry)).is_err());
    }

    #[test]
    fn a_redirect_or_a_version_that_is_no_semver_is_handed_to_node() {
        let registry = Registry::start(
            [
                ("/moved".to_owned(), (302, String::new(), vec![("location".to_owned(), "/a".to_owned())])),
                ("/a".to_owned(), ok(&packument("1.2.0"))),
                ("/odd".to_owned(), ok(&serde_json::json!({ "versions": { "1.0": {} } }))),
            ]
            .into_iter()
            .collect(),
        );

        assert!(fetch_all(&names(&["a", "moved"]), &config(&registry)).is_err());
        assert!(fetch_all(&names(&["odd"]), &config(&registry)).is_err());
        assert!(fetch_all(&names(&["a"]), &config(&registry)).is_ok());
    }

    #[test]
    fn many_names_are_each_asked_once() {
        let answers = (0..40).map(|index| (format!("/p{index}"), ok(&packument("1.1.0")))).collect();
        let registry = Registry::start(answers);
        let wanted: Vec<String> = (0..40).map(|index| format!("p{index}")).collect();
        let fetched = fetch_all(&wanted, &config(&registry)).expect("fetches");

        assert_eq!(fetched.versions.len(), 40);
        assert!(fetched.failed.is_empty());
        assert_eq!(registry.requests.load(std::sync::atomic::Ordering::SeqCst), 40);
        assert!(fetch_all(&[], &config(&registry)).expect("fetches").versions.is_empty());
    }

    #[test]
    fn a_url_the_client_and_fetch_read_differently_is_handed_to_node() {
        let config = super::super::npmrc::parse("registry=http://user:pw@127.0.0.1:20000/\n").expect("a registry line");

        assert!(fetch_all(&names(&["a"]), &config).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(text: &str) -> Result<Answer, String> {
        read_body(text)
    }

    #[test]
    fn a_packument_gives_its_latest_tag_and_its_version_keys_in_order() {
        let answer = info(r#"{"name":"x","dist-tags":{"latest":"1.2.0","next":"2.0.0-rc.1"},"versions":{"1.0.0":{},"1.2.0":{},"1.1.0":{}}}"#).unwrap();

        assert_eq!(
            answer,
            Answer::Info(Info {
                latest: "1.2.0".into(),
                versions: vec!["1.0.0".into(), "1.2.0".into(), "1.1.0".into()]
            })
        );
    }

    #[test]
    fn missing_parts_read_as_javascript_reads_them() {
        let empty = Answer::Info(Info { latest: String::new(), versions: Vec::new() });

        assert_eq!(info("{}").unwrap(), empty);
        assert_eq!(info(r#"{"dist-tags":null,"versions":null}"#).unwrap(), empty);
        assert_eq!(info(r#"{"dist-tags":"x"}"#).unwrap(), empty);
        assert_eq!(info(r#"{"dist-tags":{"latest":null}}"#).unwrap(), empty);
        assert_eq!(info("[1]").unwrap(), empty);
        assert_eq!(info("5").unwrap(), empty);
        assert_eq!(info("null").unwrap(), Answer::Failed);
        assert_eq!(info("<html>").unwrap(), Answer::Failed);
        assert_eq!(info("").unwrap(), Answer::Failed);
    }

    #[test]
    fn what_javascript_would_read_differently_is_node_s() {
        for text in [
            "\u{feff}{}",
            r#"{"dist-tags":{"latest":5}}"#,
            r#"{"versions":[]}"#,
            r#"{"versions":"x"}"#,
            r#"{"versions":{"1.0":{}}}"#,
            r#"{"versions":{"latest":{}}}"#,
            r#"{"versions":{"1.0.0":{}},"versions":{}}"#,
            r#"{"time":1.5}"#,
        ] {
            assert!(info(text).is_err(), "{text:?}");
        }
    }
}
