//! The plan of a run against a registry stub on 127.0.0.1, a temporary home and workspace, and a fixed clock. Nothing
//! leaves the machine.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use super::args::{self, Marshall};
use super::marshalls::repository_issue;
use super::*;

const DAY: u64 = 24 * 60 * 60 * 1000;
/// 2024-06-15T12:00:00.000Z.
pub(crate) const NOW: u64 = 1_718_452_800_000;

/// `YYYY-MM-DDTHH:MM:SS.sssZ` of a time in milliseconds, the inverse of `parse_date`.
fn iso(ms: u64) -> String {
    let (days, rest) = ((ms / DAY) as i64, ms % DAY);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

pub(crate) fn ago(days: f64) -> String {
    iso(NOW - (days * DAY as f64) as u64)
}

pub(crate) type Answers = HashMap<String, (u16, String, Vec<(String, String)>)>;

pub(crate) struct Registry {
    port: u16,
    pub(crate) requests: Arc<AtomicUsize>,
    pub(crate) paths: Arc<Mutex<Vec<String>>>,
}

impl Registry {
    pub(crate) fn start(answers: Answers) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (requests, paths) = (Arc::new(AtomicUsize::new(0)), Arc::new(Mutex::new(Vec::new())));
        let (count, seen) = (Arc::clone(&requests), Arc::clone(&paths));

        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (count, seen, answers) = (Arc::clone(&count), Arc::clone(&seen), answers.clone());

                thread::spawn(move || serve(stream, &answers, &count, &seen));
            }
        });

        Self { port, requests, paths }
    }

    pub(crate) fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

fn serve(mut stream: TcpStream, answers: &Answers, count: &AtomicUsize, seen: &Mutex<Vec<String>>) {
    let mut data = Vec::new();
    let mut chunk = [0_u8; 1024];

    while !data.windows(4).any(|window| window == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(read) => data.extend_from_slice(&chunk[..read]),
        }
    }

    let head = String::from_utf8_lossy(&data).into_owned();
    let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();

    count.fetch_add(1, Ordering::SeqCst);
    seen.lock().unwrap().push(head);

    let (status, body, headers) = answers.get(&path).cloned().unwrap_or((404, "{}".to_owned(), Vec::new()));
    let extra: String = headers.iter().map(|(name, value)| format!("{name}: {value}\r\n")).collect();
    let reply = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n{body}", body.len());

    drop(stream.write_all(reply.as_bytes()));
}

pub(crate) fn ok(body: &Value) -> (u16, String, Vec<(String, String)>) {
    (200, body.to_string(), Vec::new())
}

pub(crate) struct Setup {
    context: Context,
    home: PathBuf,
}

/// A setup that shares the home of `like` and takes `registry` as its registry.
fn setup_with(registry: &Registry, like: &Setup) -> Setup {
    let mut again = setup(Some(registry));

    again.context.home = like.home.clone();
    again.context.cache_dir = like.context.cache_dir.clone();
    again.home = like.home.clone();

    again
}

fn setup(registry: Option<&Registry>) -> Setup {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    let base = std::env::temp_dir().join(format!(
        "vis-inspect-plan-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let (home, root) = (base.join("home"), base.join("root"));

    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&root).unwrap();

    if let Some(registry) = registry {
        fs::write(root.join(".npmrc"), format!("registry={}\n", registry.url())).unwrap();
    }

    let cache_dir = home.join(".vis").join("cache").to_string_lossy().into_owned();

    Setup {
        context: Context {
            services: Services {
                downloads: registry.map_or_else(
                    || "http://127.0.0.1:49151/downloads".to_owned(),
                    |registry| format!("{}/downloads", registry.url()),
                ),
                github: registry.map_or_else(
                    || "http://127.0.0.1:49151/github".to_owned(),
                    |registry| format!("{}/github", registry.url()),
                ),
                keys: Some(registry.map_or_else(
                    || "http://127.0.0.1:49151/keys".to_owned(),
                    |registry| format!("{}/keys", registry.url()),
                )),
                dns: expired_domains::Resolver {
                    servers: vec!["127.0.0.1:49151".parse().unwrap()],
                    wait: std::time::Duration::from_millis(300),
                    declined: None,
                },
                github_token: None,
            },
            root,
            home: home.clone(),
            cache_dir,
            now_ms: NOW,
            layout: Some(Layout { width: 80, colour: false }),
            registry: None,
        },
        home,
    }
}

/// The packuments of a run against `registry`, with the home directory they cache under.
pub(crate) fn packuments_for(registry: &Registry) -> (Packuments, PathBuf) {
    let Setup { context, home } = setup(Some(registry));

    (Packuments::at(context.root, home.clone(), context.cache_dir, NOW, client()), home)
}

fn client() -> HttpClient {
    HttpClient::new(fetch_config(HttpConfig::default(), FETCH_TIMEOUT))
}

fn flags(words: &[&str]) -> Flags {
    let words: Vec<String> = ["inspect"].iter().chain(words).map(|word| (*word).to_owned()).collect();

    args::parse(&words).unwrap()
}

fn all() -> Vec<Marshall> {
    args::selected(
        Some(&[Marshall::Author, Marshall::Provenance, Marshall::S1ngularity, Marshall::NewBin, Marshall::Metadata]),
        &|_| None,
    )
    .unwrap()
}

pub(crate) fn user(name: &str) -> Value {
    json!({ "name": name, "email": format!("{name}@example.test") })
}

/// A version entry that has everything the metadata marshall wants.
pub(crate) fn entry(user_name: &str, extra: &Value) -> Value {
    let mut base = json!({
        "_npmUser": user(user_name), "license": "MIT", "readme": "# readme", "repository": { "type": "git", "url": "git+https://github.com/o/r.git" },
    });

    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }

    base
}

pub(crate) fn packument(versions: &Value, times: &Value) -> Value {
    let latest = versions.as_object().unwrap().keys().next_back().unwrap().clone();

    json!({ "name": "pkg", "dist-tags": { "latest": latest, "next": "2.0.0-beta.1" }, "versions": versions, "time": times })
}

/// A package with three releases by one maintainer, the newest 80 days old.
pub(crate) fn calm() -> Value {
    packument(
        &json!({ "1.0.0": entry("amy", &json!({})), "1.1.0": entry("amy", &json!({})), "1.2.0": entry("amy", &json!({})) }),
        &json!({ "1.0.0": ago(100.0), "1.1.0": ago(90.0), "1.2.0": ago(80.0) }),
    )
}

fn answers(body: &Value) -> Answers {
    HashMap::from([("/pkg".to_owned(), ok(body))])
}

fn plan_of(body: &Value, words: &[&str]) -> Result<Plan, String> {
    plan_with(body, &flags(words))
}

fn plan_with(body: &Value, flags: &Flags) -> Result<Plan, String> {
    let registry = Registry::start(answers(body));
    let setup = setup(Some(&registry));

    plan(flags, &all(), &setup.context, &client())
}

fn report_of(body: &Value, words: &[&str]) -> Value {
    let plan = plan_of(body, words).unwrap();

    serde_json::from_str(&plan.stdout).unwrap()
}

fn messages(report: &Value, key: &str) -> Vec<String> {
    report[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|finding| format!("[{}] {}", finding["marshall"].as_str().unwrap(), finding["message"].as_str().unwrap()))
        .collect()
}

#[test]
fn a_calm_package_has_no_findings_and_is_cached_as_node_caches_it() {
    let registry = Registry::start(answers(&calm()));
    let setup = setup(Some(&registry));
    let plan = plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).unwrap();

    assert_eq!(
        plan.stdout,
        "{\n  \"errors\": [],\n  \"findings\": [],\n  \"summary\": {\n    \"errorCount\": 0,\n    \"warningCount\": 0\n  },\n  \"warnings\": []\n}\n"
    );
    assert_eq!((plan.status, plan.stderr.as_str()), (0, ""));
    assert_eq!(registry.requests.load(Ordering::SeqCst), 1);
    assert!(registry.paths.lock().unwrap()[0].to_ascii_lowercase().contains("accept: application/json"));

    let [CacheAction::Write { file, text }] = plan.cache.as_slice() else {
        panic!("one cache write: {:?}", plan.cache)
    };

    assert_eq!(file, &setup.home.join(".vis/cache/packuments/pkg.json"));
    assert!(text.starts_with(&format!("{{\"cacheVersion\":3,\"createdAt\":{NOW},\"packument\":{{\"name\":\"pkg\",\"versions\":{{\"1.0.0\":{{\"version\":\"1.0.0\",\"_npmUser\":")));
    assert!(text.ends_with(",\"ttlMs\":1800000}"));

    commit(&plan.cache).unwrap();

    // The next run reads the file and asks nobody.
    let again = super::plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).unwrap();

    assert_eq!(again.stdout, plan.stdout);
    assert!(again.cache.is_empty());
    assert_eq!(registry.requests.load(Ordering::SeqCst), 1);
}

#[test]
fn an_expired_cache_entry_is_fetched_again_and_replaced() {
    let registry = Registry::start(answers(&calm()));
    let setup = setup(Some(&registry));
    let file = setup.home.join(".vis/cache/packuments/pkg.json");

    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, format!("{{\"cacheVersion\":3,\"createdAt\":{},\"packument\":{{\"name\":\"old\",\"versions\":{{}}}},\"ttlMs\":1800000}}", NOW - 1_800_001)).unwrap();

    let plan = plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).unwrap();

    assert_eq!(registry.requests.load(Ordering::SeqCst), 1);
    assert!(matches!(plan.cache.as_slice(), [CacheAction::Write { .. }]));
}

#[test]
fn a_missing_package_is_an_error_line_and_status_two() {
    let registry = Registry::start(HashMap::new());
    let setup = setup(Some(&registry));
    let plan = plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).unwrap();

    assert_eq!((plan.stdout.as_str(), plan.status), ("", 2));
    assert!(plan.stderr.starts_with("00:00:00 ERROR ") || plan.stderr.contains(" ERROR "), "{}", plan.stderr);
    assert!(plan.stderr.trim_end().ends_with("Package pkg not found in the registry."));
    assert!(plan.cache.is_empty());

    // A stale file Node would have deleted goes with it.
    let file = setup.home.join(".vis/cache/packuments/pkg.json");

    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, "{\"cacheVersion\":1}").unwrap();

    let plan = super::plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).unwrap();

    assert_eq!(plan.cache, [CacheAction::Remove(file)]);
}

#[test]
fn an_error_line_that_does_not_fit_is_handed_over() {
    let registry = Registry::start(HashMap::new());
    let mut setup = setup(Some(&registry));

    setup.context.layout = None;
    assert!(plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).is_err());
}

#[test]
fn a_scoped_name_is_asked_for_with_an_encoded_slash() {
    let registry = Registry::start(HashMap::from([("/@s%2fpkg".to_owned(), ok(&calm()))]));
    let setup = setup(Some(&registry));

    plan(&flags(&["@s/pkg", "--json"]), &all(), &setup.context, &client()).unwrap();
    assert!(registry.paths.lock().unwrap()[0].starts_with("GET /@s%2fpkg "));
}

#[test]
fn specs_resolve_like_resolve_version_range() {
    let body = calm();
    let one = |spec: &str| plan_of(&body, &[spec, "--json"]);

    assert!(one("pkg").unwrap().stdout.contains("errorCount"));
    assert!(one("pkg@latest").is_ok() && one("pkg@1.1.0").is_ok());

    // A tag that points nowhere still resolves to the name it holds, and the marshalls then find no entry.
    let report: Value = serde_json::from_str(&one("pkg@next").unwrap().stdout).unwrap();

    assert_eq!(report["summary"]["errorCount"], 0);

    // A range needs node-semver; an unknown exact version is a range to it too.
    let with_spec = |spec: &str| Flags {
        name: "pkg".to_owned(),
        spec: Some(spec.to_owned()),
        json: true,
        strict: false,
        only: None,
    };

    for spec in ["^1", "1.x", "9.9.9", "toString", "1 || 2"] {
        assert!(plan_with(&body, &with_spec(spec)).is_err(), "{spec}");
    }

    let empty = json!({ "name": "pkg", "versions": {} });
    let plan = plan_with(&empty, &with_spec("^1")).unwrap();

    assert_eq!(plan.status, 2);
    assert!(plan.stderr.trim_end().ends_with("Could not resolve pkg@^1 to a published version."), "{}", plan.stderr);
}

#[test]
fn a_run_without_a_spec_that_has_no_versions_names_latest() {
    let plan = plan_of(&json!({ "name": "pkg" }), &["pkg", "--json"]).unwrap();

    assert_eq!(plan.status, 2);
    assert!(
        plan.stderr.trim_end().ends_with("Could not resolve pkg@latest to a published version."),
        "{}",
        plan.stderr
    );
}

#[test]
fn the_author_marshall_reports_a_young_version_a_new_publisher_and_a_dormant_one() {
    let versions = json!({
        "1.0.0": entry("amy", &json!({})),
        "1.1.0": entry("amy", &json!({})),
        "1.2.0": entry("bob", &json!({})),
        "1.3.0": entry("amy", &json!({})),
    });

    // 1.2.0 is two days old, by someone who never published, on a package from years back.
    let times = json!({ "1.0.0": ago(1000.0), "1.1.0": ago(900.0), "1.2.0": ago(2.0), "1.3.0": ago(20.0) });
    let report = report_of(&packument(&versions, &times), &["pkg@1.2.0", "--json"]);

    assert_eq!(
        messages(&report, "findings"),
        [
            "[author] published 2.0 days ago (error threshold: 7)".to_owned(),
            "[author] first publish by bob@example.test on a 1000-day-old package".to_owned()
        ]
    );
    assert_eq!(report["summary"]["errorCount"], 2);

    // 1.3.0 is 20 days old (a warning) by amy, whose last release before it was 900 days ago... of 1.1.0 (the newest of hers).
    let report = report_of(&packument(&versions, &times), &["pkg@1.3.0", "--json"]);

    assert_eq!(
        messages(&report, "findings"),
        [
            "[author] published 20.0 days ago (warn threshold: 30)".to_owned(),
            "[author] previous release by amy@example.test was 900 days ago (error threshold: 274)".to_owned()
        ]
    );
    assert_eq!(
        (report["summary"]["errorCount"].as_u64(), report["summary"]["warningCount"].as_u64()),
        (Some(1), Some(1))
    );
}

#[test]
fn the_author_marshall_warns_about_a_gap_below_the_error_threshold() {
    let versions = json!({ "1.0.0": entry("amy", &json!({})), "1.1.0": entry("amy", &json!({})) });
    let times = json!({ "1.0.0": ago(200.4), "1.1.0": ago(100.0) });
    let report = report_of(&packument(&versions, &times), &["pkg", "--json"]);

    assert_eq!(
        messages(&report, "warnings"),
        ["[author] previous release by amy@example.test was 200 days ago (warn threshold: 183)".to_owned()]
    );
}

#[test]
fn a_time_in_another_form_is_handed_over() {
    let versions = json!({ "1.0.0": entry("amy", &json!({})) });

    assert!(plan_of(&packument(&versions, &json!({ "1.0.0": "2024-01-01" })), &["pkg", "--json"]).is_err());
    assert!(plan_of(&packument(&versions, &json!({ "1.0.0": 5 })), &["pkg", "--json"]).is_err());
}

#[test]
fn the_provenance_marshall_reports_a_dropped_attestation() {
    let signed = json!({ "dist": { "attestations": { "provenance": { "predicateType": "x" } } } });
    let versions = json!({ "1.0.0": entry("amy", &signed), "1.1.0": entry("amy", &signed), "1.2.0-beta.1": entry("amy", &json!({})), "1.2.0": entry("amy", &json!({})) });
    let report = report_of(&packument(&versions, &json!({})), &["pkg@1.2.0", "--json"]);

    assert_eq!(
        messages(&report, "errors"),
        ["[provenance] Prior version 1.1.0 had provenance but 1.2.0 does not.".to_owned()]
    );
}

#[test]
fn the_s1ngularity_marshall_needs_both_a_new_hook_and_a_dropped_attestation() {
    let signed =
        json!({ "dist": { "attestations": { "provenance": {} } }, "scripts": { "test": "x", "install": "node a.js" } });
    let versions = json!({
        "1.0.0": entry("amy", &signed),
        "1.1.0": entry("amy", &json!({ "scripts": { "install": "node b.js", "postinstall": "node c.js", "preinstall": "" } })),
    });
    let report = report_of(&packument(&versions, &json!({})), &["pkg", "--json"]);

    assert_eq!(
        messages(&report, "errors"),
        [
            "[provenance] Prior version 1.0.0 had provenance but 1.1.0 does not.".to_owned(),
            "[s1ngularity] 1.1.0 has install-script changes [install (changed), postinstall (introduced)] AND dropped the provenance attestation that 1.0.0 carried \u{2014} this is the s1ngularity compromised-publish shape.".to_owned()
        ]
    );

    let single = json!({ "1.0.0": entry("amy", &signed), "1.1.0": entry("amy", &json!({ "scripts": { "install": "node a.js", "postinstall": "x" } })) });
    let report = report_of(&packument(&single, &json!({})), &["pkg", "--json"]);

    assert!(messages(&report, "errors")[1]
        .starts_with("[s1ngularity] 1.1.0 has an install-script change [postinstall (introduced)] AND"));

    // No new hook, no finding.
    let quiet = json!({ "1.0.0": entry("amy", &signed), "1.1.0": entry("amy", &json!({ "scripts": { "install": "node a.js" } })) });

    assert_eq!(messages(&report_of(&packument(&quiet, &json!({})), &["pkg", "--json"]), "errors").len(), 1);
}

#[test]
fn the_new_bin_marshall_reports_a_bin_the_release_before_lacked() {
    let versions = json!({
        "1.0.0": entry("amy", &json!({ "bin": { "pkg": "cli.js" } })),
        "1.1.0": entry("amy", &json!({ "bin": { "pkg": "cli.js", "helper": "h.js", "other": "o.js" } })),
        "1.2.0": entry("amy", &json!({ "bin": "cli.js" })),
    });
    let packument = packument(&versions, &json!({}));

    assert_eq!(
        messages(&report_of(&packument, &["pkg@1.1.0", "--json"]), "warnings"),
        ["[newBin] 1.1.0 adds new bin scripts: h.js, o.js (prior: 1.0.0).".to_owned()]
    );
    // A string bin is named after the package.
    assert!(messages(&report_of(&packument, &["pkg@1.2.0", "--json"]), "warnings").is_empty());

    let scoped = json!({ "1.0.0": entry("amy", &json!({})), "1.1.0": entry("amy", &json!({ "bin": "cli.js" })) });
    let registry = Registry::start(HashMap::from([("/@s%2fpkg".to_owned(), ok(&packument_for(&scoped)))]));
    let setup = setup(Some(&registry));
    let plan = plan(&flags(&["@s/pkg", "--json"]), &all(), &setup.context, &client()).unwrap();
    let report: Value = serde_json::from_str(&plan.stdout).unwrap();

    assert_eq!(
        messages(&report, "warnings"),
        ["[newBin] 1.1.0 adds new bin script: cli.js (prior: 1.0.0).".to_owned()]
    );
    assert_eq!(report["warnings"][0]["packageName"], "@s/pkg");
}

fn packument_for(versions: &Value) -> Value {
    packument(versions, &json!({}))
}

#[test]
fn a_bin_named_like_an_object_member_is_handed_over() {
    let versions =
        json!({ "1.0.0": entry("amy", &json!({})), "1.1.0": entry("amy", &json!({ "bin": { "toString": "x.js" } })) });

    assert!(plan_of(&packument_for(&versions), &["pkg", "--json"]).is_err());
}

#[test]
fn the_metadata_marshall_lists_every_issue_of_the_version() {
    let bare = json!({ "1.0.0": { "_npmUser": user("amy"), "readme": "ERROR: No README data found!", "repository": { "url": "nonsense" } } });
    let report = report_of(&packument_for(&bare), &["pkg", "--json"]);

    assert_eq!(
        messages(&report, "warnings"),
        ["[metadata] Missing/invalid metadata: placeholder-readme, missing-license, invalid-repo-url.".to_owned()]
    );

    let nothing = json!({ "1.0.0": { "_npmUser": user("amy") } });

    assert_eq!(
        messages(&report_of(&packument_for(&nothing), &["pkg", "--json"]), "warnings"),
        ["[metadata] Missing/invalid metadata: missing-readme, missing-license, missing-repo.".to_owned()]
    );

    let private = json!({ "1.0.0": { "private": true } });

    assert!(messages(&report_of(&packument_for(&private), &["pkg", "--json"]), "warnings").is_empty());
}

#[test]
fn repositories_are_judged_the_way_url_can_parse_judges_them() {
    let issue = |url: &str| -> Result<Option<&'static str>, String> {
        repository_issue(&serde_json::from_value::<Js>(json!({ "repository": { "url": url } })).unwrap())
    };

    for good in [
        "git+https://github.com/o/r.git",
        "https://github.com/o/r",
        "git@github.com:o/r.git",
        "git+http://example.test:8080/x?y#z",
        "http://localhost/x",
        "ssh://git@github.com/o/r.git",
        "git+ssh://git@github.com/o/r.git",
        "git://github.com/o/r.git",
        "ssh://github.com:22/o/r",
        "git://1.2.3.4/x",
        "http://user@a.com/x",
        "http://a.com:/x",
        "github:moment/moment",
        "gitlab:o/r",
        "foo:",
        "x+y.z:a/b",
        "github:o/r#semver:^1",
    ] {
        assert_eq!(issue(good), Ok(None), "{good}");
    }

    for bad in [
        "github.com/o/r",
        "o/r",
        "git+",
        "//host/x",
        "./x",
        "user@host",
        "ssh://git@github.com:o/r.git",
        "http://h:99999/x",
        "http://a.com:ab/x",
    ] {
        assert_eq!(issue(bad), Ok(Some("invalid-repo-url")), "{bad}");
    }

    // Only the URL parser could tell these (some depend on the version of Node: `xn--` labels).
    for unsure in [
        "not a url",
        "http://999.999.999.999/x",
        "http://a.0xa/x",
        "https://xn--a.example/x",
        "http://@a.com/x",
        "git://user:pw@a.com/x",
        "ssh://a_b.com/x",
        "foo://host/x",
        "http:o",
        "http://[::1]/x",
    ] {
        assert!(issue(unsure).is_err(), "{unsure}");
    }
}

#[test]
fn the_exit_status_follows_errors_and_strict() {
    let warns = json!({ "1.0.0": { "_npmUser": user("amy") } });

    assert_eq!(plan_of(&packument_for(&warns), &["pkg", "--json"]).unwrap().status, 0);
    assert_eq!(plan_of(&packument_for(&warns), &["pkg", "--json", "--strict"]).unwrap().status, 1);
    assert_eq!(plan_of(&calm(), &["pkg", "--json", "--strict"]).unwrap().status, 0);

    let errs = json!({ "1.0.0": entry("amy", &json!({})) });

    assert_eq!(plan_of(&packument(&errs, &json!({ "1.0.0": ago(1.0) })), &["pkg", "--json"]).unwrap().status, 1);
}

#[test]
fn only_the_selected_marshalls_run() {
    let body = packument_for(&json!({ "1.0.0": { "_npmUser": user("amy") } }));
    let registry = Registry::start(answers(&body));
    let setup = setup(Some(&registry));
    let only_author = args::selected(Some(&[Marshall::Author]), &|_| None).unwrap();
    let plan = plan(&flags(&["pkg", "--json"]), &only_author, &setup.context, &client()).unwrap();

    assert!(plan.stdout.contains("\"errorCount\": 0") && plan.stdout.contains("\"warningCount\": 0"));
}

#[test]
fn what_node_would_fail_on_is_handed_over() {
    let unusual: [(u16, &str); 5] = [(500, "{}"), (200, "not json"), (200, "[]"), (200, "\u{feff}{}"), (200, "")];

    for (status, body) in unusual {
        let registry = Registry::start(HashMap::from([("/pkg".to_owned(), (status, body.to_owned(), Vec::new()))]));
        let setup = setup(Some(&registry));

        assert!(plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).is_err(), "{status} {body:?}");
    }

    let redirect = HashMap::from([(
        "/pkg".to_owned(),
        (302, String::new(), vec![("location".to_owned(), "/elsewhere".to_owned())]),
    )]);
    let registry = Registry::start(redirect);
    let setup = setup(Some(&registry));

    assert!(plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).is_err());
}

#[test]
fn a_registry_with_a_credential_is_never_asked() {
    let registry = Registry::start(answers(&calm()));
    let setup = setup(Some(&registry));
    let host = registry.url().replace("http://", "");

    fs::write(
        setup.context.root.join(".npmrc"),
        format!("registry={}/\n//{host}/:_authToken=secret\n", registry.url()),
    )
    .unwrap();
    assert!(plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).is_err());
    assert_eq!(registry.requests.load(Ordering::SeqCst), 0);
}

#[test]
fn a_packument_that_is_handed_over_is_not_cached() {
    let body = packument_for(&json!({ "constructor": {} }));
    let registry = Registry::start(answers(&body));
    let setup = setup(Some(&registry));

    assert!(plan(&flags(&["pkg", "--json"]), &all(), &setup.context, &client()).is_err());
    assert!(!setup.home.join(".vis/cache/packuments").exists());
}

#[test]
fn a_registry_on_the_context_is_asked_instead_of_the_npmrc() {
    let asked = Registry::start(answers(&calm()));
    let ignored = Registry::start(HashMap::new());
    let mut setup = setup(Some(&ignored));

    setup.context.registry = Some(asked.url());

    let (found, cache) = packument_of("pkg", &setup.context, &client()).unwrap();

    assert!(found.is_some() && cache.len() == 1);
    assert_eq!(asked.requests.load(Ordering::SeqCst), 1);
    assert_eq!(ignored.requests.load(Ordering::SeqCst), 0);
}

mod downloads_marshall {
    use super::*;

    fn with_downloads(answer: Option<(u16, &str)>, name: &str) -> (Registry, Setup) {
        let mut answers = answers(&calm());

        if let Some((status, body)) = answer {
            answers.insert(
                format!("/downloads/{}", name.replace('@', "%40").replace('/', "%2F")),
                (status, body.to_owned(), Vec::new()),
            );
        }

        let registry = Registry::start(answers);
        let setup = setup(Some(&registry));

        (registry, setup)
    }

    fn only_downloads(setup: &Setup) -> Result<Plan, String> {
        plan(&flags(&["pkg", "--json"]), &[Marshall::Downloads], &setup.context, &client())
    }

    fn writes(plan: &Plan) -> Vec<String> {
        plan.cache
            .iter()
            .filter_map(|action| match action {
                CacheAction::Write { file, text } if file.to_string_lossy().contains("/downloads/") => {
                    Some(text.clone())
                }
                _ => None,
            })
            .collect()
    }

    fn entry(count: u64) -> String {
        format!("{{\"createdAt\":{NOW},\"downloads\":{count},\"observedAt\":\"2024-06-15T12:00:00.000Z\",\"ttlMs\":86400000}}")
    }

    #[test]
    fn a_low_count_is_an_error_a_modest_one_a_warning_and_a_large_one_nothing() {
        for (count, severity, finds) in [
            (0, "error", true),
            (19, "error", true),
            (20, "warning", true),
            (9999, "warning", true),
            (10_000, "", false),
            (9_007_199_254_740_991_u64, "", false),
        ] {
            let (registry, setup) = with_downloads(Some((200, &format!("{{\"downloads\":{count}}}"))), "pkg");
            let plan = only_downloads(&setup).unwrap();
            let report: Value = serde_json::from_str(&plan.stdout).unwrap();

            assert_eq!(report["findings"].as_array().unwrap().len(), usize::from(finds), "{count}");

            if finds {
                let message = format!("Only {count} downloads in the past month.");

                assert_eq!(report["findings"][0]["message"], message.as_str());
                assert_eq!(report["findings"][0]["severity"], severity);
                assert_eq!(report["findings"][0]["marshall"], "downloads");
                assert_eq!(report["findings"][0]["packageName"], "pkg");
            }

            assert_eq!(plan.status, i32::from(severity == "error"), "{count}");
            // Every answer with a count is cached, the bytes Node writes.
            assert_eq!(writes(&plan), [entry(count)], "{count}");
            // The packument is fetched once, the count once.
            assert_eq!(registry.requests.load(Ordering::SeqCst), 2);
        }
    }

    #[test]
    fn the_request_asks_the_api_for_the_encoded_name_and_adds_no_header_of_its_own() {
        let (registry, setup) = with_downloads(Some((200, "{\"downloads\":5}")), "pkg");

        only_downloads(&setup).unwrap();

        let heads = registry.paths.lock().unwrap().clone();

        assert!(heads[1].starts_with("GET /downloads/pkg HTTP/1.1"), "{}", heads[1]);
        assert!(!heads[1].to_ascii_lowercase().contains("authorization"));
    }

    #[test]
    fn an_answer_without_a_count_is_one_warning_and_nothing_is_cached() {
        for (status, body) in [
            (404, "{\"error\":\"package pkg not found\"}"),
            (429, "{}"),
            (500, "oops"),
            (304, ""),
            (200, "{}"),
            (200, "{\"downloads\":\"5\"}"),
            (200, "{\"downloads\":null}"),
            (200, "null"),
            (200, "[]"),
            (200, "7"),
        ] {
            let (_registry, setup) = with_downloads(Some((status, body)), "pkg");
            let plan = only_downloads(&setup).unwrap();
            let report: Value = serde_json::from_str(&plan.stdout).unwrap();

            assert_eq!(
                messages(&report, "warnings"),
                ["[downloads] npm stats API returned no monthly download data."],
                "{status} {body}"
            );
            assert_eq!((plan.status, report["summary"]["errorCount"].as_u64()), (0, Some(0)));
            assert!(writes(&plan).is_empty());
        }
    }

    #[test]
    fn what_node_may_read_differently_is_handed_over() {
        for (status, body) in [
            (200, "<html></html>"),
            (200, ""),
            (200, "\u{feff}{\"downloads\":5}"),
            (200, "{\"downloads\":5.5}"),
            (200, "{\"downloads\":-1}"),
            (200, "{\"downloads\":1e21}"),
            (200, "{\"downloads\":9007199254740993}"),
        ] {
            let (_registry, setup) = with_downloads(Some((status, body)), "pkg");

            assert!(only_downloads(&setup).is_err(), "{status} {body:?}");
        }
    }

    #[test]
    fn a_redirect_and_a_failed_request_are_handed_over() {
        let mut answers = answers(&calm());

        answers.insert(
            "/downloads/pkg".to_owned(),
            (302, String::new(), vec![("location".to_owned(), "/elsewhere".to_owned())]),
        );

        let registry = Registry::start(answers);

        assert!(only_downloads(&setup(Some(&registry))).is_err());

        // Nothing listens at the downloads address: a port that was free a moment ago.
        let (_registry, mut setup) = with_downloads(None, "pkg");
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();

        setup.context.services.downloads = format!("http://127.0.0.1:{closed}/downloads");
        assert!(only_downloads(&setup).unwrap_err().contains("the downloads request failed"));

        // An address `fetch` and the client may read differently.
        setup.context.services.downloads = "http://127.0.0.1:80/downloads".to_owned();
        assert!(only_downloads(&setup).unwrap_err().contains("not a URL"));
    }

    #[test]
    fn a_fresh_entry_answers_without_a_request() {
        let (registry, setup) = with_downloads(None, "pkg");
        let file = setup.home.join(".vis/cache/downloads/pkg.json");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, entry(7).replace(&NOW.to_string(), &(NOW - 86_400_000).to_string())).unwrap();

        let plan = only_downloads(&setup).unwrap();

        assert!(plan.stdout.contains("Only 7 downloads in the past month."));
        assert!(plan.cache.iter().all(|action| !matches!(action, CacheAction::Write { file, .. } if file.to_string_lossy().contains("/downloads/"))));
        assert_eq!(registry.requests.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_stale_entry_is_removed_and_asked_again() {
        let (registry, setup) = with_downloads(Some((200, "{\"downloads\":50000}")), "pkg");
        let file = setup.home.join(".vis/cache/downloads/pkg.json");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, entry(7).replace(&NOW.to_string(), &(NOW - 86_400_001).to_string())).unwrap();

        let plan = only_downloads(&setup).unwrap();

        assert!(plan.stdout.contains("\"findings\": []"));
        assert_eq!(registry.requests.load(Ordering::SeqCst), 2);
        assert!(plan.cache.contains(&CacheAction::Remove(file.clone())));
        assert_eq!(writes(&plan), [entry(50_000)]);

        // When the API then has nothing, the stale file is still gone.
        let (_registry, setup) = with_downloads(Some((404, "{}")), "pkg");
        let file = setup.home.join(".vis/cache/downloads/pkg.json");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, entry(7).replace(&NOW.to_string(), "1")).unwrap();

        let plan = only_downloads(&setup).unwrap();

        assert!(plan.cache.contains(&CacheAction::Remove(file)) && writes(&plan).is_empty());
    }

    #[test]
    fn an_entry_that_is_not_a_count_is_handed_over() {
        for text in [
            "{\"downloads\":\"7\",\"createdAt\":1,\"ttlMs\":9999999999999}",
            "{\"createdAt\":1,\"ttlMs\":9999999999999}",
            "garbage",
        ] {
            let (_registry, setup) = with_downloads(None, "pkg");
            let file = setup.home.join(".vis/cache/downloads/pkg.json");

            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, text).unwrap();
            assert!(only_downloads(&setup).is_err(), "{text}");
        }
    }

    #[test]
    fn the_findings_follow_the_order_of_the_handler() {
        let (_registry, setup) = with_downloads(Some((200, "{\"downloads\":5}")), "pkg");
        let run = [Marshall::Author, Marshall::Downloads];
        let plan = plan(&flags(&["pkg", "--json"]), &run, &setup.context, &client()).unwrap();
        let report: Value = serde_json::from_str(&plan.stdout).unwrap();

        assert_eq!(messages(&report, "errors"), ["[downloads] Only 5 downloads in the past month."]);
        assert_eq!(plan.status, 1);
    }
}

mod archived_repo_marshall {
    use super::*;

    fn with_github(answer: Option<(u16, &str)>) -> (Registry, Setup) {
        let mut answers = answers(&calm());

        if let Some((status, body)) = answer {
            answers.insert("/github/o/r".to_owned(), (status, body.to_owned(), Vec::new()));
        }

        let registry = Registry::start(answers);
        let setup = setup(Some(&registry));

        (registry, setup)
    }

    fn only_archived(setup: &Setup) -> Result<Plan, String> {
        plan(&flags(&["pkg", "--json"]), &[Marshall::ArchivedRepo], &setup.context, &client())
    }

    fn writes(plan: &Plan) -> Vec<String> {
        plan.cache
            .iter()
            .filter_map(|action| match action {
                CacheAction::Write { file, text } if file.to_string_lossy().contains("/archived-repo/") => {
                    Some(text.clone())
                }
                _ => None,
            })
            .collect()
    }

    fn warnings_of(plan: &Plan) -> Vec<String> {
        messages(&serde_json::from_str::<Value>(&plan.stdout).unwrap(), "warnings")
    }

    #[test]
    fn an_archived_repository_is_a_warning_and_is_cached() {
        for (body, message, cached) in [
            (
                r#"{"archived":true,"archived_at":"2024-01-02T03:04:05Z"}"#,
                "[archivedRepo] Source repo o/r is archived (since 2024-01-02T03:04:05Z).",
                format!(
                    r#"{{"createdAt":{NOW},"ttlMs":86400000,"archived":true,"archivedAt":"2024-01-02T03:04:05Z"}}"#
                ),
            ),
            (
                r#"{"archived":true,"archived_at":null}"#,
                "[archivedRepo] Source repo o/r is archived.",
                format!(r#"{{"createdAt":{NOW},"ttlMs":86400000,"archived":true}}"#),
            ),
            (
                r#"{"archived":true}"#,
                "[archivedRepo] Source repo o/r is archived.",
                format!(r#"{{"createdAt":{NOW},"ttlMs":86400000,"archived":true}}"#),
            ),
        ] {
            let (registry, setup) = with_github(Some((200, body)));
            let plan = only_archived(&setup).unwrap();

            assert_eq!(warnings_of(&plan), [message], "{body}");
            assert_eq!(writes(&plan), [cached], "{body}");
            // A warning alone does not fail the run.
            assert_eq!(plan.status, 0);
            assert_eq!(registry.requests.load(Ordering::SeqCst), 2);
        }
    }

    #[test]
    fn a_repository_that_is_not_archived_is_no_finding_and_is_cached() {
        for (body, cached) in [
            (r#"{"archived":false}"#, r#"{"archived":false}"#),
            (r#"{"archived":"yes"}"#, r#"{"archived":false}"#),
            ("{}", r#"{"archived":false}"#),
            ("[]", r#"{"archived":false}"#),
            ("7", r#"{"archived":false}"#),
            // `archived_at` is read whether or not the repository is archived.
            (r#"{"archived":false,"archived_at":"x"}"#, r#"{"archived":false,"archivedAt":"x"}"#),
        ] {
            let (_registry, setup) = with_github(Some((200, body)));
            let plan = only_archived(&setup).unwrap();

            assert!(plan.stdout.contains("\"findings\": []"), "{body}");
            assert_eq!(writes(&plan), [format!(r#"{{"createdAt":{NOW},"ttlMs":86400000,{}"#, &cached[1..])], "{body}");
        }
    }

    #[test]
    fn a_missing_repository_is_a_warning_and_is_cached() {
        let (_registry, setup) = with_github(Some((404, "{\"message\":\"Not Found\"}")));
        let plan = only_archived(&setup).unwrap();

        assert_eq!(warnings_of(&plan), ["[archivedRepo] Source repo o/r returned 404 from GitHub."]);
        assert_eq!(
            writes(&plan),
            [format!(r#"{{"createdAt":{NOW},"ttlMs":86400000,"archived":false,"missing":true}}"#)]
        );
    }

    #[test]
    fn a_rate_limit_a_server_error_and_a_null_body_are_no_finding_and_nothing_is_cached() {
        for (status, body) in [(403, "{}"), (429, "{}"), (500, "oops"), (304, ""), (200, "null")] {
            let (_registry, setup) = with_github(Some((status, body)));
            let plan = only_archived(&setup).unwrap();

            assert!(plan.stdout.contains("\"findings\": []"), "{status}");
            assert!(writes(&plan).is_empty(), "{status}");
            assert_eq!(plan.status, 0);
        }
    }

    #[test]
    fn the_request_carries_the_headers_node_sends() {
        let (registry, setup) = with_github(Some((200, "{}")));

        only_archived(&setup).unwrap();

        let head = registry.paths.lock().unwrap()[1].to_ascii_lowercase();

        assert!(head.starts_with("get /github/o/r http/1.1"), "{head}");
        assert!(head.contains("accept: application/vnd.github+json"), "{head}");
        assert!(head.contains("user-agent: visulima-vis-marshall\r\n"), "{head}");
        assert!(!head.contains("authorization"));

        let (registry, mut setup) = with_github(Some((200, "{}")));

        setup.context.services.github_token = Some("ghp_Token-1".into());
        only_archived(&setup).unwrap();
        assert!(registry.paths.lock().unwrap()[1].contains("authorization: Bearer ghp_Token-1\r\n"));

        // An empty token is no token.
        let (registry, mut setup) = with_github(Some((200, "{}")));

        setup.context.services.github_token = Some("".into());
        only_archived(&setup).unwrap();
        assert!(!registry.paths.lock().unwrap()[1].to_ascii_lowercase().contains("authorization"));
    }

    #[test]
    fn what_node_may_read_differently_is_handed_over() {
        for (status, body) in [(200, "<html></html>"), (200, ""), (200, "\u{feff}{}")] {
            let (_registry, setup) = with_github(Some((status, body)));

            assert!(only_archived(&setup).is_err(), "{status} {body:?}");
        }

        // A redirect (a renamed repository).
        let mut answers = answers(&calm());

        answers.insert(
            "/github/o/r".to_owned(),
            (301, String::new(), vec![("location".to_owned(), "/github/o/s".to_owned())]),
        );

        let registry = Registry::start(answers);

        assert!(only_archived(&setup(Some(&registry))).is_err());

        // A request that never gets an answer.
        let (_registry, mut setup) = with_github(None);
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();

        setup.context.services.github = format!("http://127.0.0.1:{closed}/github");
        assert!(only_archived(&setup).unwrap_err().contains("the GitHub request failed"));

        // A token and an address that `fetch` may read differently.
        setup.context.services.github_token = Some("a b".into());
        assert!(only_archived(&setup).is_err());
        setup.context.services.github = "http://127.0.0.1:80/github".to_owned();
        assert!(only_archived(&setup).unwrap_err().contains("not a URL"));
    }

    #[test]
    fn a_fresh_entry_answers_without_a_request() {
        let (registry, setup) = with_github(None);
        let file = setup.home.join(".vis/cache/archived-repo/o__r.json");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(
            &file,
            format!(r#"{{"createdAt":{},"ttlMs":86400000,"archived":true,"archivedAt":"then"}}"#, NOW - 86_400_000),
        )
        .unwrap();

        let plan = only_archived(&setup).unwrap();

        assert_eq!(warnings_of(&plan), ["[archivedRepo] Source repo o/r is archived (since then)."]);
        assert!(writes(&plan).is_empty());
        assert_eq!(registry.requests.load(Ordering::SeqCst), 1);

        fs::write(&file, format!(r#"{{"createdAt":{NOW},"ttlMs":86400000,"archived":false,"missing":true}}"#)).unwrap();

        assert_eq!(
            warnings_of(&only_archived(&setup).unwrap()),
            ["[archivedRepo] Source repo o/r returned 404 from GitHub."]
        );

        // `missing` that is not `true` is read as a repository that exists.
        fs::write(&file, format!(r#"{{"createdAt":{NOW},"ttlMs":86400000,"archived":false,"missing":false}}"#))
            .unwrap();
        assert!(only_archived(&setup).unwrap().stdout.contains("\"findings\": []"));
        // The packument is asked for by every run, as nothing commits its cache here; the repository never is.
        assert_eq!(registry.requests.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_stale_entry_is_removed_and_asked_again() {
        let (registry, setup) = with_github(Some((200, r#"{"archived":false}"#)));
        let file = setup.home.join(".vis/cache/archived-repo/o__r.json");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, r#"{"createdAt":1,"ttlMs":86400000,"archived":true}"#).unwrap();

        let plan = only_archived(&setup).unwrap();

        assert!(plan.stdout.contains("\"findings\": []"));
        assert!(plan.cache.contains(&CacheAction::Remove(file.clone())));
        assert_eq!(writes(&plan), [format!(r#"{{"createdAt":{NOW},"ttlMs":86400000,"archived":false}}"#)]);
        assert_eq!(registry.requests.load(Ordering::SeqCst), 2);

        // When GitHub then limits the rate, the stale file is still gone and nothing replaces it.
        let (_registry, setup) = with_github(Some((403, "{}")));
        let file = setup.home.join(".vis/cache/archived-repo/o__r.json");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, r#"{"createdAt":1,"ttlMs":5,"archived":true}"#).unwrap();

        let plan = only_archived(&setup).unwrap();

        assert!(plan.cache.contains(&CacheAction::Remove(file)) && writes(&plan).is_empty());
    }

    #[test]
    fn an_entry_that_is_not_what_node_writes_is_handed_over() {
        for text in ["garbage", "{}", r#"{"createdAt":1,"ttlMs":9999999999999,"archived":true,"archivedAt":5}"#] {
            let (_registry, setup) = with_github(None);
            let file = setup.home.join(".vis/cache/archived-repo/o__r.json");

            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, text).unwrap();
            assert!(only_archived(&setup).is_err(), "{text}");
        }
    }

    #[test]
    fn a_repository_that_is_not_on_github_is_skipped() {
        let other = |url: Value| {
            let mut package = calm();

            package["versions"]["1.2.0"]["repository"] = url;

            let registry = Registry::start(answers(&package));
            let setup = setup(Some(&registry));

            (registry, setup)
        };

        for url in [
            json!({ "url": "https://gitlab.com/o/r" }),
            json!("o/r"),
            json!({ "type": "git" }),
            json!({ "url": 5 }),
            json!(["https://github.com/o/r"]),
            json!(null),
            json!({ "url": "  " }),
        ] {
            let (registry, setup) = other(url.clone());
            let plan = only_archived(&setup).unwrap();

            assert!(plan.stdout.contains("\"findings\": []"), "{url}");
            assert!(plan.cache.iter().all(|action| !matches!(action, CacheAction::Write { file, .. } if file.to_string_lossy().contains("archived"))));
            assert_eq!(registry.requests.load(Ordering::SeqCst), 1, "{url}");
        }

        // A name the URL would rewrite is Node's.
        let (_registry, setup) = other(json!({ "url": "https://github.com/o/r%20x" }));

        assert!(only_archived(&setup).is_err());
    }

    #[test]
    fn the_last_entry_stands_in_for_a_version_that_is_not_there() {
        // `dist-tags.latest` names a version the packument does not hold: `versions[version]` is missing, and the
        // marshall reads the last version's repository instead.
        let mut package = calm();

        package["dist-tags"]["latest"] = json!("9.9.9");
        package["versions"]["1.2.0"]["repository"] = json!({ "url": "https://github.com/last/one" });

        let mut answers = answers(&package);

        answers.insert("/github/last/one".to_owned(), (200, r#"{"archived":true}"#.to_owned(), Vec::new()));

        let registry = Registry::start(answers);
        let setup = setup(Some(&registry));
        let plan = plan(&flags(&["pkg", "--json"]), &[Marshall::ArchivedRepo], &setup.context, &client()).unwrap();

        assert_eq!(warnings_of(&plan), ["[archivedRepo] Source repo last/one is archived."]);
    }

    #[test]
    fn the_findings_follow_the_order_of_the_handler() {
        let mut answers = answers(&calm());

        answers.insert("/github/o/r".to_owned(), (404, "{}".to_owned(), Vec::new()));
        answers.insert("/downloads/pkg".to_owned(), (200, "{\"downloads\":5}".to_owned(), Vec::new()));

        let registry = Registry::start(answers);
        let setup = setup(Some(&registry));
        let run = [Marshall::Downloads, Marshall::ArchivedRepo];
        let plan = plan(&flags(&["pkg", "--json"]), &run, &setup.context, &client()).unwrap();
        let report: Value = serde_json::from_str(&plan.stdout).unwrap();

        assert_eq!(
            messages(&report, "findings"),
            [
                "[downloads] Only 5 downloads in the past month.",
                "[archivedRepo] Source repo o/r returned 404 from GitHub."
            ]
        );
        assert_eq!(plan.status, 1);
    }
}

mod signatures_marshall {
    use super::signatures::fixtures::TestKey;
    use super::*;

    const KEYID: &str = "SHA256:test-key";
    const INTEGRITY: &str = "sha512-abc";

    /// A package whose only version carries `dist`.
    fn package(dist: &Value) -> Value {
        packument(&json!({ "1.0.0": entry("amy", &json!({ "dist": dist })) }), &json!({ "1.0.0": ago(100.0) }))
    }

    fn signed(key: &TestKey, keyid: &str) -> Value {
        json!({ "integrity": INTEGRITY, "signatures": [{ "keyid": keyid, "sig": key.sign(&format!("pkg@1.0.0:{INTEGRITY}")) }] })
    }

    fn registry_key(key: &TestKey, keyid: &str, extra: &Value) -> Value {
        let mut found = json!({ "keyid": keyid, "keytype": "ecdsa-sha2-nistp256", "scheme": "ecdsa-sha2-nistp256", "key": key.spki_base64() });

        for (name, value) in extra.as_object().unwrap() {
            found[name] = value.clone();
        }

        found
    }

    type Reply = (u16, String, Vec<(String, String)>);

    fn keys_answer(keys: &[Value]) -> Reply {
        ok(&json!({ "keys": keys }))
    }

    fn world(package: &Value, keys: Option<Reply>) -> (Registry, Setup) {
        let mut answers = answers(package);

        if let Some(answer) = keys {
            answers.insert("/keys".to_owned(), answer);
        }

        let registry = Registry::start(answers);
        let setup = setup(Some(&registry));

        (registry, setup)
    }

    fn only_signatures(setup: &Setup) -> Result<Plan, String> {
        plan(&flags(&["pkg", "--json"]), &[Marshall::Signatures], &setup.context, &client())
    }

    fn findings_of(plan: &Plan) -> Vec<String> {
        messages(&serde_json::from_str::<Value>(&plan.stdout).unwrap(), "findings")
    }

    fn key_writes(plan: &Plan) -> Vec<String> {
        plan.cache
            .iter()
            .filter_map(|action| match action {
                CacheAction::Write { file, text } if file.to_string_lossy().contains("registry-keys") => {
                    Some(text.clone())
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_signature_that_verifies_is_no_finding_and_the_keys_are_cached_as_node_caches_them() {
        let key = TestKey::new();
        let keys = [registry_key(&key, KEYID, &json!({}))];
        let (registry, setup) = world(&package(&signed(&key, KEYID)), Some(keys_answer(&keys)));
        let plan = only_signatures(&setup).unwrap();

        assert!(plan.stdout.contains("\"findings\": []"));
        assert_eq!(plan.status, 0);
        assert_eq!(
            key_writes(&plan),
            [format!("{{\"createdAt\":{NOW},\"keys\":{},\"ttlMs\":86400000}}", serde_json::to_string(&keys).unwrap())]
        );
        assert!(registry.paths.lock().unwrap()[1].to_ascii_lowercase().contains("accept: application/json"));
    }

    #[test]
    fn a_missing_signature_or_integrity_is_a_warning() {
        let key = TestKey::new();
        let keys = [registry_key(&key, KEYID, &json!({}))];

        for (dist, message) in [
            (json!({}), "[signatures] Package pkg@1.0.0 has no dist.signatures from the registry."),
            (json!({ "signatures": [] }), "[signatures] Package pkg@1.0.0 has no dist.signatures from the registry."),
            (
                json!({ "signatures": [{ "keyid": KEYID, "sig": "x" }] }),
                "[signatures] Package pkg@1.0.0 has signatures but no dist.integrity to verify against.",
            ),
            (
                json!({ "integrity": "", "signatures": [{ "keyid": KEYID, "sig": "x" }] }),
                "[signatures] Package pkg@1.0.0 has signatures but no dist.integrity to verify against.",
            ),
        ] {
            let (_registry, setup) = world(&package(&dist), Some(keys_answer(&keys)));
            let plan = only_signatures(&setup).unwrap();

            assert_eq!(findings_of(&plan), [message], "{dist}");
            assert_eq!((plan.status, key_writes(&plan).len()), (0, 1));
        }
    }

    #[test]
    fn an_unknown_keyid_is_an_error_and_an_expired_key_a_warning() {
        let key = TestKey::new();
        let keys = [
            registry_key(&key, KEYID, &json!({})),
            registry_key(&key, "SHA256:old", &json!({ "expires": "2020-01-01T00:00:00.000Z" })),
            registry_key(&key, "SHA256:later", &json!({ "expires": "2999-01-01T00:00:00.000Z" })),
            registry_key(&key, "SHA256:blank", &json!({ "expires": "" })),
        ];
        let sig = key.sign(&format!("pkg@1.0.0:{INTEGRITY}"));
        let two = |first: &str, second: &str| {
            package(
                &json!({ "integrity": INTEGRITY, "signatures": [{ "keyid": first, "sig": sig }, { "keyid": second, "sig": sig }] }),
            )
        };

        let (_registry, setup) = world(&two("SHA256:unlisted", KEYID), Some(keys_answer(&keys)));
        let plan = only_signatures(&setup).unwrap();

        assert_eq!(
            findings_of(&plan),
            ["[signatures] Package pkg@1.0.0 was signed with an unrecognized keyid (SHA256:unlisted)."]
        );
        assert_eq!(plan.status, 1);

        let (_registry, setup) = world(&two("SHA256:old", "SHA256:later"), Some(keys_answer(&keys)));
        let plan = only_signatures(&setup).unwrap();

        assert_eq!(
            findings_of(&plan),
            ["[signatures] Package pkg@1.0.0 was signed with an expired key (SHA256:old, expired 2020-01-01T00:00:00.000Z)."]
        );
        assert_eq!(plan.status, 0);

        // The blank `expires` never expires and the signature is checked.
        let (_registry, setup) = world(&two("SHA256:blank", "SHA256:later"), Some(keys_answer(&keys)));

        assert!(findings_of(&only_signatures(&setup).unwrap()).is_empty());
    }

    #[test]
    fn a_signature_that_does_not_verify_here_is_handed_to_node() {
        let (key, other) = (TestKey::new(), TestKey::new());
        let keys = [registry_key(&key, KEYID, &json!({}))];

        for dist in [
            signed(&other, KEYID),
            json!({ "integrity": "sha512-different", "signatures": signed(&key, KEYID)["signatures"] }),
            json!({ "integrity": INTEGRITY, "signatures": [{ "keyid": KEYID, "sig": "not base64!" }] }),
            json!({ "integrity": INTEGRITY, "signatures": [{ "keyid": KEYID }] }),
        ] {
            let (_registry, setup) = world(&package(&dist), Some(keys_answer(&keys)));

            assert!(only_signatures(&setup).unwrap_err().contains("does not verify here"), "{dist}");
        }

        // A key that is not P-256 SPKI.
        let odd = [json!({ "keyid": KEYID, "key": "AAAA" })];
        let (_registry, setup) = world(&package(&signed(&key, KEYID)), Some(keys_answer(&odd)));

        assert!(only_signatures(&setup).is_err());
    }

    #[test]
    fn a_keys_request_that_is_refused_falls_back_to_the_old_keys_or_reports_it() {
        let key = TestKey::new();
        let package = package(&signed(&key, KEYID));

        // No keys: `fetch-failed` for the package, whatever its signatures say.
        for status in [404, 500, 429] {
            let (_registry, setup) = world(&package, Some((status, "{}".to_owned(), Vec::new())));
            let plan = only_signatures(&setup).unwrap();

            assert_eq!(findings_of(&plan), ["[signatures] Could not fetch registry signing keys."]);
            assert_eq!((plan.status, key_writes(&plan).len()), (0, 0));
        }

        // Old keys: used, and nothing is written.
        let (_registry, setup) = world(&package, Some((500, "{}".to_owned(), Vec::new())));
        let file = setup.home.join(".vis/cache/registry-keys/npmjs.json");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(
            &file,
            format!("{{\"createdAt\":1,\"keys\":{},\"ttlMs\":5}}", json!([registry_key(&key, KEYID, &json!({}))])),
        )
        .unwrap();

        let plan = only_signatures(&setup).unwrap();

        assert!(plan.stdout.contains("\"findings\": []") && key_writes(&plan).is_empty());

        // An old file and a good answer: the answer replaces it.
        let (_registry, setup) = world(&package, Some(keys_answer(&[registry_key(&key, KEYID, &json!({}))])));
        let file = setup.home.join(".vis/cache/registry-keys/npmjs.json");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{\"createdAt\":1,\"keys\":[],\"ttlMs\":5}").unwrap();
        assert_eq!(key_writes(&only_signatures(&setup).unwrap()).len(), 1);
    }

    #[test]
    fn fresh_keys_are_read_without_a_request() {
        let key = TestKey::new();
        let (registry, setup) = world(&package(&signed(&key, KEYID)), None);
        let file = setup.home.join(".vis/cache/registry-keys/npmjs.json");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(
            &file,
            format!(
                "{{\"createdAt\":{},\"keys\":{},\"ttlMs\":86400000}}",
                NOW - 1000,
                json!([registry_key(&key, KEYID, &json!({}))])
            ),
        )
        .unwrap();

        let plan = only_signatures(&setup).unwrap();

        assert!(plan.stdout.contains("\"findings\": []") && key_writes(&plan).is_empty());
        assert_eq!(registry.requests.load(Ordering::SeqCst), 1);

        for odd in [
            "garbage",
            "[]",
            "{}",
            "{\"createdAt\":1,\"ttlMs\":9,\"keys\":{}}",
            "{\"createdAt\":\"1\",\"ttlMs\":9,\"keys\":[]}",
        ] {
            fs::write(&file, odd).unwrap();
            assert!(only_signatures(&setup).is_err(), "{odd}");
        }
    }

    #[test]
    fn an_answer_that_has_no_keys_array_means_no_keys() {
        let key = TestKey::new();

        for body in ["{}", r#"{"keys":"x"}"#, r#"{"keys":null}"#, r#"{"keys":[]}"#] {
            let (_registry, setup) = world(&package(&signed(&key, KEYID)), Some((200, body.to_owned(), Vec::new())));
            let plan = only_signatures(&setup).unwrap();

            assert_eq!(
                findings_of(&plan),
                ["[signatures] Package pkg@1.0.0 was signed with an unrecognized keyid (SHA256:test-key)."],
                "{body}"
            );
            assert_eq!(key_writes(&plan), [format!("{{\"createdAt\":{NOW},\"keys\":[],\"ttlMs\":86400000}}")]);
        }
    }

    #[test]
    fn what_node_may_read_differently_is_handed_over() {
        let key = TestKey::new();
        let package = package(&signed(&key, KEYID));

        for (status, body) in [
            (200, "<html></html>"),
            (200, ""),
            (200, "[]"),
            (200, "null"),
            (200, "\u{feff}{}"),
            (200, r#"{"keys":[],"keys":[]}"#),
        ] {
            let (_registry, setup) = world(&package, Some((status, body.to_owned(), Vec::new())));

            assert!(only_signatures(&setup).is_err(), "{body:?}");
        }

        // A redirect, and an expiry or keyid this module does not read the way `Date.parse` and `Map` do.
        let (_registry, setup) =
            world(&package, Some((301, String::new(), vec![("location".to_owned(), "/other".to_owned())])));

        assert!(only_signatures(&setup).is_err());

        for odd in
            [json!({ "keyid": KEYID, "key": key.spki_base64(), "expires": "2999" }), json!({ "keyid": 5 }), json!(null)]
        {
            let (_registry, setup) = world(&package, Some(keys_answer(std::slice::from_ref(&odd))));

            assert!(only_signatures(&setup).is_err(), "{odd}");
        }

        // A bad address, and no address at all.
        let (_registry, mut setup) = world(&package, None);
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();

        setup.context.services.keys = Some(format!("http://127.0.0.1:{closed}/keys"));
        assert!(only_signatures(&setup).unwrap_err().contains("the keys request failed"));
        setup.context.services.keys = Some("http://127.0.0.1:80/keys".to_owned());
        assert!(only_signatures(&setup).unwrap_err().contains("not a URL"));
        setup.context.services.keys = None;
        assert!(only_signatures(&setup).unwrap_err().contains("not text"));
    }

    #[test]
    fn signatures_are_checked_in_the_order_of_the_handler() {
        let key = TestKey::new();
        let package =
            package(&json!({ "integrity": INTEGRITY, "signatures": [{ "keyid": "SHA256:unlisted", "sig": "x" }] }));
        let (_registry, setup) = world(&package, Some(keys_answer(&[registry_key(&key, KEYID, &json!({}))])));
        let run = [Marshall::Signatures, Marshall::ArchivedRepo];
        let plan = plan(&flags(&["pkg", "--json"]), &run, &setup.context, &client()).unwrap();

        // The signature finding comes first; the repository answers 404, a warning after it.
        let found = findings_of(&plan);

        assert!(
            found[0].starts_with("[signatures]") && found.len() == 2 && found[1].starts_with("[archivedRepo]"),
            "{found:?}"
        );
    }
}

mod expired_domains_marshall {
    use std::net::UdpSocket;
    use std::time::Duration;

    use super::expired_domains::{Outcome, Resolver};
    use super::*;

    /// Every answer of a resolver the marshall classifies, with what Node's own resolver makes of it and what this
    /// binary does (`__tests__/native/inspect-dns.test.ts` runs the same file against Node's `Resolver`).
    const SCENARIOS: &str = include_str!("../../tests/fixtures/dns-scenarios.json");

    fn name_wire(name: &str) -> Vec<u8> {
        let mut out: Vec<u8> =
            name.split('.').flat_map(|label| [&[label.len() as u8][..], label.as_bytes()].concat()).collect();

        out.push(0);
        out
    }

    fn record(entry: &Value) -> Vec<u8> {
        let (kind, data) = match entry["type"].as_str().unwrap() {
            "NS" => (2_u16, name_wire(entry["target"].as_str().unwrap())),
            "CNAME" => (5, name_wire(entry["target"].as_str().unwrap())),
            _ => (1, entry["address"].as_array().unwrap().iter().map(|byte| byte.as_u64().unwrap() as u8).collect()),
        };
        let mut out = vec![0xc0, 0x0c];

        out.extend_from_slice(&kind.to_be_bytes());
        out.extend_from_slice(&[0, 1, 0, 0, 1, 44]);
        out.extend_from_slice(&(data.len() as u16).to_be_bytes());
        out.extend_from_slice(&data);
        out
    }

    /// The answer a scenario gives to `query`, or none.
    fn reply(query: &[u8], scenario: &Value) -> Option<Vec<u8>> {
        if scenario["silent"].as_bool() == Some(true) {
            return None;
        }

        let mut end = 12;

        while query[end] != 0 {
            end += usize::from(query[end]) + 1;
        }

        end += 5;

        let list = |key: &str| scenario[key].as_array().cloned().unwrap_or_default();
        let (answers, authority) = (list("answers"), list("authority"));
        let flags = 0x8180_u16
            | if scenario["tc"].as_bool() == Some(true) { 0x0200 } else { 0 }
            | scenario["rcode"].as_u64().unwrap() as u16;
        let mut out = query[..2].to_vec();

        out.extend_from_slice(&flags.to_be_bytes());
        out.extend_from_slice(&[0, 1]);
        out.extend_from_slice(&(answers.len() as u16).to_be_bytes());
        out.extend_from_slice(&(authority.len() as u16).to_be_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&query[12..end]);

        for entry in answers.iter().chain(&authority) {
            out.extend(record(entry));
        }

        Some(out)
    }

    struct Dns {
        address: std::net::SocketAddr,
        queries: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl Dns {
        /// A resolver on 127.0.0.1 that answers each query with what `scenario_for` returns for its domain.
        fn start(scenario_for: impl Fn(&str) -> Value + Send + 'static) -> Self {
            let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
            let address = socket.local_addr().unwrap();
            let queries = Arc::new(Mutex::new(Vec::new()));
            let seen = Arc::clone(&queries);

            thread::spawn(move || {
                let mut buffer = [0_u8; 512];

                while let Ok((length, from)) = socket.recv_from(&mut buffer) {
                    let query = buffer[..length].to_vec();
                    let mut at = 12;
                    let mut labels = Vec::new();

                    while query[at] != 0 {
                        labels.push(
                            String::from_utf8_lossy(&query[at + 1..at + 1 + usize::from(query[at])]).into_owned(),
                        );
                        at += usize::from(query[at]) + 1;
                    }

                    seen.lock().unwrap().push(query.clone());

                    if let Some(answer) = reply(&query, &scenario_for(&labels.join("."))) {
                        // An answer with another id first, which a resolver ignores.
                        let mut stray = answer.clone();

                        stray[0] ^= 0xff;
                        drop(socket.send_to(&stray, from));
                        drop(socket.send_to(&answer, from));
                    }
                }
            });

            Self { address, queries }
        }

        fn resolver(&self) -> Resolver {
            Resolver { servers: vec![self.address], wait: Duration::from_millis(400), declined: None }
        }
    }

    fn scenarios() -> Vec<Value> {
        serde_json::from_str(SCENARIOS).unwrap()
    }

    #[test]
    fn each_answer_is_read_the_way_nodes_resolver_reads_it() {
        for scenario in scenarios() {
            let chosen = scenario.clone();
            let dns = Dns::start(move |_| chosen.clone());
            let found = dns.resolver().lookup("example.test");
            let name = scenario["name"].as_str().unwrap();

            if scenario["native"].as_str() == Some("decline") {
                assert!(found.is_err(), "{name}: {found:?}");
            } else {
                let expected = if scenario["expected"] == "registered" { Outcome::Registered } else { Outcome::Lapsed };

                assert_eq!(found, Ok(expected), "{name}");
            }
        }
    }

    #[test]
    fn the_query_is_the_one_nodes_resolver_sends() {
        let dns = Dns::start(|_| json!({ "rcode": 3, "answers": [] }));

        dns.resolver().lookup("example.com").unwrap();

        let queries = dns.queries.lock().unwrap();
        let query = &queries[0];

        // c-ares: recursion desired, one question, no other section and no EDNS, 29 bytes for `example.com`.
        assert_eq!((query.len(), &query[2..12]), (29, &[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0][..]));
        assert_eq!(&query[12..], [7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 3, b'c', b'o', b'm', 0, 0, 2, 0, 1]);
    }

    #[test]
    fn a_domain_that_is_not_a_plain_name_is_not_asked() {
        let dns = Dns::start(|_| json!({ "rcode": 3, "answers": [] }));

        for odd in ["localhost", "a b.example", "a..example", "-a.example", "x.example."] {
            assert!(dns.resolver().lookup(odd).is_err(), "{odd}");
        }

        assert!(dns.queries.lock().unwrap().is_empty());
    }

    /// A package whose version has these maintainers.
    fn package_of(user: Value, maintainers: &Value) -> Value {
        packument(
            &json!({ "1.0.0": { "_npmUser": user, "maintainers": maintainers, "license": "MIT", "readme": "# r", "repository": { "url": "git+https://github.com/o/r.git" } } }),
            &json!({ "1.0.0": ago(100.0) }),
        )
    }

    fn run_with(package: &Value, dns: &Dns) -> (Result<Plan, String>, Setup) {
        let registry = Registry::start(answers(package));
        let mut setup = setup(Some(&registry));

        setup.context.services.dns = dns.resolver();

        let plan = plan(&flags(&["pkg", "--json"]), &[Marshall::ExpiredDomains], &setup.context, &client());

        (plan, setup)
    }

    fn domain_writes(plan: &Plan) -> Vec<String> {
        plan.cache
            .iter()
            .filter_map(|action| match action {
                CacheAction::Write { file, text } if file.to_string_lossy().contains("/expired-domains/") => {
                    Some(text.clone())
                }
                _ => None,
            })
            .collect()
    }

    fn scenario_named(name: &str) -> Value {
        scenarios().into_iter().find(|scenario| scenario["name"] == name).unwrap()
    }

    #[test]
    fn a_lapsed_domain_is_an_error_for_each_address_and_asked_once() {
        let (nx, ok) = (scenario_named("nxdomain"), scenario_named("ns records"));
        let dns = Dns::start(move |domain| if domain == "gone.test" { nx.clone() } else { ok.clone() });
        let package = package_of(
            json!({ "name": "amy", "email": "Amy@Gone.test" }),
            &json!([
                { "name": "amy", "email": "Amy@Gone.test" },
                { "name": "bob", "email": "bob@gone.test" },
                { "name": "cat", "email": "cat@fine.test" },
                { "name": "dan" },
                "not an object",
                { "email": 5 },
            ]),
        );
        let (plan, _setup) = run_with(&package, &dns);
        let plan = plan.unwrap();
        let report: Value = serde_json::from_str(&plan.stdout).unwrap();

        // `Amy@Gone.test` once (the same address twice), `bob@gone.test` once; `fine.test` is registered.
        assert_eq!(
            messages(&report, "errors"),
            [
                "[expiredDomains] Maintainer email domain gone.test (Amy@Gone.test) is unregistered \u{2014} potential hijack risk.",
                "[expiredDomains] Maintainer email domain gone.test (bob@gone.test) is unregistered \u{2014} potential hijack risk.",
            ]
        );
        assert_eq!(plan.status, 1);
        // One query per domain, one cache entry per domain, in the bytes Node writes.
        assert_eq!(dns.queries.lock().unwrap().len(), 2);
        assert_eq!(
            domain_writes(&plan),
            [
                format!("{{\"createdAt\":{NOW},\"outcome\":\"expired\",\"ttlMs\":86400000}}"),
                format!("{{\"createdAt\":{NOW},\"outcome\":\"ok\",\"ttlMs\":86400000}}"),
            ]
        );
    }

    fn plan_again(setup: &Setup) -> Result<Plan, String> {
        plan(&flags(&["pkg", "--json"]), &[Marshall::ExpiredDomains], &setup.context, &client())
    }

    #[test]
    fn fresh_entries_answer_without_a_query() {
        let dns = Dns::start(|_| scenario_named("ns records"));
        let package = package_of(json!({ "name": "amy", "email": "amy@cached.test" }), &json!([]));
        let (_plan, setup) = run_with(&package, &dns);
        let file = super::expired_domains::cache_file(&setup.context.cache_dir, "cached.test");

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        dns.queries.lock().unwrap().clear();

        // `expired`, and anything that is not `ok`, reads as lapsed; `ok` as registered.
        for (text, finds) in [
            (format!("{{\"createdAt\":{NOW},\"outcome\":\"expired\",\"ttlMs\":86400000}}"), true),
            (format!("{{\"createdAt\":{NOW},\"ttlMs\":86400000}}"), true),
            (format!("{{\"createdAt\":{NOW},\"outcome\":5,\"ttlMs\":86400000}}"), true),
            (format!("{{\"createdAt\":{NOW},\"outcome\":\"ok\",\"ttlMs\":86400000}}"), false),
        ] {
            fs::write(&file, &text).unwrap();

            // The registry stub of `run_with` is gone with its `Registry`; a fresh one serves the packument.
            let registry = Registry::start(answers(&package));
            let mut again = setup_with(&registry, &setup);

            again.context.services.dns = dns.resolver();

            let plan = plan_again(&again).unwrap();
            let report: Value = serde_json::from_str(&plan.stdout).unwrap();

            assert_eq!(report["findings"].as_array().unwrap().len(), usize::from(finds), "{text}");
            assert!(domain_writes(&plan).is_empty());
            assert!(dns.queries.lock().unwrap().is_empty(), "{text}");
        }

        // Past its time: removed, asked again and written again.
        fs::write(&file, r#"{"createdAt":1,"outcome":"expired","ttlMs":5}"#).unwrap();

        let registry = Registry::start(answers(&package));
        let mut again = setup_with(&registry, &setup);

        again.context.services.dns = dns.resolver();

        let plan = plan_again(&again).unwrap();

        assert!(plan.cache.contains(&CacheAction::Remove(file)));
        assert_eq!(domain_writes(&plan), [format!("{{\"createdAt\":{NOW},\"outcome\":\"ok\",\"ttlMs\":86400000}}")]);
        assert_eq!(dns.queries.lock().unwrap().len(), 1);
    }

    #[test]
    fn what_cannot_be_told_from_one_answer_is_handed_over() {
        // A refusal, a lookup that times out, a CNAME and a domain that is not a plain name: no finding is made up.
        for scenario in ["servfail", "no answer", "cname only", "truncated"] {
            let chosen = scenario_named(scenario);
            let dns = Dns::start(move |_| chosen.clone());
            let package = package_of(json!({ "name": "amy", "email": "amy@asked.test" }), &json!([]));
            let (plan, _setup) = run_with(&package, &dns);

            assert!(plan.is_err(), "{scenario}");
        }

        let dns = Dns::start(|_| scenario_named("nxdomain"));

        for package in [
            package_of(json!({ "name": "amy", "email": "amy@localhost" }), &json!([])),
            package_of(json!({ "name": "amy", "email": "amy@exämple.test" }), &json!([])),
            package_of(json!(null), &json!([])),
            package_of(json!({ "name": "amy", "email": "amy@asked.test" }), &json!({ "name": "not a list" })),
            package_of(json!({ "name": "amy" }), &json!([null])),
        ] {
            assert!(run_with(&package, &dns).0.is_err());
        }

        // Nothing to ask: no maintainer with an address, or an address without a domain.
        for user in [
            json!({ "name": "amy" }),
            json!({ "name": "amy", "email": "amy@" }),
            json!("amy"),
            json!({ "email": null }),
        ] {
            let (plan, _setup) = run_with(&package_of(user, &json!(null)), &dns);

            assert!(plan.unwrap().stdout.contains("\"findings\": []"));
        }

        assert!(dns.queries.lock().unwrap().is_empty());
    }

    #[test]
    fn a_resolver_that_answers_a_domain_only_after_the_wait_is_handed_over() {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let address = socket.local_addr().unwrap();
        let resolver = Resolver { servers: vec![address], wait: Duration::from_millis(100), declined: None };
        let started = std::time::Instant::now();

        assert!(resolver.lookup("example.test").unwrap_err().contains("in time"));
        assert!(started.elapsed() < Duration::from_secs(2));

        // A machine whose settings rotate the servers is not asked at all.
        let resolver = Resolver { declined: Some("rotation".to_owned()), ..resolver };

        assert_eq!(resolver.lookup("example.test"), Err("rotation".to_owned()));
    }
}
