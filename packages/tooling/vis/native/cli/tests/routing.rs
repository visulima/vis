//! The binary's half of the routing fixture shared with the Node launcher
//! (`__tests__/native/routing-fixture.test.ts`): for every case that names a `binary` route, the
//! binary must answer natively or hand the call to Node, as the fixture says.
//!
//! A delegation is seen through an unlaunchable Node: the binary then exits 70 with "failed to
//! launch Node CLI", while a native answer never gets that far. Unix only: the launcher keeps
//! the Windows cases away from the binary, and the empty `PATH` trick is a Unix one.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;

use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    args: Vec<String>,
    binary: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    interactive: bool,
    platform: Option<String>,
}

/// A JS-only workspace that the gated commands (`list`, `clean`) accept; a case's `files` come on top.
const PROJECT: [(&str, &str); 4] = [
    ("package.json", "{\"name\":\"t\"}"),
    ("pnpm-lock.yaml", "lockfileVersion: 9\n"),
    ("pnpm-workspace.yaml", "packages:\n  - \"packages/*\"\n"),
    ("packages/a/package.json", "{\"name\":\"a\",\"version\":\"1.0.0\",\"scripts\":{\"build\":\"x\"}}"),
];

fn write_file(directory: &Path, name: &str, content: &str) {
    let path = directory.join(name);

    fs::create_dir_all(path.parent().expect("file has a parent")).expect("create project directory");
    fs::write(path, content).expect("write project file");
}

fn delegates(case: &Case, directory: &Path, empty_path: &Path) -> bool {
    for (name, content) in PROJECT {
        write_file(directory, name, content);
    }

    for (name, content) in &case.files {
        write_file(directory, name, content);
    }

    let output = Command::new(env!("CARGO_BIN_EXE_vis"))
        .args(&case.args)
        .current_dir(directory)
        .env_clear()
        // No package manager on PATH: a native pm command fails to spawn instead of running one.
        .env("PATH", empty_path)
        .env("VIS_NODE", "/nonexistent/node")
        .env("VIS_FALLBACK_ENTRY", "/nonexistent/bin.js")
        .envs(&case.env)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("run binary");

    output.status.code() == Some(70) && String::from_utf8_lossy(&output.stderr).contains("failed to launch Node CLI")
}

#[test]
fn binary_routes_match_the_shared_fixture() {
    let fixture: Fixture = serde_json::from_str(include_str!("fixtures/routing.json")).expect("routing fixture parses");
    let base = std::env::temp_dir().join(format!("vis-routing-{}", std::process::id()));
    let empty_path = base.join("empty");
    let mut failures = Vec::new();
    let mut checked = 0;

    fs::create_dir_all(&empty_path).expect("create empty PATH directory");

    for (index, case) in fixture.cases.iter().enumerate() {
        // The launcher's platform and terminal rules have no counterpart here: the binary cannot be
        // given a terminal, and on Windows the launcher keeps the call away from it.
        let Some(expected) = case.binary.as_deref().filter(|_| case.platform.is_none() && !case.interactive) else {
            continue;
        };

        // A fresh project per case: `clean` and `ignore --write` change the directory they run in.
        let directory = base.join(index.to_string());

        fs::create_dir_all(&directory).expect("create case directory");

        let actual = if delegates(case, &directory, &empty_path) { "node" } else { "native" };

        checked += 1;

        if actual != expected {
            failures.push(format!(
                "vis {:?} with {:?}: fixture says {expected}, binary went {actual}",
                case.args, case.env
            ));
        }
    }

    fs::remove_dir_all(&base).ok();

    assert!(checked > 0, "no case names a binary route");
    assert!(failures.is_empty(), "routes differ from the fixture:\n{}", failures.join("\n"));
}
