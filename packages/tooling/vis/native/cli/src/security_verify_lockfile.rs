//! `vis security verify-lockfile --offline [--json]` — the native port of `src/commands/security/verify-lockfile.ts` (and
//! `src/security/lockfile-verification.ts`) for a lockfile that passes.
//!
//! The command re-validates the whole resolved closure: it counts the locked packages, evaluates the `firstSeen` and
//! `publisherChange` policies over them and scans the lockfile for transitive dependencies pulled from an exotic source
//! (`blockExoticSubdeps`, on by default). With `--offline` both policies are skipped with an info row each (they need the
//! registry), so the answer depends on the lockfile alone: the entry count, and whether any dependency edge is exotic.
//!
//! The binary answers only the run that passes, for a pnpm workspace in a unix CI run off a terminal at the root, with the
//! default policy configuration (see [`config_is_default`]). It hands to Node, before anything is printed:
//!
//! - every run without `--offline` (the policies read a packument of every package), every other flag, a failing run
//!   (an exotic edge: the report sorts it with `localeCompare`), a missing, unreadable or empty lockfile, and a lockfile
//!   this crate does not read exactly (see [`crate::pnpm_lock`]);
//! - another package manager, and a `packageManager` pin in this directory or above it;
//! - a config Node must evaluate, a `security` block with `blockExoticSubdeps`, `exoticSubdepsAllow` or a `firstSeen` or
//!   `publisherChange` policy (they decide which checks run), and a dependency specifier outside ASCII;
//! - in the text form, a layout the environment does not decide, and a headline that would not fit one line.
//!
//! The report holds the elapsed time (`durationMs` in JSON, `(N entries, 12ms)` in text), which is the wall clock of the
//! run: the parity suite masks it. The headline is checked to fit one line with the widest millisecond count, so how long
//! the run takes never decides whether pail wraps it.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use regex::Regex;
use serde_json::Value;
use vis_core::detect::detect_package_manager;

use crate::js::trim;
use crate::json::{stringify, Json};
use crate::node_context::{any_ancestor_has, ci_root_context, DENO_FILES};
use crate::output::{write_stdout, Output};
use crate::pail::{Layout, Level};
use crate::pm_detect::ancestor_pins_package_manager;
use crate::pnpm_lock::{self, DependencyMap};
use crate::vis_config::{self, ConfigState};

/// The two policies, in the order the registry of `src/security/policies/index.ts` lists them.
const SKIPPED_POLICIES: [&str; 2] = ["firstSeen", "publisherChange"];

/// The widest elapsed time the formatter prints below a second.
const WIDEST_MILLISECONDS: &str = "999ms";

/// Answers `vis security verify-lockfile` natively or hands the whole invocation to Node. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Ok(Answer::Json(text)) => {
            write_stdout("security", "the output", text);

            std::process::exit(0)
        }
        Ok(Answer::Text(output)) => output.emit("security"),
        Err(reason) => crate::process::delegate_because(&reason, raw_args),
    }
}

enum Answer {
    Json(String),
    Text(Output),
}

/// The flags this module takes: `--offline`, which is required, and `--json`, each once, in either order.
fn parse(args: &[String]) -> Option<bool> {
    let flags = args.strip_prefix(&["security".to_owned(), "verify-lockfile".to_owned()])?;

    match flags {
        [offline] if offline == "--offline" => Some(false),
        [first, second]
            if (first == "--offline" && second == "--json") || (first == "--json" && second == "--offline") =>
        {
            Some(true)
        }
        _ => None,
    }
}

/// The working directory when Node would reach the same answer from the workspace root.
fn context() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;

    (ci_root_context(&cwd) && !any_ancestor_has(&cwd, &DENO_FILES)).then_some(cwd)
}

/// Whether the policy configuration Node merges for this directory is the default one, which is the one this module
/// reproduces: `blockExoticSubdeps` on with no allow list, `publisherChange` in its `no-downgrade` mode, and no
/// `firstSeen`. A config is read as data; one with a `security` key must not name the settings that decide which checks run.
fn config_is_default(cwd: &Path) -> Result<(), String> {
    let state = vis_config::read(cwd);

    let ConfigState::Static(root) = &state else {
        return if matches!(state, ConfigState::Absent) { Ok(()) } else { Err("the config needs Node".to_owned()) };
    };

    let file = vis_config::config_file_in(cwd).ok_or("the config is not in the working directory")?;

    if file.extension().is_some_and(|extension| extension == "json") {
        return Err("a json config is not one Node loads".to_owned());
    }

    // `security` is the one key Node-only for the package-manager commands that this command reads itself.
    let mut rest = root.clone();

    rest.as_object_mut().ok_or("the config is not an object")?.remove("security");

    if vis_config::requires_node(&ConfigState::Static(rest)) {
        return Err("the config needs Node".to_owned());
    }

    let Some(security) = root.get("security") else {
        return Ok(());
    };
    let security = security.as_object().ok_or("`security` is not an object")?;

    if security.contains_key("blockExoticSubdeps") || security.contains_key("exoticSubdepsAllow") {
        return Err("the config sets blockExoticSubdeps or its allow list".to_owned());
    }

    match security.get("policies") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(policies))
            if !policies.contains_key("firstSeen") && !policies.contains_key("publisherChange") =>
        {
            Ok(())
        }
        Some(_) => Err("the config sets a firstSeen or publisherChange policy".to_owned()),
    }
}

/// `isExoticSpecifier` of `src/security/exotic-subdeps.ts`: a git repository, a hosting shorthand, a bare `owner/repo`
/// or a remote archive. A specifier outside ASCII, or with a line break, is counted as exotic here, which only hands
/// the run to Node: the expressions of JavaScript and of this crate would otherwise fold case and match `.` differently.
fn is_exotic(specifier: &str) -> bool {
    static PATTERNS: OnceLock<[Regex; 4]> = OnceLock::new();

    let value = trim(specifier);

    if value.is_empty() {
        return false;
    }

    if !value.is_ascii() || value.bytes().any(|byte| byte.is_ascii_control() && byte != b' ') {
        return true;
    }

    let [git, hosting, shorthand, archive] = PATTERNS.get_or_init(|| {
        [
            r"(?i)^(?:git\+|git://|git@|ssh://)",
            r"(?i)^(?:github|gitlab|bitbucket|gist):",
            r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:#.+)?$",
            r"(?i)^https?://",
        ]
        .map(|source| Regex::new(source).expect("pattern is valid"))
    });

    git.is_match(value)
        || hosting.is_match(value)
        || (shorthand.is_match(value) && !value.contains('@'))
        || archive.is_match(value)
}

/// Whether one of `maps` (the `dependencies` and `optionalDependencies` of an entry) names an exotic specifier.
fn has_exotic_edge(maps: [&DependencyMap; 2]) -> bool {
    maps.into_iter().flatten().any(|(_, specifiers)| specifiers.iter().any(|specifier| is_exotic(specifier)))
}

/// `1 entry` or `N entries`, as `formatLockfileVerification` says it.
fn entries(count: usize) -> String {
    format!("{count} {}", if count == 1 { "entry" } else { "entries" })
}

/// `formatElapsed`: milliseconds below a second, else seconds with one decimal.
fn elapsed(milliseconds: u128) -> String {
    if milliseconds < 1000 {
        format!("{milliseconds}ms")
    } else {
        format!("{:.1}s", milliseconds as f64 / 1000.0)
    }
}

fn headline(count: usize, elapsed: &str) -> String {
    format!("\u{2713} Lockfile passes supply-chain policies ({}, {elapsed})", entries(count))
}

/// The JSON `LockfileVerificationResult` of a passing offline run.
fn report(count: usize, milliseconds: u128) -> Option<String> {
    let decisions = SKIPPED_POLICIES.iter().map(|policy| {
        Json::Object(vec![
            ("packageName".to_owned(), Json::Str("*".to_owned())),
            ("policy".to_owned(), Json::Str((*policy).to_owned())),
            ("reason".to_owned(), Json::Str(format!("policy.{policy} skipped: requires network (--offline)"))),
            ("severity".to_owned(), Json::Str("info".to_owned())),
            ("version".to_owned(), Json::Str("*".to_owned())),
        ])
    });
    let report = Json::Object(vec![
        ("decisions".to_owned(), Json::Array(decisions.collect())),
        ("durationMs".to_owned(), Json::Int(i64::try_from(milliseconds).ok()?)),
        ("entryCount".to_owned(), Json::Int(i64::try_from(count).ok()?)),
        ("exoticViolations".to_owned(), Json::Array(Vec::new())),
        ("lockfileMissing".to_owned(), Json::Bool(false)),
        ("status".to_owned(), Json::Str("pass".to_owned())),
    ]);

    Some(format!("{}\n", stringify(&report, "  ")))
}

fn answer(args: &[String]) -> Result<Answer, String> {
    let json = parse(args).ok_or("not `security verify-lockfile --offline` with only `--json`")?;
    let layout =
        if json { None } else { Some(Layout::detect(args).ok_or("pail's layout is not decided by the environment")?) };
    let cwd = context().ok_or("not a CI run at the root of a pnpm workspace")?;
    let cwd_text = cwd.to_str().ok_or("the working directory is not text")?;

    if detect_package_manager(cwd_text, None).name != "pnpm" {
        return Err("the package manager is not pnpm".to_owned());
    }

    if ancestor_pins_package_manager(&cwd) {
        return Err("a package.json pins the package manager".to_owned());
    }

    config_is_default(&cwd)?;

    // Node starts its clock when the verification does, after the config is loaded.
    let start = Instant::now();
    let bytes =
        fs::read(cwd.join("pnpm-lock.yaml")).map_err(|error| format!("pnpm-lock.yaml cannot be read: {error}"))?;
    let locked = pnpm_lock::parse(&bytes).ok_or("pnpm-lock.yaml is not text this crate reads exactly")?;

    if locked.is_empty() {
        return Err("the lockfile lists no package".to_owned());
    }

    if locked.iter().any(|entry| has_exotic_edge([&entry.dependencies, &entry.optional_dependencies])) {
        return Err("a dependency edge is exotic, so the run fails and lists it".to_owned());
    }

    let milliseconds = start.elapsed().as_millis();

    let Some(layout) = layout else {
        return report(locked.len(), milliseconds).map(Answer::Json).ok_or_else(|| "the count does not fit".to_owned());
    };

    let message = headline(locked.len(), &elapsed(milliseconds));
    let widest = headline(locked.len(), WIDEST_MILLISECONDS);

    // Decided before anything is printed: a headline that would wrap, for this run or for a slower one, is Node's.
    if !layout.fits_one_line(&message) || !layout.fits_one_line(&widest) {
        return Err("the headline does not fit one line".to_owned());
    }

    let mut output = Output::default();

    output.say(layout, Level::Success, &message);

    Ok(Answer::Text(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn offline_is_required_and_json_is_optional() {
        assert_eq!(parse(&args(&["security", "verify-lockfile", "--offline"])), Some(false));
        assert_eq!(parse(&args(&["security", "verify-lockfile", "--offline", "--json"])), Some(true));
        assert_eq!(parse(&args(&["security", "verify-lockfile", "--json", "--offline"])), Some(true));
    }

    #[test]
    fn every_other_shape_is_node_s() {
        for shape in [
            &["security", "verify-lockfile"][..],
            &["security", "verify-lockfile", "--json"],
            &["security", "verify-lockfile", "--offline", "--offline"],
            &["security", "verify-lockfile", "--offline", "--json", "--json"],
            &["security", "verify-lockfile", "--offline=true"],
            &["security", "verify-lockfile", "--no-offline"],
            &["security", "verify-lockfile", "--offline", "extra"],
            &["security", "verify-lockfile", "--offline", "--cwd", "."],
            &["security", "verify-lockfile", "--", "--offline"],
            &["security", "list", "--offline"],
        ] {
            assert!(parse(&args(shape)).is_none(), "{shape:?}");
        }
    }

    #[test]
    fn exotic_specifiers_are_the_ones_the_scanner_flags() {
        for exotic in [
            "git+https://example.com/a.git",
            "GIT+ssh://example.com/a.git",
            "git://example.com/a.git",
            "git@example.com:a/b.git",
            "ssh://git@example.com/a.git",
            "github:owner/repo",
            "GitLab:owner/repo",
            "bitbucket:owner/repo",
            "gist:abc",
            "owner/repo",
            "owner/repo#main",
            "a.b/c-d#v1.0.0",
            "https://example.com/a.tgz",
            "HTTP://example.com/a.tgz",
            "  https://example.com/a.tgz  ",
            // Outside ASCII, or with a control character: handed to Node whatever JavaScript says.
            "caf\u{e9}",
            "a\nb",
        ] {
            assert!(is_exotic(exotic), "{exotic}");
        }

        for plain in [
            "",
            "   ",
            "1.2.3",
            "^1.0.0",
            "~2",
            "1.2.3(react@18.2.0)",
            "npm:left-pad@1.0.0",
            "workspace:*",
            "link:../a",
            "file:../a",
            "portal:../a",
            "github.com/owner/repo/abc123",
            "owner/repo@1.0.0",
        ] {
            assert!(!is_exotic(plain), "{plain}");
        }
    }

    #[test]
    fn the_headline_and_the_elapsed_time_read_like_the_formatter() {
        assert_eq!(headline(1, "5ms"), "\u{2713} Lockfile passes supply-chain policies (1 entry, 5ms)");
        assert_eq!(headline(3, "12ms"), "\u{2713} Lockfile passes supply-chain policies (3 entries, 12ms)");
        assert_eq!(elapsed(0), "0ms");
        assert_eq!(elapsed(999), "999ms");
        assert_eq!(elapsed(1000), "1.0s");
        assert_eq!(elapsed(1949), "1.9s");
        assert_eq!(elapsed(2051), "2.1s");
    }

    #[test]
    fn the_json_report_keeps_the_key_order_of_the_result() {
        let text = report(2, 7).unwrap();

        assert_eq!(
            text,
            "{\n  \"decisions\": [\n    {\n      \"packageName\": \"*\",\n      \"policy\": \"firstSeen\",\n      \"reason\": \"policy.firstSeen skipped: requires network (--offline)\",\n      \"severity\": \"info\",\n      \"version\": \"*\"\n    },\n    {\n      \"packageName\": \"*\",\n      \"policy\": \"publisherChange\",\n      \"reason\": \"policy.publisherChange skipped: requires network (--offline)\",\n      \"severity\": \"info\",\n      \"version\": \"*\"\n    }\n  ],\n  \"durationMs\": 7,\n  \"entryCount\": 2,\n  \"exoticViolations\": [],\n  \"lockfileMissing\": false,\n  \"status\": \"pass\"\n}\n"
        );
    }
}
