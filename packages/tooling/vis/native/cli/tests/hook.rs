//! Integration tests for the native `vis hook run` fast path.
//!
//! Each test builds a throwaway git repo with staged files and a
//! `.vis/hooks/config.json`, then drives the compiled binary. Anything the fast
//! path declines must reach the Node CLI untouched, so the delegation tests point
//! `VIS_NODE` / `VIS_FALLBACK_ENTRY` at a stub that just reports it was called.
//! Parity with the Node runner is pinned separately by
//! `__tests__/native/hook-run-parity.test.ts`.

#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Repo {
    root: PathBuf,
}

impl Repo {
    fn new(name: &str) -> Repo {
        let root = std::env::temp_dir().join(format!("vis-hook-{}-{name}", std::process::id()));

        fs::remove_dir_all(&root).ok();
        fs::create_dir_all(root.join(".vis/hooks")).expect("mkdir");
        git(&root, &["init", "-q", "."]);
        git(&root, &["config", "user.email", "t@example.com"]);
        git(&root, &["config", "user.name", "t"]);

        Repo { root }
    }

    fn file(&self, path: &str, content: &str) -> &Repo {
        let full = self.root.join(path);

        fs::create_dir_all(full.parent().expect("parent")).expect("mkdir");
        fs::write(&full, content).expect("write");
        git(&self.root, &["add", path]);

        self
    }

    fn config(&self, json: &str) -> &Repo {
        fs::write(self.root.join(".vis/hooks/config.json"), json).expect("write config");

        self
    }

    /// Run `vis <args>`; the stub Node entry answers `DELEGATED <args>` for anything not handled natively.
    fn vis(&self, args: &[&str]) -> Output {
        let stub = self.root.join("stub-entry.sh");

        fs::write(&stub, "echo \"DELEGATED $*\"\n").expect("write stub");

        Command::new(env!("CARGO_BIN_EXE_vis"))
            .args(args)
            .current_dir(&self.root)
            .env("VIS_NODE", "sh")
            .env("VIS_FALLBACK_ENTRY", &stub)
            .env_remove("VIS_HOOK_TRACE")
            .output()
            .expect("run binary")
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.root.join(path)).expect("read")
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).ok();
    }
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git").args(args).current_dir(dir).status().expect("git");

    assert!(status.success(), "git {args:?} failed");
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn builtin_fixer_rewrites_the_file_and_fails_the_stage() {
    let repo = Repo::new("fixer");

    repo.file("a.ts", "a  \nb\t\n")
        .config(r#"{"version":1,"stages":{"pre-commit":[{"id":"tw","builtin":"trailing-whitespace"}]}}"#);

    let output = repo.vis(&["hook", "run", "pre-commit"]);

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(stdout(&output), "Running pre-commit\nFixing a.ts\n");
    assert!(stderr(&output).contains("Error: Hook stage exited with code 1"), "{}", stderr(&output));
    assert_eq!(repo.read("a.ts"), "a\nb\n");
}

#[test]
fn clean_files_pass() {
    let repo = Repo::new("clean");

    repo.file("a.ts", "a\n").config(
        r#"{"version":1,"stages":{"pre-commit":[{"id":"tw","builtin":"trailing-whitespace"},{"id":"eof","builtin":"end-of-file-fixer"},{"id":"mle","builtin":"mixed-line-ending"},{"id":"mc","builtin":"check-merge-conflict"}]}}"#,
    );

    let output = repo.vis(&["hook", "run", "pre-commit"]);

    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(stdout(&output), "Running pre-commit\n");
}

#[test]
fn entry_receives_only_the_files_its_pattern_keeps() {
    let repo = Repo::new("filter");

    repo.file("a.ts", "x\n")
        .file("b.md", "x\n")
        .file("c.ts", "x\n")
        .config(r#"{"version":1,"stages":{"pre-commit":[{"id":"ts","entry":"echo","files":"\\.ts$"}]}}"#);

    let output = repo.vis(&["hook", "run", "pre-commit"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout(&output), "Running pre-commit\na.ts c.ts\n");
}

#[test]
fn hook_without_matching_files_is_skipped_unless_always_run() {
    let repo = Repo::new("skip");

    repo.file("a.ts", "x\n")
        .config(r#"{"version":1,"stages":{"pre-commit":[{"id":"a","entry":"echo skipped","files":"nomatch"},{"id":"b","entry":"echo ran","files":"nomatch","alwaysRun":true}]}}"#);

    let output = repo.vis(&["hook", "run", "pre-commit"]);

    assert_eq!(stdout(&output), "Running pre-commit\nran\n");
}

#[test]
fn failing_entries_or_fold_their_exit_codes_and_fail_fast_stops_early() {
    let repo = Repo::new("failfast");

    repo.file("a.ts", "x\n")
        .config(r#"{"version":1,"stages":{"pre-commit":[{"id":"a","entry":"sh -c 'exit 2'","passFilenames":false},{"id":"b","entry":"echo second"}]}}"#);

    let all = repo.vis(&["hook", "run", "pre-commit"]);

    assert_eq!(all.status.code(), Some(1));
    assert!(stdout(&all).contains("second"));

    repo.config(r#"{"version":1,"failFast":true,"stages":{"pre-commit":[{"id":"a","entry":"sh -c 'exit 2'","passFilenames":false},{"id":"b","entry":"echo second"}]}}"#);

    let fast = repo.vis(&["hook", "run", "pre-commit"]);

    assert_eq!(fast.status.code(), Some(1));
    assert!(!stdout(&fast).contains("second"));
}

#[test]
fn fail_entry_prints_its_message() {
    let repo = Repo::new("fail");

    repo.file("a.ts", "x\n").config(r#"{"version":1,"stages":{"pre-commit":[{"id":"no","fail":"do not use this"}]}}"#);

    let output = repo.vis(&["hook", "run", "pre-commit"]);

    assert_eq!(output.status.code(), Some(1));
    assert!(stdout(&output).contains("do not use this"));
}

#[test]
fn stage_without_hooks_exits_cleanly() {
    let repo = Repo::new("nostage");

    repo.config(r#"{"version":1,"stages":{"pre-commit":[{"id":"a","entry":"true"}]}}"#);

    let output = repo.vis(&["hook", "run", "pre-push"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout(&output), "No hooks configured for stage \"pre-push\".\n");
}

#[test]
fn git_arg_stages_forward_their_arguments_instead_of_files() {
    let repo = Repo::new("gitargs");

    repo.file("a.ts", "x\n").config(r#"{"version":1,"stages":{"commit-msg":[{"id":"m","entry":"echo \"$1\""}]}}"#);

    // With no file set the entry is not given `"$@"` appended, so it reads git's argument itself.
    let output = repo.vis(&["hook", "run", "commit-msg", "MSGFILE"]);

    assert_eq!(stdout(&output), "Running commit-msg\nMSGFILE\n");
}

#[test]
fn types_filter_uses_the_file_classifier() {
    let repo = Repo::new("types");

    repo.file("a.json", "{}\n")
        .file("b.md", "x\n")
        .config(r#"{"version":1,"stages":{"pre-commit":[{"id":"j","entry":"echo","types":["json"]}]}}"#);

    let output = repo.vis(&["hook", "run", "pre-commit"]);

    assert_eq!(stdout(&output), "Running pre-commit\na.json\n");
}

/// Everything below must reach Node untouched and run nothing natively.
fn assert_delegated(repo: &Repo, args: &[&str], expected: &str) {
    let output = repo.vis(args);

    assert_eq!(stdout(&output), expected, "stderr: {}", stderr(&output));
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn unsupported_shapes_are_delegated_to_node() {
    let repo = Repo::new("delegate");

    repo.file("a.ts", "x\n");

    // no config
    assert_delegated(&repo, &["hook", "run", "pre-commit"], "DELEGATED hook run pre-commit\n");

    // unknown flag
    repo.config(r#"{"version":1,"stages":{"pre-commit":[{"id":"a","entry":"true"}]}}"#);
    assert_delegated(&repo, &["hook", "run", "pre-commit", "--bogus"], "DELEGATED hook run pre-commit --bogus\n");
    assert_delegated(&repo, &["hook", "run", "--help"], "DELEGATED hook run --help\n");

    // other hook subcommands never run natively
    assert_delegated(&repo, &["hook", "install"], "DELEGATED hook install\n");

    // schema violations are reported by Node
    repo.config(r#"{"version":2,"stages":{}}"#);
    assert_delegated(&repo, &["hook", "run", "pre-commit"], "DELEGATED hook run pre-commit\n");
    repo.config(r#"{"version":1,"stages":{"pre-commit":[{"id":"a"}]}}"#);
    assert_delegated(&repo, &["hook", "run", "pre-commit"], "DELEGATED hook run pre-commit\n");
    repo.config("{not json");
    assert_delegated(&repo, &["hook", "run", "pre-commit"], "DELEGATED hook run pre-commit\n");
}

#[test]
fn configs_the_fast_path_cannot_match_exactly_are_delegated_before_anything_runs() {
    let repo = Repo::new("delegate-plan");

    repo.file("a.json", "{}  \n");

    for hook in [
        // V8 owns check-json's messages
        r#"{"id":"j","builtin":"check-json"}"#,
        r#"{"id":"u","builtin":"made-up"}"#,
        // regexes outside the subset where JS and Rust agree
        r#"{"id":"r","entry":"true","files":"(?i)A"}"#,
        r#"{"id":"r","entry":"true","files":"(?=a)"}"#,
        r#"{"id":"r","entry":"true","files":"\\p{L}"}"#,
        r#"{"id":"r","entry":"true","files":"[[:alpha:]]"}"#,
        r#"{"id":"r","entry":"true","files":"[a&&b]"}"#,
        r#"{"id":"r","entry":"true","files":"a{,3}"}"#,
        r#"{"id":"r","entry":"true","files":"("}"#,
        r#"{"id":"r","entry":"true","files":"\\.tsx?+$"}"#,
        r#"{"id":"r","entry":"true","files":"^a{ 2}"}"#,
        // a tag the upstream classifier does not know (vis overlay tags live in JS)
        r#"{"id":"t","entry":"true","types":["vis-config"]}"#,
    ] {
        // a fixer FIRST: if the plan only failed afterwards, it would already have rewritten the file
        repo.config(&format!(
            r#"{{"version":1,"stages":{{"pre-commit":[{{"id":"tw","builtin":"trailing-whitespace"}},{hook}]}}}}"#
        ));

        assert_delegated(&repo, &["hook", "run", "pre-commit"], "DELEGATED hook run pre-commit\n");
        assert_eq!(repo.read("a.json"), "{}  \n", "the fixer ran before delegating for {hook}");
    }
}

#[test]
fn a_pattern_with_a_non_ascii_path_is_delegated() {
    let repo = Repo::new("non-ascii");

    repo.file("ünï.txt", "x\n")
        .config(r#"{"version":1,"stages":{"pre-commit":[{"id":"r","entry":"true","files":"\\.txt$"}]}}"#);

    assert_delegated(&repo, &["hook", "run", "pre-commit"], "DELEGATED hook run pre-commit\n");
}

#[test]
fn hooks_dir_flag_is_honoured_in_both_forms() {
    let repo = Repo::new("hooksdir");

    repo.file("a.ts", "x\n");
    fs::create_dir_all(repo.root.join(".alt")).expect("mkdir");
    fs::write(
        repo.root.join(".alt/config.json"),
        r#"{"version":1,"stages":{"pre-commit":[{"id":"e","entry":"echo alt"}]}}"#,
    )
    .expect("write");

    let forms: [&[&str]; 2] =
        [&["hook", "run", "pre-commit", "--hooks-dir", ".alt"], &["hook", "run", "--hooks-dir=.alt", "pre-commit"]];

    for args in forms {
        assert_eq!(stdout(&repo.vis(args)), "Running pre-commit\nalt a.ts\n");
    }
}

#[test]
fn an_absolute_hooks_dir_is_delegated() {
    let repo = Repo::new("abs-hooks-dir");

    repo.file("a.ts", "x\n").config(r#"{"version":1,"stages":{"pre-commit":[{"id":"e","entry":"echo native"}]}}"#);

    let absolute = repo.root.join(".vis/hooks");
    let flag = format!("--hooks-dir={}", absolute.display());

    assert_delegated(&repo, &["hook", "run", "pre-commit", &flag], &format!("DELEGATED hook run pre-commit {flag}\n"));
}

#[test]
fn hooks_do_not_inherit_the_launchers_delegation_variables() {
    let repo = Repo::new("env");

    repo.file("a.ts", "x\n")
        .config(r#"{"version":1,"stages":{"pre-commit":[{"id":"e","entry":"sh -c 'echo [${VIS_FALLBACK_ENTRY-unset}][${VIS_NODE-unset}]'","passFilenames":false}]}}"#);

    assert_eq!(stdout(&repo.vis(&["hook", "run", "pre-commit"])), "Running pre-commit\n[unset][unset]\n");
}

#[test]
fn tag_filters_see_what_earlier_hooks_changed() {
    let repo = Repo::new("late-tags");

    repo.file("run.sh", "echo\n").config(
        r#"{"version":1,"stages":{"pre-commit":[{"id":"x","entry":"chmod +x run.sh","passFilenames":false},{"id":"e","entry":"echo exe:","types":["executable"]}]}}"#,
    );

    assert_eq!(stdout(&repo.vis(&["hook", "run", "pre-commit"])), "Running pre-commit\nexe: run.sh\n");
}
