//! The unit tests of `vis audit`: the shapes it takes, the report and row it prints, and the request to OSV against a stub on
//! 127.0.0.1 (nothing leaves the machine). The answers of a whole run are compared with what the Node handler printed for
//! the same lockfile (`tests/fixtures/audit/`, recorded from Node with its OSV request answered locally); the cases the
//! binary hands to Node are in `__tests__/native/audit-parity.test.ts`.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::osv::{lists_nothing, query_body, scan_is_clean};
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

    assert!(scan_is_clean(&url, &packages(&[("a", "1.0.0"), ("b", "2.0.0")])).is_ok());

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

        assert!(scan_is_clean(&url, &packages(&[("a", "1.0.0")])).is_ok(), "{status}");
    }
}

#[test]
fn every_other_outcome_is_node_s() {
    for (name, reply) in [
        ("a finding", json_reply("200 OK", r#"{"results":[{"vulns":[{"id":"GHSA-x"}]}]}"#)),
        ("a body that is not JSON", json_reply("200 OK", "{")),
        ("an empty 204", "HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n".to_owned()),
        (
            "a redirect",
            "HTTP/1.1 302 Found\r\nlocation: /elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned(),
        ),
    ] {
        let (url, _seen) = serve(Box::leak(reply.into_boxed_str()));

        assert!(scan_is_clean(&url, &packages(&[("a", "1.0.0")])).is_err(), "{name}");
    }
}

#[test]
fn a_connection_that_fails_is_node_s() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}/v1/querybatch", listener.local_addr().unwrap().port());

    drop(listener);

    assert!(scan_is_clean(&url, &packages(&[("a", "1.0.0")])).is_err());
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
fn a_whole_run_reads_a_refused_status_as_clean_and_a_finding_as_node_s() {
    let root = workspace("status");
    let style = Style { colour: false };
    let (url, _seen) = serve(Box::leak(json_reply("400 Bad Request", "{}").into_boxed_str()));

    assert!(scan_workspace(&root, &url, style, false, "T").is_ok());

    let (url, _seen) = serve(Box::leak(
        json_reply("200 OK", r#"{"results":[{"vulns":[{"id":"GHSA-x"}]},{},{},{},{},{}]}"#).into_boxed_str(),
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
