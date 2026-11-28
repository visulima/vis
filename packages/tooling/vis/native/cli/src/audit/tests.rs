//! The unit tests of `vis audit`: the shapes it takes, the report and row it prints, and the request to OSV against a stub on
//! 127.0.0.1 (nothing leaves the machine). The answers of a whole run are compared with what the Node handler printed for
//! the same lockfile (`tests/fixtures/audit/`, recorded from Node with its OSV request answered locally); the cases the
//! binary hands to Node are in `__tests__/native/audit-parity.test.ts`.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::osv::{lists_nothing, query_body, scan};
use super::parse;
use super::report::{clean_report, duplicates, elapsed, progress_row, Package};
use super::scan_workspace;
use crate::term::Style;

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

fn packages<'a>(list: &[(&'a str, &'a str)]) -> Vec<Package<'a>> {
    list.iter().map(|(name, version)| Package { name, version }).collect()
}

#[test]
fn takes_json_without_policies_and_the_flags_that_change_nothing_without_a_finding() {
    for shape in [
        &["audit", "--format", "json", "--policies", "none"][..],
        &["audit", "--format=json", "--policies=none"],
        &["audit", "--policies", "none", "--exit-code", "--format", "json"],
        &["audit", "--format", "json", "--policies=none", "--severity", "high", "--fail-on=critical", "--exit-code"],
        &["audit", "--severity=low", "--format=json", "--policies", "none"],
    ] {
        assert!(parse(&argv(shape)), "{shape:?}");
    }
}

#[test]
fn hands_every_other_shape_to_node() {
    for shape in [
        &["audit"][..],
        // The default config runs the `publisherChange` policy, which asks the registry; only `none` skips it.
        &["audit", "--format", "json"],
        &["audit", "--format=json"],
        &["audit", "--format", "json", "--policies", "license"],
        &["audit", "--format", "json", "--policies", "None"],
        &["audit", "--format", "json", "--policies", "all"],
        &["audit", "--format", "json", "--policies"],
        &["audit", "--format", "json", "--policies", "none", "--policies", "none"],
        &["audit", "--policies", "none"],
        &["audit", "--format", "table", "--policies", "none"],
        &["audit", "--format", "--policies", "none"],
        &["audit", "--format", "json", "--format", "json", "--policies", "none"],
        &["audit", "--format", "json", "--policies", "none", "--severity", "bogus"],
        &["audit", "--format", "json", "--policies", "none", "--severity"],
        &["audit", "--format", "json", "--policies", "none", "--fail-on", "HIGH"],
        &["audit", "--format", "json", "--policies", "none", "--exit-code=false"],
        &["audit", "--format", "json", "--policies", "none", "--exit-code", "--exit-code"],
        &["audit", "--format", "json", "--policies", "none", "--offline"],
        &["audit", "--format", "json", "--policies", "none", "--prod-only"],
        &["audit", "--format", "json", "--policies", "none", "--fix"],
        &["audit", "--format", "json", "--policies", "none", "--report", "x.html"],
        &["audit", "--format", "json", "--policies", "none", "--json"],
        &["audit", "--format", "json", "--policies", "none", "extra"],
        &["audit", "--format", "json", "--policies", "none", "--no-color"],
    ] {
        assert!(!parse(&argv(shape)), "{shape:?}");
    }
}

#[test]
fn the_report_of_a_clean_scan_is_json_stringify_with_two_spaces() {
    let report = clean_report(3, &[], "2026-01-02T03:04:05.678Z", "/work/app");

    assert_eq!(
        report,
        r#"{
  "bloomHits": [],
  "duplicates": [],
  "generatedAt": "2026-01-02T03:04:05.678Z",
  "packages": 3,
  "policies": [],
  "results": [],
  "schemaVersion": "1.1",
  "summary": {
    "accepted": 0,
    "duplicatePackages": 0,
    "issues": 0,
    "policyBlocks": 0,
    "policyDecisions": 0,
    "total": 0
  },
  "tool": {
    "informationUri": "https://github.com/visulima/visulima",
    "name": "vis-audit",
    "version": "alpha"
  },
  "warnings": [],
  "workspaceRoot": "/work/app",
  "unauditable": []
}
"#
    );
}

#[test]
fn duplicates_list_each_version_once_and_sort_like_locale_compare() {
    let list = packages(&[
        ("zod", "3.0.0"),
        ("@a/x", "1.0.0"),
        ("zod", "4.0.0"),
        ("@a/x", "1.0.0"),
        ("solo", "1.0.0"),
        ("@a/x", "2.0.0"),
        ("a-b", "1.0.0"),
        ("a-b", "1.0.1"),
    ]);
    let found = duplicates(&list);
    let names: Vec<&str> = found.iter().map(|duplicate| duplicate.name).collect();

    assert_eq!(names, ["@a/x", "a-b", "zod"]);
    assert_eq!(found[0].versions, ["1.0.0", "2.0.0"]);

    let report = clean_report(list.len(), &found, "T", "/r");

    assert!(report.contains(
        "  \"duplicates\": [\n    {\n      \"name\": \"@a/x\",\n      \"versionCount\": 2,\n      \"versions\": [\n        \"1.0.0\",\n        \"2.0.0\"\n      ]\n    },\n    {\n      \"name\": \"a-b\","
    ));
    assert!(report.contains("      ]\n    }\n  ],\n  \"generatedAt\""));
    assert!(report.contains("\"duplicatePackages\": 3"));
}

#[test]
fn a_path_with_characters_json_escapes_is_escaped() {
    assert!(clean_report(1, &[], "T", "/a\"b\\c").contains("\"workspaceRoot\": \"/a\\\"b\\\\c\""));
}

#[test]
fn elapsed_time_is_whole_milliseconds_then_tenths_of_a_second_that_round_half_up() {
    for (ms, text) in [
        (0, "0ms"),
        (12, "12ms"),
        (999, "999ms"),
        (1000, "1.0s"),
        (1049, "1.0s"),
        // `(1.05).toFixed(1)` is `1.1` and `(1.15).toFixed(1)` is `1.1`: the double decides, not the decimal text.
        (1050, "1.1s"),
        (1150, "1.1s"),
        // Exactly halfway: `toFixed` rounds up where Rust's `{:.1}` rounds to even.
        (1250, "1.3s"),
        (1750, "1.8s"),
        (2250, "2.3s"),
        (10_250, "10.3s"),
        (59_999, "60.0s"),
    ] {
        assert_eq!(elapsed(Duration::from_millis(ms)), text, "{ms}ms");
    }
}

#[test]
fn the_progress_row_has_the_tick_label_and_dimmed_summary() {
    let took = Duration::from_millis(12);

    assert_eq!(
        progress_row(Style { colour: false }, took, false),
        "  \u{2713} Known vulnerabilities (OSV) \u{2014} none found \u{b7} 12ms\n"
    );
    assert_eq!(
        progress_row(Style { colour: false }, took, true),
        "  v Known vulnerabilities (OSV) \u{2014} none found \u{b7} 12ms\n"
    );
    assert_eq!(
        progress_row(Style { colour: true }, took, false),
        "  \u{1b}[32m\u{2713}\u{1b}[39m Known vulnerabilities (OSV) \u{1b}[2m\u{2014} none found \u{b7} 12ms\u{1b}[22m\n"
    );
}

#[test]
fn the_request_body_is_json_stringify_of_the_queries() {
    assert_eq!(
        query_body(&packages(&[("a", "1.0.0"), ("@s/b", "2.0.0-rc.1")])),
        r#"{"queries":[{"package":{"ecosystem":"npm","name":"a"},"version":"1.0.0"},{"package":{"ecosystem":"npm","name":"@s/b"},"version":"2.0.0-rc.1"}]}"#
    );
}

#[test]
fn only_an_answer_without_findings_is_clean() {
    for clean in [
        r#"{"results":[]}"#,
        r#"{"results":[{},{}]}"#,
        r#"{"results":[{"vulns":[]},{"vulns":null},{"next_page_token":"x"}],"extra":1}"#,
    ] {
        assert!(lists_nothing(clean), "{clean}");
    }

    for other in [
        "",
        "{",
        "null",
        "[]",
        r#"{}"#,
        r#"{"results":null}"#,
        r#"{"results":{}}"#,
        r#"{"results":[null]}"#,
        r#"{"results":["x"]}"#,
        r#"{"results":[{"vulns":[{"id":"GHSA-x"}]}]}"#,
        r#"{"results":[{},{"vulns":[{"id":"GHSA-x"}]}]}"#,
        r#"{"results":[{"vulns":{}}]}"#,
        r#"{"results":[{"vulns":"x"}]}"#,
        "\u{feff}{\"results\":[]}",
        r#"{"results":[{"vulns":["\ud800"]}]}"#,
    ] {
        assert!(!lists_nothing(other), "{other:?}");
    }
}

/// Serves `reply` to one connection and returns what the client sent (head and body).
fn serve(reply: &'static str) -> (String, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}/v1/querybatch", listener.local_addr().unwrap().port());
    let thread = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut seen = Vec::new();
        let mut chunk = [0_u8; 4096];

        loop {
            let read = stream.read(&mut chunk).unwrap();

            seen.extend_from_slice(&chunk[..read]);

            let text = String::from_utf8_lossy(&seen);

            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);

                if body.len() >= length {
                    break;
                }
            }

            if read == 0 {
                break;
            }
        }

        stream.write_all(reply.as_bytes()).unwrap();

        String::from_utf8_lossy(&seen).into_owned()
    });

    (url, thread)
}

fn json_reply(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn a_clean_answer_ends_the_scan_and_the_request_is_what_node_sends() {
    let (url, seen) = serve(Box::leak(json_reply("200 OK", r#"{"results":[{},{}]}"#).into_boxed_str()));

    assert!(scan(&url, &packages(&[("a", "1.0.0"), ("b", "2.0.0")])).is_ok());

    let request = seen.join().unwrap().to_ascii_lowercase();

    assert!(request.starts_with("post /v1/querybatch http/1.1"), "{request}");
    assert!(request.contains("content-type: application/json"), "{request}");
    assert!(
        request.ends_with(&query_body(&packages(&[("a", "1.0.0"), ("b", "2.0.0")])).to_ascii_lowercase()),
        "{request}"
    );
}

#[test]
fn a_status_outside_2xx_is_an_empty_result_as_in_node() {
    for status in ["400 Bad Request", "404 Not Found", "500 Internal Server Error", "429 Too Many Requests"] {
        let (url, _seen) = serve(Box::leak(json_reply(status, "{}").into_boxed_str()));

        assert!(scan(&url, &packages(&[("a", "1.0.0")])).is_ok(), "{status}");
    }
}

#[test]
fn every_other_outcome_is_node_s() {
    for (name, reply) in [
        (
            "a finding with a severity",
            json_reply("200 OK", r#"{"results":[{"vulns":[{"id":"GHSA-x","severity":[]}]}]}"#),
        ),
        ("a body that is not JSON", json_reply("200 OK", "{")),
        ("an empty 204", "HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n".to_owned()),
        (
            "a redirect",
            "HTTP/1.1 302 Found\r\nlocation: /elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned(),
        ),
    ] {
        let (url, _seen) = serve(Box::leak(reply.into_boxed_str()));

        assert!(scan(&url, &packages(&[("a", "1.0.0")])).is_err(), "{name}");
    }
}

#[test]
fn a_connection_that_fails_is_node_s() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}/v1/querybatch", listener.local_addr().unwrap().port());

    drop(listener);

    assert!(scan(&url, &packages(&[("a", "1.0.0")])).is_err());
}

/// The lockfile Node was run on, and what it printed (`generatedAt`, the workspace root and the time masked).
const LOCKFILE: &str = include_str!("../../tests/fixtures/audit/basic.pnpm-lock.yaml");
const STDOUT: &str = include_str!("../../tests/fixtures/audit/basic.stdout");

fn workspace(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("vis-audit-{name}-{}", std::process::id()));

    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("pnpm-lock.yaml"), LOCKFILE).unwrap();

    root
}

/// What the stub answers for a lockfile of six packages: an empty result for each.
const CLEAN: &str = r#"{"results":[{},{},{},{},{},{}]}"#;

#[test]
fn a_whole_run_prints_what_node_printed_in_every_colour_and_terminal() {
    let root = workspace("whole");
    let timing = regex::Regex::new(r"· \d+(?:\.\d)?m?s").unwrap();

    for (style, linux, stderr) in [
        (Style { colour: false }, false, include_str!("../../tests/fixtures/audit/plain.stderr")),
        (Style { colour: true }, false, include_str!("../../tests/fixtures/audit/colour.stderr")),
        (Style { colour: false }, true, include_str!("../../tests/fixtures/audit/linux.stderr")),
    ] {
        let (url, _seen) = serve(Box::leak(json_reply("200 OK", CLEAN).into_boxed_str()));
        let (printed, row) = scan_workspace(&root, &url, style, linux, "2026-01-02T03:04:05.678Z").unwrap();

        assert_eq!(printed, STDOUT.replace("{root}", &root.to_str().unwrap().replace('\\', "\\\\")));
        assert_eq!(timing.replace(&row, "· <TIME>"), stderr);
    }
}

#[test]
fn a_whole_run_reads_a_refused_status_as_clean_and_a_finding_with_fields_node_maps_as_node_s() {
    let root = workspace("status");
    let style = Style { colour: false };
    let (url, _seen) = serve(Box::leak(json_reply("400 Bad Request", "{}").into_boxed_str()));

    assert!(scan_workspace(&root, &url, style, false, "T").is_ok());

    let (url, _seen) = serve(Box::leak(
        json_reply("200 OK", r#"{"results":[{"vulns":[{"id":"GHSA-x","summary":"x"}]},{},{},{},{},{}]}"#)
            .into_boxed_str(),
    ));

    assert!(scan_workspace(&root, &url, style, false, "T").is_err());
}

#[test]
fn a_lockfile_without_a_package_is_node_s() {
    let root = std::env::temp_dir().join(format!("vis-audit-empty-{}", std::process::id()));

    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n").unwrap();

    assert!(scan_workspace(&root, "http://127.0.0.1:9/", Style { colour: false }, false, "T").is_err());
}

/// A workspace whose lockfile is the recorded one and whose `node_modules` holds `files` (relative to the root).
fn installed(name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
    let root = workspace(name);

    for (path, content) in files {
        let target = root.join(path);

        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, content).unwrap();
    }

    root
}

const PLAIN: &str = r#"{"name":"plain","version":"1.0.0","dependencies":{"x":"1.0.0"}}"#;

#[test]
fn a_workspace_without_bundling_or_a_vendored_tree_is_still_answered_and_prints_what_node_printed() {
    let root = installed(
        "plain-modules",
        &[
            ("node_modules/plain/package.json", PLAIN),
            ("node_modules/@scope/pkg/package.json", PLAIN),
            ("node_modules/plain/node_modules/inner/package.json", PLAIN),
            ("node_modules/.pnpm/store@1.0.0/node_modules/store/package.json", PLAIN),
            // A directory called `compiled` that holds only files vendors no package.
            ("node_modules/plain/compiled/bundle.js", "module.exports = 1;"),
        ],
    );
    let (url, _seen) = serve(Box::leak(json_reply("200 OK", CLEAN).into_boxed_str()));
    let (printed, _row) =
        scan_workspace(&root, &url, Style { colour: false }, false, "2026-01-02T03:04:05.678Z").unwrap();

    assert_eq!(printed, STDOUT.replace("{root}", &root.to_str().unwrap().replace('\\', "\\\\")));
    assert!(printed.ends_with("\"unauditable\": []\n}\n"));
}

#[test]
fn a_package_that_ships_dependencies_inside_itself_is_node_s_in_every_place_node_looks() {
    for (name, path, manifest) in [
        (
            "hoisted",
            "node_modules/host/package.json",
            r#"{"name":"host","version":"1.0.0","bundleDependencies":["dep"]}"#,
        ),
        (
            "spelled-out",
            "node_modules/host/package.json",
            r#"{"name":"host","version":"1.0.0","bundledDependencies":true}"#,
        ),
        (
            "scoped",
            "node_modules/@s/host/package.json",
            r#"{"name":"@s/host","version":"1.0.0","bundleDependencies":["dep"]}"#,
        ),
        (
            "in-store",
            "node_modules/.pnpm/host@1.0.0_peer@2.0.0/node_modules/host/package.json",
            r#"{"name":"host","version":"1.0.0","bundleDependencies":["dep"]}"#,
        ),
        (
            "nested",
            "node_modules/plain/node_modules/host/package.json",
            r#"{"name":"host","version":"1.0.0","bundledDependencies":["dep"]}"#,
        ),
        (
            "escaped-key",
            "node_modules/host/package.json",
            r#"{"name":"host","version":"1.0.0","bundle\u0044ependencies":["dep"]}"#,
        ),
    ] {
        let root =
            installed(&format!("bundles-{name}"), &[("node_modules/plain/package.json", PLAIN), (path, manifest)]);
        let outcome = scan_workspace(&root, "http://127.0.0.1:9/", Style { colour: false }, false, "T");

        assert!(outcome.is_err(), "{name}: {outcome:?}");
    }
}

#[test]
fn the_reason_names_what_node_would_scan() {
    let root = installed("bundles-reason", &[("node_modules/host/package.json", r#"{"bundleDependencies":["dep"]}"#)]);
    let reason = scan_workspace(&root, "http://127.0.0.1:9/", Style { colour: false }, false, "T").unwrap_err();

    assert!(reason.contains("ships other packages inside itself"), "{reason}");
}

#[test]
fn a_vendored_tree_is_node_s() {
    for (name, path) in [
        ("dist-compiled", "node_modules/host/dist/compiled/semver/package.json"),
        ("compiled", "node_modules/host/compiled/thing/index.js"),
        ("scoped-host", "node_modules/@s/host/dist/compiled/x/index.js"),
        ("nested-host", "node_modules/plain/node_modules/host/dist/compiled/x/index.js"),
        ("in-store", "node_modules/.pnpm/host@1.0.0/node_modules/host/dist/compiled/x/index.js"),
    ] {
        let root = installed(
            &format!("vendors-{name}"),
            &[("node_modules/plain/package.json", PLAIN), ("node_modules/host/package.json", PLAIN), (path, "{}")],
        );
        let reason = scan_workspace(&root, "http://127.0.0.1:9/", Style { colour: false }, false, "T").unwrap_err();

        assert!(reason.contains("vendored tree"), "{name}: {reason}");
    }
}

#[cfg(unix)]
#[test]
fn a_linked_package_is_not_read_as_an_installed_copy() {
    let root = installed(
        "linked",
        &[("node_modules/plain/package.json", PLAIN), ("elsewhere/package.json", r#"{"bundleDependencies":["dep"]}"#)],
    );

    std::os::unix::fs::symlink(root.join("elsewhere"), root.join("node_modules/linked")).unwrap();

    assert!(super::bundled::decline(&root).is_none());
}

#[test]
fn nothing_is_read_without_a_node_modules_directory() {
    let root = workspace("no-modules");

    assert!(super::bundled::decline(&root).is_none());
}

#[test]
fn a_manifest_with_an_unrelated_escape_does_not_hand_over_but_one_that_is_not_json_does() {
    let accents =
        installed("accents", &[("node_modules/plain/package.json", r#"{"name":"plain","author":"J\u00e9r\u00f4me"}"#)]);

    assert!(super::bundled::decline(&accents).is_none());

    let broken = installed("broken-json", &[("node_modules/plain/package.json", "{ not json")]);

    assert!(super::bundled::decline(&broken).is_some());
}

// ---- findings that Node drops, and the formats other than `json` -------------------------------------------------

use super::formats::{banner, document, found_row, Format};
use super::osv::documented_findings;
use super::scan_format;
use crate::pail::Layout;

const NOW: &str = "2026-01-02T03:04:05.678Z";
const PLAIN_LAYOUT: Layout = Layout { width: 80, colour: false };

/// What the stub answers for the recorded lockfile of six packages in the run Node was recorded on: two findings for
/// the first package, none for the second, one for the third. The batch endpoint documents `id` and `modified` only.
const FOUND: &str = r#"{"results":[{"vulns":[{"id":"GHSA-aaaa-bbbb-cccc","modified":"2024-01-01T00:00:00Z"},{"id":"MAL-2024-1","modified":"2024-01-01T00:00:00Z"}]},{},{"vulns":[{"id":"CVE-2020-1","modified":"2024-01-01T00:00:00Z"}]},{},{},{}]}"#;

fn timing() -> regex::Regex {
    regex::Regex::new(r"· \d+(?:\.\d)?m?s").unwrap()
}

/// A recorded document with the values Node's runs differ by (the clock, the elapsed time, the root) put back to the
/// ones the run under test used, and the output of this run with its clock and elapsed time masked the way the fixture is.
fn unmasked(fixture: &str, root: &std::path::Path) -> String {
    fixture
        .replace("{root}", &root.to_str().unwrap().replace('\\', "\\\\"))
        .replace("{now}", NOW)
        .replace("{seconds}", &NOW[..19])
        .replace("{date}", &NOW[..10])
}

fn masked(output: &str) -> String {
    let clock = regex::Regex::new(r"(?m)^\d\d:\d\d:\d\d INFO").unwrap();
    let elapsed = regex::Regex::new(r"Scan completed in \d+(?:\.\d)?m?s").unwrap();

    elapsed.replace_all(&clock.replace_all(output, "<CLOCK> INFO"), "Scan completed in <TIME>").into_owned()
}

fn run_format(
    name: &str,
    format: Format,
    body: &'static str,
    layout: Option<Layout>,
) -> (std::path::PathBuf, Result<(String, String), String>) {
    let root = workspace(name);
    let (url, _seen) = serve(Box::leak(json_reply("200 OK", body).into_boxed_str()));
    let outcome = scan_format(&root, &url, format, Style { colour: false }, false, &|| NOW.to_owned(), layout);

    (root, outcome)
}

#[test]
fn takes_the_formats_that_print_an_empty_result_and_hands_over_the_rest() {
    for format in ["json", "sarif", "junit", "gitlab", "csaf"] {
        assert!(parse(&argv(&["audit", "--format", format, "--policies", "none"])), "{format}");
        assert!(parse(&argv(&["audit", &format!("--format={format}"), "--policies=none", "--exit-code"])), "{format}");
    }

    for format in ["table", "cyclonedx-vex", "cyclonedx", "html", "SARIF", "Json", ""] {
        assert!(!parse(&argv(&["audit", "--format", format, "--policies", "none"])), "{format:?}");
    }

    // A format named twice, even with the same value, and a format with the default policies stay Node's.
    assert!(!parse(&argv(&["audit", "--format", "sarif", "--format", "sarif", "--policies", "none"])));
    assert!(!parse(&argv(&["audit", "--format", "sarif"])));
    assert!(!parse(&argv(&["audit", "--format", "sarif", "--policies", "none", "--report", "r.html"])));
    assert!(!parse(&argv(&["audit", "--format", "sarif", "--policies", "none", "--output", "r.sarif"])));
}

#[test]
fn counts_the_findings_of_the_documented_answer_for_the_packages_asked_about() {
    for (body, scanned, count) in [
        (FOUND, 6, 3),
        // The answer is read for the packages Node asked about; a longer list is ignored, a shorter one is not an error.
        (FOUND, 1, 2),
        (FOUND, 0, 0),
        (r#"{"results":[{"vulns":[{"id":"a","modified":"x"}]}]}"#, 3, 1),
        // A repeated id counts each time, and a record may carry any key Node does not read.
        (r#"{"results":[{"vulns":[{"id":"a"},{"id":"a","modified":null,"details":"x"}]}]}"#, 1, 2),
        // The keys Node maps may be absent or null.
        (
            r#"{"results":[{"vulns":[{"id":"a","severity":null,"database_specific":null,"affected":null,"aliases":null,"summary":null}]}]}"#,
            1,
            1,
        ),
        (r#"{"results":[{"vulns":null},{"vulns":[]},{}]}"#, 3, 0),
    ] {
        assert_eq!(documented_findings(body, scanned), Some(count), "{body}");
    }
}

#[test]
fn a_record_node_maps_or_reads_differently_is_node_s() {
    for body in [
        // Every field `mapOsvVuln` reads, present: the finding may get a severity and reach the report, or its
        // type may make the handler's `catch` print an error row.
        r#"{"results":[{"vulns":[{"id":"a","severity":[{"type":"CVSS_V3","score":"9.8"}]}]}]}"#,
        r#"{"results":[{"vulns":[{"id":"a","database_specific":{"severity":"HIGH"}}]}]}"#,
        r#"{"results":[{"vulns":[{"id":"a","affected":[]}]}]}"#,
        r#"{"results":[{"vulns":[{"id":"a","aliases":["CVE-1"]}]}]}"#,
        r#"{"results":[{"vulns":[{"id":"a","summary":"x"}]}]}"#,
        r#"{"results":[{"vulns":[{"id":"a","summary":""}]}]}"#,
        r#"{"results":[{"vulns":[{"id":"a","aliases":[]}]}]}"#,
        r#"{"results":[{"vulns":[{"id":"a","severity":false}]}]}"#,
        // A record that is not an object, or has no string id, and a list that is not an array.
        r#"{"results":[{"vulns":[null]}]}"#,
        r#"{"results":[{"vulns":["GHSA-x"]}]}"#,
        r#"{"results":[{"vulns":[{}]}]}"#,
        r#"{"results":[{"vulns":[{"id":7}]}]}"#,
        r#"{"results":[{"vulns":{"id":"a"}}]}"#,
        r#"{"results":[{"vulns":"abc"}]}"#,
        // A result that is not an object, past the packages asked about as well.
        r#"{"results":[null]}"#,
        r#"{"results":[{},"x"]}"#,
        r#"{"results":{}}"#,
        r#"[]"#,
        "{",
        "\u{feff}{\"results\":[]}",
    ] {
        assert_eq!(documented_findings(body, 1), None, "{body}");
    }
}

#[test]
fn the_row_of_a_scan_with_findings_has_a_yellow_warning_and_the_count() {
    let took = Duration::from_millis(12);

    assert_eq!(
        found_row(Style { colour: false }, 4, took, false),
        "  \u{26a0} Known vulnerabilities (OSV) \u{2014} 4 found \u{b7} 12ms\n"
    );
    assert_eq!(
        found_row(Style { colour: false }, 1, took, true),
        "  ! Known vulnerabilities (OSV) \u{2014} 1 found \u{b7} 12ms\n"
    );
    assert_eq!(
        found_row(Style { colour: true }, 4, took, false),
        "  \u{1b}[33m\u{26a0}\u{1b}[39m Known vulnerabilities (OSV) \u{1b}[2m\u{2014} 4 found \u{b7} 12ms\u{1b}[22m\n"
    );
}

#[test]
fn the_row_matches_what_node_printed_in_every_colour_and_terminal() {
    let root = workspace("found-rows");

    for (style, linux, stderr) in [
        (Style { colour: false }, false, include_str!("../../tests/fixtures/audit/found.plain.stderr")),
        (Style { colour: true }, false, include_str!("../../tests/fixtures/audit/found.colour.stderr")),
        (Style { colour: false }, true, include_str!("../../tests/fixtures/audit/found.linux.stderr")),
    ] {
        let (url, _seen) = serve(Box::leak(json_reply("200 OK", FOUND).into_boxed_str()));
        let (_printed, row) = scan_workspace(&root, &url, style, linux, NOW).unwrap();

        assert_eq!(timing().replace(&row, "· <TIME>"), stderr);
    }
}

#[test]
fn findings_node_drops_print_the_report_of_a_clean_scan() {
    let (root, outcome) = run_format("found-json", Format::Json, FOUND, None);
    let (printed, _row) = outcome.unwrap();

    assert_eq!(printed, unmasked(include_str!("../../tests/fixtures/audit/found.json.stdout"), &root));
    // ... which is the clean report, byte for byte, as Node printed it for the same lockfile.
    assert_eq!(printed, STDOUT.replace("{root}", &root.to_str().unwrap().replace('\\', "\\\\")));

    // The exit gates see no finding: Node exits 0 with `--exit-code --fail-on low --severity critical` too, and the run
    // here ends in `exit(0)` whatever the answer lists.
    assert_eq!(include_str!("../../tests/fixtures/audit/found.gates.exit"), "0\n");
}

macro_rules! format_matches_node {
    ($name:ident, $format:expr, $found:literal, $clean:literal, $clean_row:literal) => {
        #[test]
        fn $name() {
            for (label, body, stdout, row) in [
                (
                    "with findings",
                    FOUND,
                    include_str!($found),
                    include_str!("../../tests/fixtures/audit/found.plain.stderr"),
                ),
                ("clean", CLEAN, include_str!($clean), include_str!($clean_row)),
            ] {
                let (root, outcome) =
                    run_format(&format!("{}-{label}", stringify!($name)), $format, body, Some(PLAIN_LAYOUT));
                let (printed, printed_row) = outcome.unwrap();

                assert_eq!(masked(&printed), unmasked(stdout, &root), "{label}");
                assert_eq!(timing().replace(&printed_row, "· <TIME>"), row, "{label}");
            }
        }
    };
}

format_matches_node!(
    sarif_matches_node,
    Format::Sarif,
    "../../tests/fixtures/audit/found.sarif.stdout",
    "../../tests/fixtures/audit/clean.sarif.stdout",
    "../../tests/fixtures/audit/clean.sarif.stderr"
);
format_matches_node!(
    junit_matches_node,
    Format::Junit,
    "../../tests/fixtures/audit/found.junit.stdout",
    "../../tests/fixtures/audit/clean.junit.stdout",
    "../../tests/fixtures/audit/clean.junit.stderr"
);
format_matches_node!(
    gitlab_matches_node,
    Format::Gitlab,
    "../../tests/fixtures/audit/found.gitlab.stdout",
    "../../tests/fixtures/audit/clean.gitlab.stdout",
    "../../tests/fixtures/audit/clean.gitlab.stderr"
);
format_matches_node!(
    csaf_matches_node,
    Format::Csaf,
    "../../tests/fixtures/audit/found.csaf.stdout",
    "../../tests/fixtures/audit/clean.csaf.stdout",
    "../../tests/fixtures/audit/clean.csaf.stderr"
);

#[test]
fn the_clocks_of_the_documents_are_the_ones_node_reads() {
    // `toISOString()` without the milliseconds and the zone for JUnit and GitLab, whole for CSAF with the UTC date as id.
    assert!(document(Format::Junit, NOW).unwrap().contains("timestamp=\"2026-01-02T03:04:05\""));
    assert!(document(Format::Gitlab, NOW).unwrap().contains("\"start_time\": \"2026-01-02T03:04:05\""));
    assert!(document(Format::Gitlab, NOW).unwrap().contains("\"end_time\": \"2026-01-02T03:04:05\""));

    let csaf = document(Format::Csaf, NOW).unwrap();

    assert!(csaf.contains("\"id\": \"vis-audit-2026-01-02\""));
    assert!(csaf.contains("\"current_release_date\": \"2026-01-02T03:04:05.678Z\""));
    assert!(document(Format::Json, NOW).is_none());
}

#[test]
fn the_block_of_scan_completed_is_pail_s_and_only_where_it_can_be_laid_out() {
    let text = banner(PLAIN_LAYOUT, Duration::from_millis(12)).unwrap();

    assert!(
        regex::Regex::new(r"^\d\d:\d\d:\d\d INFO \.+\n\nScan completed in 12ms\n$").unwrap().is_match(&text),
        "{text:?}"
    );
    assert_eq!(text.lines().next().unwrap().len(), 77);
    // A coloured header (pail wraps the clock and the label, and dims the message) and a line too narrow for the
    // message are Node's.
    assert!(banner(Layout { width: 80, colour: true }, Duration::from_millis(12)).is_none());
    assert!(banner(Layout { width: 24, colour: false }, Duration::from_millis(12)).is_none());
}

#[test]
fn a_format_that_prints_the_block_needs_pail_s_layout() {
    let (_root, outcome) = run_format("no-layout", Format::Sarif, FOUND, None);

    assert!(outcome.is_err());

    let (_root, outcome) = run_format("colour-layout", Format::Sarif, FOUND, Some(Layout { width: 80, colour: true }));

    assert!(outcome.unwrap_err().contains("pail"));
}

#[test]
fn a_run_node_would_print_differently_is_node_s_in_every_format() {
    let detailed: &'static str = r#"{"results":[{"vulns":[{"id":"GHSA-x","database_specific":{"severity":"HIGH"},"summary":"s"}]},{},{},{},{},{}]}"#;

    for format in [Format::Json, Format::Sarif, Format::Junit, Format::Gitlab, Format::Csaf] {
        let (_root, outcome) = run_format("detailed", format, detailed, Some(PLAIN_LAYOUT));

        assert!(outcome.unwrap_err().contains("fields Node maps"), "{format:?}");
    }
}
