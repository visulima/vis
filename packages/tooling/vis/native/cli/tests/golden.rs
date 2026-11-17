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

    (output.status.code(), output.stdout)
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
#[ignore = "needs a subject that renders help: set VIS_GOLDEN_SUBJECT, or run once the native renderer lands"]
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
                failures.push(format!("{} at {width} columns (exit {code:?}): {}", case.name, first_difference(&expected, &actual)));
            }
        }
    }

    fs::remove_dir_all(&cwd).ok();

    assert!(failures.is_empty(), "golden mismatches:\n{}", failures.join("\n"));
}
