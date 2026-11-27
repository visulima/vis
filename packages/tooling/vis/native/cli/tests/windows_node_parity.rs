//! The read-only commands the native binary answers on Windows print what the Node CLI printed there.
//!
//! `tests/fixtures/windows-node/` holds the bytes the Node CLI wrote on Windows for each command and environment of
//! `cases.json`, produced by `capture.mjs` (nothing in it is typed by hand). Colour is the part that differs from
//! unix: with no terminal, Node on Windows paints the output unless a variable, a flag or a dumb `TERM` turns it off,
//! whatever else the environment says. Each case runs the binary in a copy of the workspace the capture ran in, with
//! only the variables of its environment, once into a pipe and once into a file, and compares stdout byte for byte.

#![cfg(windows)]

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// A copy of `from` outside the repository, where no ancestor holds a root marker.
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();

    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());

        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// The file name `capture.mjs` gives the output of `args`.
fn slug(args: &[String]) -> String {
    args.join("_")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '=' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn run(workspace: &Path, args: &[String], environment: &[(String, String)], stdout: Stdio) -> Output {
    Command::new(env!("CARGO_BIN_EXE_vis"))
        .args(args)
        .current_dir(workspace)
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::piped())
        .output()
        .expect("run binary")
}

#[test]
fn the_binary_prints_what_node_printed_on_windows() {
    let directory = fixtures().join("windows-node");
    let cases: Value = serde_json::from_str(&fs::read_to_string(directory.join("cases.json")).unwrap()).unwrap();
    let workspace = std::env::temp_dir().join(format!("vis-windows-parity-{}", std::process::id()));

    let _ = fs::remove_dir_all(&workspace);
    copy_tree(&fixtures().join("list/basic"), &workspace);

    let mut checked = 0;

    for command in cases["commands"].as_array().unwrap() {
        let args: Vec<String> =
            command.as_array().unwrap().iter().map(|word| word.as_str().unwrap().to_owned()).collect();

        for (name, variables) in cases["environments"].as_object().unwrap() {
            let environment: Vec<(String, String)> = variables
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
                .collect();
            let label = format!("vis {} in `{name}`", args.join(" "));
            let expected = fs::read(directory.join(format!("{}__{name}.out", slug(&args)))).unwrap();

            let piped = run(&workspace, &args, &environment, Stdio::piped());

            assert_eq!(String::from_utf8_lossy(&piped.stderr), "", "{label}: stderr");
            assert_eq!(piped.status.code(), Some(0), "{label}: status");
            assert_eq!(
                String::from_utf8_lossy(&piped.stdout),
                String::from_utf8_lossy(&expected),
                "{label}: piped stdout"
            );

            let path = workspace.join("stdout.txt");
            let file = run(&workspace, &args, &environment, Stdio::from(File::create(&path).unwrap()));

            assert_eq!(file.status.code(), Some(0), "{label}: status into a file");
            assert_eq!(
                String::from_utf8_lossy(&fs::read(&path).unwrap()),
                String::from_utf8_lossy(&expected),
                "{label}: stdout in a file"
            );
            fs::remove_file(&path).unwrap();

            checked += 1;
        }
    }

    let _ = fs::remove_dir_all(&workspace);

    assert_eq!(checked, 63);
}

/// What Node does outside CI, or with a colour variable it warns about, is not reproduced, so the binary leaves it to
/// Node. There is no Node to hand over to here, so it must not print the answer.
#[test]
fn a_run_outside_ci_is_left_to_node() {
    let workspace = std::env::temp_dir().join(format!("vis-windows-parity-no-ci-{}", std::process::id()));

    let _ = fs::remove_dir_all(&workspace);
    copy_tree(&fixtures().join("list/basic"), &workspace);

    let pair = |name: &str, value: &str| (name.to_owned(), value.to_owned());

    for environment in
        [vec![], vec![pair("CI", "0")], vec![pair("CI", "1"), pair("FORCE_COLOR", "1"), pair("NO_COLOR", "1")]]
    {
        for command in ["list", "graph", "status"] {
            let output = run(&workspace, &[command.to_owned()], &environment, Stdio::piped());

            assert!(
                !String::from_utf8_lossy(&output.stdout).contains("alpha") && output.status.code() != Some(0),
                "vis {command} answered with {environment:?}: {}",
                String::from_utf8_lossy(&output.stdout)
            );
        }
    }

    let _ = fs::remove_dir_all(&workspace);
}
