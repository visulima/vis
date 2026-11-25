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
const NOW: u64 = 1_718_452_800_000;

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

fn ago(days: f64) -> String {
    iso(NOW - (days * DAY as f64) as u64)
}

type Answers = HashMap<String, (u16, String, Vec<(String, String)>)>;

struct Registry {
    port: u16,
    requests: Arc<AtomicUsize>,
    paths: Arc<Mutex<Vec<String>>>,
}

impl Registry {
    fn start(answers: Answers) -> Self {
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

    fn url(&self) -> String {
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

fn ok(body: &Value) -> (u16, String, Vec<(String, String)>) {
    (200, body.to_string(), Vec::new())
}

struct Setup {
    context: Context,
    home: PathBuf,
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
                    || "http://127.0.0.1:1/downloads".to_owned(),
                    |registry| format!("{}/downloads", registry.url()),
                ),
            },
            root,
            home: home.clone(),
            cache_dir,
            now_ms: NOW,
            layout: Some(Layout { width: 80, colour: false }),
        },
        home,
    }
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

fn user(name: &str) -> Value {
    json!({ "name": name, "email": format!("{name}@example.test") })
}

/// A version entry that has everything the metadata marshall wants.
fn entry(user_name: &str, extra: &Value) -> Value {
    let mut base = json!({
        "_npmUser": user(user_name), "license": "MIT", "readme": "# readme", "repository": { "type": "git", "url": "git+https://github.com/o/r.git" },
    });

    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }

    base
}

fn packument(versions: &Value, times: &Value) -> Value {
    let latest = versions.as_object().unwrap().keys().next_back().unwrap().clone();

    json!({ "name": "pkg", "dist-tags": { "latest": latest, "next": "2.0.0-beta.1" }, "versions": versions, "time": times })
}

/// A package with three releases by one maintainer, the newest 80 days old.
fn calm() -> Value {
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

        // Nothing listens at the downloads address.
        let (_registry, mut setup) = with_downloads(None, "pkg");

        setup.context.services.downloads = "http://127.0.0.1:1/downloads".to_owned();
        assert!(only_downloads(&setup).is_err());

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
