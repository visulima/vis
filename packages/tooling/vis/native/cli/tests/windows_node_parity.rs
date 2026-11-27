//! The read-only commands the native binary answers on Windows print what the Node CLI printed there.
//!
//! `tests/fixtures/windows-node/` holds the bytes the Node CLI wrote on Windows, and its exit status, for each command
//! of a group's `cases.json` in each environment of `environments.json`, produced by `capture.mjs` (nothing in it is
//! typed by hand). Colour is the part that differs from unix: with no terminal, Node on Windows paints the output
//! unless a variable, a flag or a dumb `TERM` turns it off, whatever else the environment says. Paths differ too: Node
//! prints them with `/` and a capital drive letter. Each case runs the binary in a copy of the group's workspace, with
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

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// The path of `workspace` as the captured output spells it: `/` for `\` and a capital drive letter.
fn printed(workspace: &Path) -> String {
    let text = workspace.to_str().unwrap().replace('\\', "/");

    format!("{}{}", text[..1].to_uppercase(), &text[1..])
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

fn variables(object: &Value) -> Vec<(String, String)> {
    object.as_object().unwrap().iter().map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned())).collect()
}

#[test]
fn the_binary_prints_what_node_printed_on_windows() {
    let directory = fixtures().join("windows-node");
    let environments = read_json(&directory.join("environments.json"));
    let mut checked = 0;

    for group in fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_dir() && entry.file_name() != "workspaces")
    {
        let name = group.file_name().to_string_lossy().into_owned();
        let cases = read_json(&group.path().join("cases.json"));
        let statuses = read_json(&group.path().join("status.json"));
        let workspace = std::env::temp_dir().join(format!("vis-windows-parity-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&workspace);
        copy_tree(&fixtures().join(cases["workspace"].as_str().unwrap()), &workspace);

        for command in cases["commands"].as_array().unwrap() {
            let args: Vec<String> =
                command.as_array().unwrap().iter().map(|word| word.as_str().unwrap().to_owned()).collect();

            for (environment_name, values) in environments["environments"].as_object().unwrap() {
                let environment = variables(values);
                let stem = format!("{}__{environment_name}", slug(&args));
                let label = format!("{name}: vis {} in `{environment_name}`", args.join(" "));
                let expected = fs::read_to_string(group.path().join(format!("{stem}.out")))
                    .unwrap()
                    .replace("{workspace}", &printed(&workspace));
                let status = statuses.get(&stem).map_or(0, |status| status.as_i64().unwrap());

                let piped = run(&workspace, &args, &environment, Stdio::piped());

                assert_eq!(String::from_utf8_lossy(&piped.stderr), "", "{label}: stderr");
                assert_eq!(piped.status.code(), Some(i32::try_from(status).unwrap()), "{label}: status");
                assert_eq!(String::from_utf8_lossy(&piped.stdout), expected, "{label}: piped stdout");

                let path = workspace.join("stdout.txt");
                let file = run(&workspace, &args, &environment, Stdio::from(File::create(&path).unwrap()));

                assert_eq!(file.status.code(), piped.status.code(), "{label}: status into a file");
                assert_eq!(String::from_utf8_lossy(&fs::read(&path).unwrap()), expected, "{label}: stdout in a file");
                fs::remove_file(&path).unwrap();

                checked += 1;
            }
        }

        let _ = fs::remove_dir_all(&workspace);
    }

    // Four groups of 7, 3, 4 and 6 commands, in 9 environments each.
    assert_eq!(checked, 180);
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
        for command in [["list"], ["graph"], ["status"]] {
            let output = run(&workspace, &command.map(str::to_owned), &environment, Stdio::piped());

            assert!(
                !String::from_utf8_lossy(&output.stdout).contains("alpha") && output.status.code() != Some(0),
                "vis {} answered with {environment:?}: {}",
                command[0],
                String::from_utf8_lossy(&output.stdout)
            );
        }
    }

    let _ = fs::remove_dir_all(&workspace);
}
