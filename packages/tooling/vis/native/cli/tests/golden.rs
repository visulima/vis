//! Golden tests for the help surface: the bytes `vis` prints for bare `vis`,
//! `--help`, `<command> --help`, `help <command>` and `--version` must equal the
//! stored captures in `tests/golden/`, at two terminal widths, with and without
//! colour.
//!
//! The captures come from a reference `vis` (the Node CLI at a pinned version)
//! run in an empty project with a fixed environment. To regenerate them, point
//! `VIS_REFERENCE_CLI` at that reference executable and set `VIS_UPDATE_GOLDEN=1`.
//!
//! The subject under test is `VIS_GOLDEN_SUBJECT` when set (to prove the harness
//! against the reference itself), otherwise the native binary built by Cargo.
//!
//! A second, on-demand test (`every_command_help_matches_reference`) compares the
//! subject against the reference for every command in the generated manifest.
//! It needs `VIS_REFERENCE_CLI` and is skipped without it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Version the stored captures were taken from. The subject is told the same
/// version through `VIS_VERSION`, so the `vis v<version>` banner is stable.
const GOLDEN_VERSION: &str = "6.6.0";

const WIDTHS: [u32; 2] = [80, 120];

struct Case {
    name: &'static str,
    args: &'static [&'static str],
    color: bool,
}

const CASES: &[Case] = &[
    Case { name: "bare", args: &[], color: true },
    Case { name: "help", args: &["--help"], color: true },
    Case { name: "help-plain", args: &["--help"], color: false },
    Case { name: "install-help", args: &["install", "--help"], color: true },
    Case { name: "cache-list-help", args: &["cache", "list", "--help"], color: true },
    Case { name: "release-help", args: &["release", "--help"], color: true },
    Case { name: "help-exec", args: &["help", "exec"], color: true },
    Case { name: "help-cache", args: &["help", "cache"], color: true },
    Case { name: "version", args: &["--version"], color: true },
];

fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden")
}

/// A throwaway project directory holding only a `package.json`.
fn fixture(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vis-golden-{}-{tag}", std::process::id()));

    fs::create_dir_all(&dir).expect("create fixture dir");
    fs::write(dir.join("package.json"), "{\"name\":\"t\"}").expect("write package.json");

    dir
}

/// Run `exe` the way the goldens were captured: hermetic colour and width
/// environment, nag output off, stdout only.
fn capture(exe: &Path, args: &[&str], color: bool, width: u32, cwd: &Path) -> (Option<i32>, Vec<u8>) {
    let (code, stdout, _) = capture_streams(exe, args, color, width, cwd);

    (code, stdout)
}

/// As `capture`, with stderr as well.
fn capture_streams(exe: &Path, args: &[&str], color: bool, width: u32, cwd: &Path) -> (Option<i32>, Vec<u8>, Vec<u8>) {
    let mut command = Command::new(exe);

    command
        .args(args)
        .current_dir(cwd)
        .env_remove("NO_COLOR")
        .env_remove("FORCE_COLOR")
        .env_remove("LINES")
        .env_remove("CEREBRO_TERMINAL_WIDTH")
        .env("COLUMNS", width.to_string())
        .env("VIS_VERSION", GOLDEN_VERSION)
        .env("VIS_NO_UPDATE_CHECK", "1")
        .env("VIS_NO_SPONSOR", "1")
        .env("VIS_NO_MCP_PROMOTE", "1")
        .env("NO_UPDATE_NOTIFIER", "1");

    if color {
        command.env("FORCE_COLOR", "1");
    }

    let output = command.output().unwrap_or_else(|error| panic!("run {}: {error}", exe.display()));

    (output.status.code(), output.stdout, output.stderr)
}

fn subject() -> PathBuf {
    std::env::var_os("VIS_GOLDEN_SUBJECT").map_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_vis")), PathBuf::from)
}

fn reference() -> Option<PathBuf> {
    std::env::var_os("VIS_REFERENCE_CLI").map(PathBuf::from)
}

fn golden_path(case: &Case, width: u32) -> PathBuf {
    golden_dir().join(format!("{}-{width}.txt", case.name))
}

/// First line where two captures differ, for a readable failure.
fn first_difference(expected: &[u8], actual: &[u8]) -> String {
    let expected = String::from_utf8_lossy(expected);
    let actual = String::from_utf8_lossy(actual);

    for (index, (left, right)) in expected.lines().zip(actual.lines()).enumerate() {
        if left != right {
            return format!("line {}:\n  expected: {left:?}\n  actual:   {right:?}", index + 1);
        }
    }

    format!("line counts differ: expected {}, actual {}", expected.lines().count(), actual.lines().count())
}

#[test]
fn help_output_matches_goldens() {
    let cwd = fixture("goldens");
    let update = std::env::var_os("VIS_UPDATE_GOLDEN").is_some();
    let reference = reference();
    let mut failures = Vec::new();

    for case in CASES {
        for width in WIDTHS {
            let path = golden_path(case, width);

            if update {
                let reference = reference.as_ref().expect("VIS_UPDATE_GOLDEN needs VIS_REFERENCE_CLI");
                let (code, stdout) = capture(reference, case.args, case.color, width, &cwd);

                assert_eq!(code, Some(0), "reference failed for {} at {width}", case.name);
                fs::create_dir_all(golden_dir()).expect("create golden dir");
                fs::write(&path, stdout).expect("write golden");

                continue;
            }

            let expected = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            let (code, actual) = capture(&subject(), case.args, case.color, width, &cwd);

            if code != Some(0) || actual != expected {
                failures.push(format!(
                    "{} at {width} columns (exit {code:?}): {}",
                    case.name,
                    first_difference(&expected, &actual)
                ));
            }
        }
    }

    fs::remove_dir_all(&cwd).ok();

    assert!(failures.is_empty(), "golden mismatches:\n{}", failures.join("\n"));
}

/// `vis cache` has no command of its own: its `--help` and `-h` print the stored `help cache` capture
/// on stdout and exit 0. The bare group prints it on stderr, leaving stdout empty, and exits 1, as the
/// other bare command groups do.
#[test]
fn cache_group_help_matches_the_help_cache_golden() {
    let cwd = fixture("cache-group");
    let mut failures = Vec::new();

    for (args, expected_code, on_stdout) in [
        (&["cache", "--help"][..], 0, true),
        (&["cache", "-h"], 0, true),
        (&["cache"], 1, false),
        (&["-v", "cache", "-h"], 0, true),
    ] {
        for width in WIDTHS {
            let path = golden_dir().join(format!("help-cache-{width}.txt"));
            let golden = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            let (code, stdout, stderr) = capture_streams(&subject(), args, true, width, &cwd);
            let (listing, silent) = if on_stdout { (stdout, stderr) } else { (stderr, stdout) };

            if code != Some(expected_code) || listing != golden || !silent.is_empty() {
                failures.push(format!(
                    "{args:?} at {width} columns (exit {code:?}, want {expected_code}): {}",
                    first_difference(&golden, &listing)
                ));
            }
        }
    }

    fs::remove_dir_all(&cwd).ok();

    assert!(failures.is_empty(), "cache group help differs from the golden:\n{}", failures.join("\n"));
}

/// Commands whose `--help` is forwarded to the package manager or tool they run (the
/// native front-end already did this before it rendered help), so only `help <name>`
/// is comparable. `dedupe --help` in particular really runs `<pm> dedupe`.
const TOOL_FLAG_COMMANDS: &[&str] = &["exec", "x", "pm", "remove", "dedupe", "link", "unlink", "outdated", "why"];

/// Every command in the generated manifest: its `--help` (or `help <name>` for the
/// commands whose `--help` belongs to the tool they run).
fn every_command_invocation() -> Vec<Vec<String>> {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../src/manifest.json")).expect("manifest parses");
    let mut invocations = Vec::new();

    for command in manifest["commands"].as_array().expect("commands array") {
        let mut words: Vec<String> = command["commandPath"]
            .as_array()
            .map(|path| path.iter().filter_map(|word| word.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        let name = command["name"].as_str().expect("command name").to_owned();

        words.push(name.clone());

        if words.len() == 1 && TOOL_FLAG_COMMANDS.contains(&name.as_str()) {
            invocations.push(vec!["help".to_owned(), name]);
        } else {
            words.push("--help".to_owned());
            invocations.push(words);
        }
    }

    invocations
}

#[test]
fn every_command_help_matches_reference() {
    let Some(reference) = reference() else {
        eprintln!("skipped: set VIS_REFERENCE_CLI to compare every command against a reference CLI");

        return;
    };

    let cwd = fixture("every-command");
    let invocations = every_command_invocation();
    let subject = subject();
    let failures = std::sync::Mutex::new(Vec::new());
    let next = std::sync::atomic::AtomicUsize::new(0);

    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

                let Some(args) = invocations.get(index) else { break };
                let args: Vec<&str> = args.iter().map(String::as_str).collect();

                for width in WIDTHS {
                    let (expected_code, expected) = capture(&reference, &args, true, width, &cwd);
                    let (code, actual) = capture(&subject, &args, true, width, &cwd);

                    if code != expected_code || actual != expected {
                        failures.lock().unwrap().push(format!(
                            "{} at {width}: exit {code:?} vs {expected_code:?}, {}",
                            args.join(" "),
                            first_difference(&expected, &actual)
                        ));
                    }
                }
            });
        }
    });

    fs::remove_dir_all(&cwd).ok();

    let failures = failures.into_inner().unwrap();

    assert!(
        failures.is_empty(),
        "{} of {} command helps differ from the reference:\n{}",
        failures.len(),
        invocations.len(),
        failures.join("\n")
    );
}
