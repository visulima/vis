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

    for group in fs::read_dir(&directory).unwrap().map(|entry| entry.unwrap()).filter(|entry| {
        entry.file_type().unwrap().is_dir() && entry.file_name() != "workspaces" && entry.file_name() != "run"
    }) {
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

// ---------------------------------------------------------------------------------------------------------------
// `vis run <target>` in which every task is a cache hit.
//
// `fixtures/windows-node/run/<case>/` holds what the Node CLI did on Windows (`capture-run.mjs`): the cache its cold
// run wrote, and for each environment its stdout and the `.vis/last-summary.json` of the run in which every task hit.
// Each case here copies the workspace, puts that cache in place and runs the binary the way the launcher starts it.
// What Node varies on its own is masked and nothing else: durations, the time stamps and the run id of the summary,
// the seconds GitLab prints, and the order in which the finished tasks (and their output) are printed, which follows
// how the lookups happen to end; the lines that start tasks, the header and the footer are compared in order.
// ---------------------------------------------------------------------------------------------------------------

/// `text` without the colour codes (`ESC [ ... m`).
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();

    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek() == Some(&'[') {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(character);
        }
    }

    out
}

/// Replaces the run of ASCII digits after each `before` with `placeholder`.
fn mask_digits_after(text: &str, before: &str, placeholder: &str) -> String {
    let mut out = String::new();
    let mut rest = text;

    while let Some(at) = rest.find(before) {
        let (head, tail) = rest.split_at(at + before.len());
        let digits = tail.bytes().take_while(u8::is_ascii_digit).count();

        out.push_str(head);
        out.push_str(placeholder);
        rest = &tail[digits..];
    }

    out.push_str(rest);

    out
}

/// `(<n> ms)`, `Took <time>`, the seconds of `<n> cached · <s>s` and the Unix seconds of a GitLab section.
fn mask_times(text: &str) -> String {
    let mut out = String::new();

    for line in text.split_inclusive('\n') {
        let mut line = line.to_owned();

        if let Some(open) = line.find('(') {
            if let Some(length) = line[open..].find(" ms)") {
                let inner = &line[open + 1..open + length];

                if !inner.is_empty() && inner.bytes().all(|byte| byte.is_ascii_digit()) {
                    line.replace_range(open + 1..open + length, "N");
                }
            }
        }

        if let Some(at) = line.find("Took ") {
            let end = line[at..].find(['\u{1b}', '\n']).map_or(line.len(), |end| at + end);

            line.replace_range(at + "Took ".len()..end, "T");
        }

        if let Some(at) = line.find("cached \u{b7} ") {
            let from = at + "cached \u{b7} ".len();
            let end = line[from..].find(['s', '\n']).map_or(line.len(), |end| from + end);

            line.replace_range(from..end, "T");
        }

        out.push_str(&mask_digits_after(&mask_digits_after(&line, "section_start:", "T"), "section_end:", "T"));
    }

    out
}

/// What of a run's stdout Node does not vary: the header, the lines that start tasks (in order), the lines and blocks
/// that finish them (as a sorted list), and the footer.
#[derive(Debug, PartialEq, Eq)]
struct Shape {
    header: String,
    starts: Vec<String>,
    finishes: Vec<String>,
    footer: String,
}

fn shape_of(stdout: &str) -> Shape {
    let masked = mask_times(stdout);
    let lines: Vec<&str> = masked.split_inclusive('\n').collect();
    let closing = lines.iter().rposition(|line| plain(line).contains("Successfully ran")).expect("closing banner");
    let first_start = lines.iter().position(|line| plain(line).starts_with("> ")).expect("a task starts");
    let mut starts = Vec::new();
    let mut finishes: Vec<String> = Vec::new();

    // The line before the closing banner is the blank one that ends the last block.
    for &line in &lines[first_start..closing - 1] {
        let text = plain(line);

        if text.starts_with("> ") {
            starts.push(line.to_owned());
        } else if text.contains("[cache] (N ms)") || finishes.is_empty() {
            finishes.push(line.to_owned());
        } else {
            finishes.last_mut().expect("a finish").push_str(line);
        }
    }

    finishes.sort();

    Shape { header: lines[..first_start].concat(), starts, finishes, footer: lines[closing - 1..].concat() }
}

/// `.vis/last-summary.json` with what changes from run to run replaced: `duration`, `startTime`, `endTime` and the
/// run `id`. The rest, the key order, the indentation and the missing final newline included, is compared as written.
fn mask_summary(text: &str) -> String {
    text.split_inclusive('\n')
        .map(|line| {
            let trimmed = line.trim_start();

            for key in ["\"duration\"", "\"startTime\"", "\"endTime\"", "\"id\""] {
                if trimmed.starts_with(&format!("{key}: ")) {
                    let indent = &line[..line.len() - trimmed.len()];
                    let comma = if line.trim_end().ends_with(',') { "," } else { "" };
                    let newline = if line.ends_with('\n') { "\n" } else { "" };

                    return format!("{indent}{key}: MASKED{comma}{newline}");
                }
            }

            line.to_owned()
        })
        .collect()
}

/// Every file below `directory` as `(relative path, bytes)`, sorted.
fn tree(directory: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(base: &Path, current: &Path, into: &mut Vec<(String, Vec<u8>)>) {
        for entry in fs::read_dir(current).unwrap() {
            let entry = entry.unwrap();

            if entry.file_type().unwrap().is_dir() {
                walk(base, &entry.path(), into);
            } else {
                let relative = entry.path().strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");

                into.push((relative, fs::read(entry.path()).unwrap()));
            }
        }
    }

    let mut files = Vec::new();

    walk(directory, directory, &mut files);
    files.sort();

    files
}

/// A copy of a run fixture's workspace with the cache the cold Node run wrote and the marker an install leaves (newer
/// than the lockfile, which the lockfile preflight reads).
fn run_workspace(case: &Value, name: &str, tag: &str) -> PathBuf {
    let workspace = std::env::temp_dir().join(format!("vis-windows-run-{name}-{tag}-{}", std::process::id()));

    let _ = fs::remove_dir_all(&workspace);
    copy_tree(&fixtures().join(case["workspace"].as_str().unwrap()), &workspace);
    copy_tree(
        &fixtures().join("windows-node/run").join(name).join("cache"),
        &workspace.join("node_modules/.cache/vis"),
    );

    let marker = workspace.join("node_modules/.modules.yaml");

    fs::write(&marker, "layoutVersion: 5\n").unwrap();
    File::options()
        .write(true)
        .open(&marker)
        .unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
        .unwrap();

    workspace
}

/// The binary as the JS launcher starts it for `vis run <target>`.
fn run_as_launched(workspace: &Path, node_version: &str, environment: &[(String, String)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vis"));

    command
        .args(["run", "build"])
        .current_dir(workspace)
        .env_clear()
        // `PATH` is how a linked worktree's main checkout is found (the binary runs `git`); the launcher passes it on.
        .envs(
            std::env::vars()
                .filter(|(name, _)| ["SystemRoot", "PATH"].iter().any(|keep| name.eq_ignore_ascii_case(keep))),
        )
        .env("VIS_HANDOFF", "launcher")
        .env("VIS_HANDBACK_STATUS", "75")
        .env("VIS_LAUNCHER", "node")
        .env("VIS_VERSION", "0.0.0-test")
        .env("VIS_NODE_VERSION", node_version)
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    command.output().expect("run binary")
}

#[test]
fn a_run_in_which_every_task_hits_prints_and_writes_what_node_did_on_windows() {
    let directory = fixtures().join("windows-node");
    let mut environments = read_json(&directory.join("environments.json"))["environments"].as_object().unwrap().clone();

    environments
        .extend(read_json(&directory.join("run/environments.json"))["environments"].as_object().unwrap().clone());

    let cases = read_json(&directory.join("run/cases.json"));
    let mut checked = 0;

    for case in cases["cases"].as_array().unwrap().iter().filter(|case| case["native"] != false) {
        let name = case["name"].as_str().unwrap();
        let statuses = read_json(&directory.join("run").join(name).join("status.json"));

        assert_eq!(statuses, serde_json::json!({}), "{name}: Node exited with something but 0");

        for (environment_name, values) in &environments {
            let label = format!("run {name} in `{environment_name}`");
            let captured = directory.join("run").join(name);
            let expected_stdout = fs::read_to_string(captured.join(format!("{environment_name}.out"))).unwrap();
            let expected_summary =
                fs::read_to_string(captured.join(format!("{environment_name}.summary.json"))).unwrap();
            let node_version = read_json(&captured.join(format!("{environment_name}.summary.json")))["environment"]
                ["nodeVersion"]
                .as_str()
                .unwrap()
                .to_owned();
            let workspace = run_workspace(case, name, environment_name);
            let before = tree(&workspace);

            let output = run_as_launched(&workspace, &node_version, &variables(values));

            assert_eq!(String::from_utf8_lossy(&output.stderr), "", "{label}: stderr");
            assert_eq!(output.status.code(), Some(0), "{label}: status");

            let stdout = String::from_utf8(output.stdout).unwrap();

            assert_eq!(shape_of(&stdout), shape_of(&expected_stdout), "{label}: stdout\n{stdout}");

            let summary = fs::read_to_string(workspace.join(".vis/last-summary.json")).unwrap();

            assert_eq!(mask_summary(&summary), mask_summary(&expected_summary), "{label}: .vis/last-summary.json");

            // The only file the run touches is the summary; the cache and everything else stay as they were.
            let after: Vec<_> =
                tree(&workspace).into_iter().filter(|(path, _)| path != ".vis/last-summary.json").collect();

            assert!(before == after, "{label}: the run changed a file besides the summary");

            let _ = fs::remove_dir_all(&workspace);
            checked += 1;
        }
    }

    // Three workspaces, in the nine shared environments and the six of the run.
    assert_eq!(checked, 45);
}

/// The task cache lives at the main checkout's root, so a run from a linked worktree reads the cache of the checkout it
/// was made from. The Node CLI, run by hand on Windows in the same two layouts, hit the same entries; here the binary has
/// to find them as well, from both a primary checkout (`.git` is a directory) and a linked worktree (`.git` is a file
/// naming a `gitdir`, which the binary resolves through `git`).
#[test]
fn a_run_reads_the_task_cache_of_the_main_checkout_from_a_linked_worktree() {
    let directory = fixtures().join("windows-node");
    let cases = read_json(&directory.join("run/cases.json"));
    let case = &cases["cases"][1];
    let name = case["name"].as_str().unwrap();
    let expected = fs::read_to_string(directory.join("run").join(name).join("ci.out")).unwrap();
    let node_version = read_json(&directory.join("run").join(name).join("ci.summary.json"))["environment"]
        ["nodeVersion"]
        .as_str()
        .unwrap()
        .to_owned();
    let base = std::env::temp_dir().join(format!("vis-windows-run-git-{}", std::process::id()));
    let main = base.join("main");
    let linked = base.join("linked");

    let _ = fs::remove_dir_all(&base);
    copy_tree(&fixtures().join(case["workspace"].as_str().unwrap()), &main);

    let git = |directory: &Path, args: &[&str]| {
        let output = Command::new("git")
            .args(["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.test"])
            .args(args)
            .current_dir(directory)
            .output()
            .expect("run git");

        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    };

    git(&main, &["init", "-q", "."]);
    git(&main, &["add", "-A"]);
    git(&main, &["commit", "-q", "-m", "init"]);
    git(&main, &["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "side"]);
    assert!(linked.join(".git").is_file(), "the worktree's .git is a file");

    copy_tree(&directory.join("run").join(name).join("cache"), &main.join("node_modules/.cache/vis"));

    for checkout in [&main, &linked] {
        fs::create_dir_all(checkout.join("node_modules")).unwrap();

        let marker = checkout.join("node_modules/.modules.yaml");

        fs::write(&marker, "layoutVersion: 5\n").unwrap();
        File::options()
            .write(true)
            .open(&marker)
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
            .unwrap();
    }

    let ci = [("CI".to_owned(), "1".to_owned())];

    for (label, checkout) in [("a primary checkout", &main), ("a linked worktree", &linked)] {
        let output = run_as_launched(checkout, &node_version, &ci);

        assert_eq!(String::from_utf8_lossy(&output.stderr), "", "{label}: stderr");
        assert_eq!(output.status.code(), Some(0), "{label}: status");
        assert_eq!(shape_of(&String::from_utf8(output.stdout).unwrap()), shape_of(&expected), "{label}: stdout");
    }

    assert!(!linked.join("node_modules/.cache").exists(), "the worktree has no cache of its own");

    // A changed file in the worktree is a miss there, and the run is handed back.
    fs::write(linked.join("packages/alpha/src/index.ts"), "export const changed = true;\n").unwrap();

    let output = run_as_launched(&linked, &node_version, &ci);

    assert_eq!(output.status.code(), Some(75), "a changed worktree: status");
    assert_eq!(String::from_utf8_lossy(&output.stdout), "", "a changed worktree: stdout");

    let _ = fs::remove_dir_all(&base);
}

/// Everything the binary does not answer is Node's: it prints and writes nothing and hands the run back with the
/// status the launcher listens for.
#[test]
fn a_run_with_a_miss_or_a_context_it_does_not_answer_is_handed_back_untouched() {
    let directory = fixtures().join("windows-node");
    let cases = read_json(&directory.join("run/cases.json"));
    let case = &cases["cases"][1];
    let name = case["name"].as_str().unwrap();
    let node_version = "v26.13.1";
    let ci = vec![("CI".to_owned(), "1".to_owned())];
    let pair = |name: &str, value: &str| (name.to_owned(), value.to_owned());

    let handed_back = |label: &str, workspace: &Path, environment: &[(String, String)]| {
        let before = tree(workspace);
        let output = run_as_launched(workspace, node_version, environment);

        assert_eq!(output.status.code(), Some(75), "{label}: status");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "", "{label}: stdout");
        assert_eq!(String::from_utf8_lossy(&output.stderr), "", "{label}: stderr");
        assert!(before == tree(workspace), "{label}: the run changed a file");
        assert!(!workspace.join(".vis").exists(), "{label}: wrote .vis");
    };

    // A source file changed: its task is a miss.
    let workspace = run_workspace(case, name, "miss");

    fs::write(workspace.join("packages/gamma/src/index.ts"), "export const changed = true;\n").unwrap();
    handed_back("a changed source", &workspace, &ci);

    // A cache entry removed.
    let workspace = run_workspace(case, name, "removed");
    let entry = fs::read_dir(workspace.join("node_modules/.cache/vis")).unwrap().next().unwrap().unwrap().path();

    fs::remove_dir_all(entry).unwrap();
    handed_back("a removed entry", &workspace, &ci);

    // No cache directory at all.
    let workspace = run_workspace(case, name, "no-cache");

    fs::remove_dir_all(workspace.join("node_modules/.cache")).unwrap();
    handed_back("no cache directory", &workspace, &ci);

    // The install is older than the lockfile.
    let workspace = run_workspace(case, name, "stale");

    fs::remove_file(workspace.join("node_modules/.modules.yaml")).unwrap();
    handed_back("no install marker", &workspace, &ci);

    // A toolchain pin is not asked of a process on Windows.
    let workspace = run_workspace(case, name, "pin");

    fs::write(
        workspace.join("package.json"),
        "{\"name\":\"order-root\",\"private\":true,\"packageManager\":\"pnpm@10.0.0\"}\n",
    )
    .unwrap();
    handed_back("a packageManager pin", &workspace, &ci);

    // The shapes whose print order Node decides in a way the binary does not reproduce (`order`: ids and directories in
    // different orders, which Node starts by id and lists in NTFS order; `chain`: projects that depend on each other,
    // which Node starts first).
    let not_native: Vec<_> = cases["cases"].as_array().unwrap().iter().filter(|case| case["native"] == false).collect();

    assert_eq!(not_native.len(), 2);

    for case in not_native {
        let name = case["name"].as_str().unwrap();

        handed_back(name, &run_workspace(case, name, "not-native"), &ci);
    }

    // Variables that send a run to Node.
    for (variable, value) in [
        ("TURBO_API", "https://example.test"),
        ("VIS_CACHE_DIRECTORY", "x"),
        ("DEBUG", "vis"),
        ("NODE_ENV", "test"),
        ("VIS_RUN_CONCURRENCY_LIMIT", "2"),
        ("CEREBRO_OUTPUT_LEVEL", "1"),
    ] {
        let workspace = run_workspace(case, name, "variable");
        let mut environment = ci.clone();

        environment.push(pair(variable, value));
        handed_back(variable, &workspace, &environment);
    }

    // Outside CI, and with a colour variable Node's runtime warns about.
    let workspace = run_workspace(case, name, "no-ci");

    handed_back("no CI", &workspace, &[]);
    handed_back("CI=0", &workspace, &[pair("CI", "0")]);
    handed_back(
        "FORCE_COLOR with NO_COLOR",
        &workspace,
        &[pair("CI", "1"), pair("FORCE_COLOR", "1"), pair("NO_COLOR", "1")],
    );

    // A start without the launcher cannot tell Node's version, and has no launcher to hand the run back to.
    let workspace = run_workspace(case, name, "bare");
    let output = Command::new(env!("CARGO_BIN_EXE_vis"))
        .args(["run", "build"])
        .current_dir(&workspace)
        .env_clear()
        .envs(std::env::vars().filter(|(name, _)| name.eq_ignore_ascii_case("SystemRoot")))
        .env("CI", "1")
        .stdin(Stdio::null())
        .output()
        .expect("run binary");

    assert_eq!(String::from_utf8_lossy(&output.stdout), "", "a bare start: stdout");
    assert!(!workspace.join(".vis").exists(), "a bare start wrote .vis");

    // A flag or another argument is not the shape.
    let workspace = run_workspace(case, name, "flag");

    for args in [vec!["run", "build", "--parallel=1"], vec!["run", "build", "extra"], vec!["run"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_vis"))
            .args(&args)
            .current_dir(&workspace)
            .env_clear()
            .envs(std::env::vars().filter(|(name, _)| name.eq_ignore_ascii_case("SystemRoot")))
            .env("CI", "1")
            .env("VIS_HANDOFF", "launcher")
            .env("VIS_HANDBACK_STATUS", "75")
            .env("VIS_NODE_VERSION", node_version)
            .stdin(Stdio::null())
            .output()
            .expect("run binary");

        assert_eq!(String::from_utf8_lossy(&output.stdout), "", "{args:?}: stdout");
        assert!(!workspace.join(".vis").exists(), "{args:?} wrote .vis");
    }
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
