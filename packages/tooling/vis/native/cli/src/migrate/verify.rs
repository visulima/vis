//! `vis migrate verify` — the native port of `src/commands/migrate/verify.ts`.
//!
//! The handler looks for references to the four tools `migrate` replaces (gitleaks, secretlint, syncpack, sherif) in
//! `package.json`, three hook files, the tools' config files, the CI files and the catalogs, prints what it found and
//! exits 1 when it found anything. It reads files and writes none. The messages go through the plain `console` of the
//! cerebro toolbox, not through pail (the Node CLI builds its toolbox without a logger of its own), so a clean run is one
//! line on stdout, a dirty run is a `warn` block on stderr, and no colour, width or clock enters the output.
//!
//! The scan runs in Node's order: `package.json` scripts, then its `devDependencies`, then its `sherif` block; the hook
//! files; the secretlint, then the syncpack config names; the CI files (the `.github/workflows` entries ending in `.yml`
//! or `.yaml` in the order `readdirSync` lists them, which is byte order, then the four single files); and the catalogs.
//!
//! Everything is read and decided before the first byte is printed, and the run goes to Node when one of these holds:
//!
//! - any argument besides `migrate verify`, or a context that is not the one the other read-only commands answer
//!   ([`ci_root_context`]: a unix CI run off a terminal at the root of a pnpm workspace, no Deno file, none of the
//!   settings that change what Node prints), or a `vis.config` that is not a literal Node reads the same way (the
//!   `security` block is no reason: only install commands act on it);
//! - a `package.json` that is not UTF-8, that [`crate::json`] does not read exactly as `JSON.parse` does (a duplicate or
//!   integer-like key, a fraction, an exponent, a document that is invalid), whose top level is not an object, whose
//!   `scripts` or `devDependencies` is not an object, or whose `catalogs` is an array (`Object.entries` would then name
//!   the entries by position). A byte order mark is not a delegation: `JSON.parse` rejects it, so no issue is found there;
//! - a hook or CI file that exists and cannot be read as a file (Node throws without a handler there), a workflow name that
//!   is not UTF-8 text;
//! - a `pnpm-workspace.yaml` that mentions `syncpack` or holds a backslash. The YAML check is answered by proof of
//!   absence: a catalog issue needs the key `syncpack` as text, which only a backslash escape can hide, so a file without
//!   either has no issue however the parser reads it;
//! - a message that would pass the pipe limit Node delivers reliably ([`STREAM_LIMIT`]).

use std::env;
use std::ffi::OsString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::process::exit;

use serde_json::Value;

use crate::json::{self, Json};
use crate::node_context::{any_ancestor_has, ci_root_context, DENO_FILES};
use crate::output::{node_may_cut_short, write_streams, STREAM_LIMIT};
use crate::vis_config::{self, ConfigState};

/// `HOOK_CANDIDATES`.
const HOOKS: [&str; 3] = [".husky/pre-commit", ".vis/hooks/pre-commit", ".git/hooks/pre-commit"];

/// `SECRETLINT_CONFIG_FILES`.
const SECRETLINT_CONFIGS: [&str; 7] = [
    ".secretlintrc",
    ".secretlintrc.json",
    ".secretlintrc.js",
    ".secretlintrc.mjs",
    ".secretlintrc.cjs",
    ".secretlintrc.yml",
    ".secretlintrc.yaml",
];

/// `SYNCPACK_CONFIG_FILES`.
const SYNCPACK_CONFIGS: [&str; 12] = [
    ".syncpackrc",
    ".syncpackrc.json",
    ".syncpackrc.yaml",
    ".syncpackrc.yml",
    ".syncpackrc.cjs",
    ".syncpackrc.js",
    ".syncpackrc.mjs",
    ".syncpackrc.ts",
    "syncpack.config.cjs",
    "syncpack.config.js",
    "syncpack.config.mjs",
    "syncpack.config.ts",
];

/// The files `CI_PATH_CANDIDATES` names besides the workflows directory.
const CI_FILES: [&str; 4] = [".gitlab-ci.yml", ".circleci/config.yml", ".woodpecker.yml", ".drone.yml"];

const WORKFLOWS: &str = ".github/workflows";

/// The tools in the order the handler tests a script or a hook for them.
const TOOLS: [&str; 4] = ["gitleaks", "secretlint", "syncpack", "sherif"];

/// What stops a native answer: the reason for the hand-off.
type Declined = &'static str;

/// One line of the report: `  [kind] location — detail`.
struct Issue {
    kind: &'static str,
    location: String,
    detail: String,
}

impl Issue {
    fn new(kind: &'static str, location: impl Into<String>, detail: impl Into<String>) -> Self {
        Self { kind, location: location.into(), detail: detail.into() }
    }
}

/// Answers `vis migrate verify` natively or hands the whole invocation to Node. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Ok((stdout, stderr, status)) => {
            write_streams("migrate", &stdout, &stderr);

            exit(status)
        }
        Err(reason) => crate::process::delegate_because(reason, raw_args),
    }
}

/// What the run prints on stdout and stderr, and its exit status.
fn answer(args: &[String]) -> Result<(String, String, i32), Declined> {
    if args != ["migrate", "verify"] {
        return Err("another shape than `migrate verify`");
    }

    let cwd = env::current_dir().map_err(|_| "no working directory")?;

    if !ci_root_context(&cwd) || any_ancestor_has(&cwd, &DENO_FILES) {
        return Err("not a CI run at the root of a pnpm workspace Node would answer the same way");
    }

    if !config_is_readable(&cwd) {
        return Err("a vis.config that only Node reads exactly");
    }

    let issues = scan(&cwd)?;
    let (stdout, stderr, status) = render(&issues);

    if node_may_cut_short(stdout.len()) || stderr.len() > STREAM_LIMIT {
        return Err("a report longer than Node delivers to a pipe");
    }

    Ok((stdout, stderr, status))
}

/// Whether the `vis.config` of the workspace (if any) leaves Node's output as the scan alone makes it: absent, or a
/// literal in the working directory with no key Node's loader acts on. `security` is not one: the loader only merges it
/// with the defaults, and the plugin that reads it runs for the install commands.
fn config_is_readable(cwd: &Path) -> bool {
    match vis_config::read(cwd) {
        ConfigState::Absent => true,
        ConfigState::Static(Value::Object(mut config)) => {
            config.remove("security");

            vis_config::config_file_in(cwd)
                .is_some_and(|path| path.extension().is_some_and(|extension| extension != "json"))
                && !vis_config::requires_node(&ConfigState::Static(Value::Object(config)))
        }
        _ => false,
    }
}

/// The report of `root`, in the order of `scanMigrationLeftovers`.
fn scan(root: &Path) -> Result<Vec<Issue>, Declined> {
    let manifest = read_manifest(root)?;
    let mut issues = Vec::new();

    if let Some(manifest) = &manifest {
        scan_manifest(manifest, &mut issues)?;
    }

    scan_hooks(root, &mut issues)?;
    scan_configs(root, &mut issues);
    scan_ci(root, &mut issues)?;
    scan_catalogs(root, manifest.as_ref(), &mut issues)?;

    Ok(issues)
}

/// `isAccessibleSync`: the path exists, a link followed. Any failure of the lookup is "no".
fn accessible(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

/// A JavaScript `\bword\b` over text that may hold any bytes: the word as a whole word, where only `[A-Za-z0-9_]` makes
/// one. A non-ASCII character is no word character in JavaScript (the pattern has no `u` flag and `\w` is ASCII), and
/// neither is a byte of its UTF-8 form, nor the U+FFFD Node puts in place of a byte that is not UTF-8.
fn mentions(text: &[u8], word: &str) -> bool {
    let word = word.as_bytes();
    let is_word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';

    text.windows(word.len()).enumerate().any(|(start, window)| {
        window == word
            && (start == 0 || !is_word(text[start - 1]))
            && text.get(start + word.len()).is_none_or(|byte| !is_word(*byte))
    })
}

/// `JSON.parse(readFileSync(package.json))` with a failure of either one meaning "nothing to report": `Ok(None)`.
/// `Err` when this module cannot tell what Node's parse makes of the file.
fn read_manifest(root: &Path) -> Result<Option<Json>, Declined> {
    let path = root.join("package.json");

    if !accessible(&path) {
        return Ok(None);
    }

    // A directory or a file that cannot be opened throws inside the handler's `try`.
    let Ok(bytes) = fs::read(&path) else { return Ok(None) };
    let text = String::from_utf8(bytes).map_err(|_| "a package.json that is not UTF-8")?;

    // `readFileSync` keeps the byte order mark as U+FEFF, and `JSON.parse` does not skip it.
    if text.starts_with('\u{feff}') {
        return Ok(None);
    }

    let document = json::parse(&text).ok_or("a package.json that JSON.parse may read differently")?;

    if !matches!(document, Json::Object(_)) {
        return Err("a package.json whose top level is not an object");
    }

    Ok(Some(document))
}

/// JavaScript truthiness of a parsed value.
fn truthy(value: &Json) -> bool {
    match value {
        Json::Null | Json::Bool(false) | Json::Int(0) => false,
        Json::Str(text) => !text.is_empty(),
        _ => true,
    }
}

/// The entries of the object `value`; an absent or `null` field has none. Any other kind of value is a hand-off, because
/// `Object.entries` would name an array's or a string's entries by position.
fn object_entries<'a>(value: Option<&'a Json>, what: &'static str) -> Result<&'a [(String, Json)], Declined> {
    match value {
        None | Some(Json::Null) => Ok(&[]),
        Some(Json::Object(entries)) => Ok(entries),
        Some(_) => Err(what),
    }
}

/// `scanPackageJson`: the scripts, the dev dependencies and the `sherif` block.
fn scan_manifest(manifest: &Json, issues: &mut Vec<Issue>) -> Result<(), Declined> {
    for (name, value) in object_entries(manifest.get("scripts"), "a package.json whose scripts are not an object")? {
        // `typeof value !== "string"` is skipped.
        let Json::Str(value) = value else { continue };

        for tool in TOOLS {
            if mentions(value.as_bytes(), tool) {
                issues.push(Issue::new(
                    "script",
                    "package.json",
                    format!("Script \"{name}\" still invokes {tool}: {value}"),
                ));
            }
        }
    }

    for (name, _) in
        object_entries(manifest.get("devDependencies"), "a package.json whose devDependencies are not an object")?
    {
        let replaced = matches!(name.as_str(), "gitleaks" | "@gitleaks/cli" | "secretlint" | "syncpack" | "sherif")
            || name.starts_with("@secretlint/");

        if replaced {
            issues.push(Issue::new("devDep", "package.json", format!("devDependency `{name}` is still installed")));
        }
    }

    if manifest.get("sherif").is_some_and(truthy) {
        issues.push(Issue::new("config", "package.json", "`sherif` config block still present in package.json"));
    }

    Ok(())
}

/// `scanHooks`: the tools a hook file mentions, per file in the order of [`HOOKS`].
fn scan_hooks(root: &Path, issues: &mut Vec<Issue>) -> Result<(), Declined> {
    for relative in HOOKS {
        let path = root.join(relative);

        if !accessible(&path) {
            continue;
        }

        // `readFileSync` of a directory or an unreadable file throws, and nothing in the handler catches it.
        let content = fs::read(&path).map_err(|_| "a hook file that cannot be read")?;

        for tool in TOOLS {
            if mentions(&content, tool) {
                issues.push(Issue::new("hook", relative, format!("{tool} invocation still present in hook")));
            }
        }
    }

    Ok(())
}

/// `scanConfigs`: the config files of secretlint, then of syncpack, that exist.
fn scan_configs(root: &Path, issues: &mut Vec<Issue>) {
    for (names, tool) in [(&SECRETLINT_CONFIGS[..], "secretlint"), (&SYNCPACK_CONFIGS[..], "syncpack")] {
        for name in names {
            if accessible(&root.join(name)) {
                issues.push(Issue::new("config", *name, format!("{tool} config should be removed after migration")));
            }
        }
    }
}

/// `scanCi`: the workflows, then the single files, for `syncpack` and `sherif`.
fn scan_ci(root: &Path, issues: &mut Vec<Issue>) -> Result<(), Declined> {
    let workflows = root.join(WORKFLOWS);

    if accessible(&workflows) {
        // Anything that makes `readdirSync` throw is skipped by the handler: the directory is no directory, or unreadable.
        if let Ok(listing) = fs::read_dir(&workflows) {
            let mut names: Vec<OsString> = Vec::new();

            for entry in listing {
                let name = entry.map_err(|_| "a workflows directory that cannot be listed")?.file_name();

                if name.as_bytes().ends_with(b".yml") || name.as_bytes().ends_with(b".yaml") {
                    names.push(name);
                }
            }

            // `readdirSync` lists a directory in byte order (observed on Node 26 on macOS, with a file system that
            // does not list in that order itself; the parity suite repeats the check under a UTF-8 locale).
            names.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));

            for name in names {
                let name = name.into_string().map_err(|_| "a workflow whose name is not UTF-8")?;

                scan_ci_file(root, &format!("{WORKFLOWS}/{name}"), issues)?;
            }
        }
    }

    for relative in CI_FILES {
        scan_ci_file(root, relative, issues)?;
    }

    Ok(())
}

/// `scanFile`: one CI file, when it exists.
fn scan_ci_file(root: &Path, relative: &str, issues: &mut Vec<Issue>) -> Result<(), Declined> {
    let path = root.join(relative);

    if !accessible(&path) {
        return Ok(());
    }

    let content = fs::read(&path).map_err(|_| "a CI file that cannot be read")?;

    for tool in ["syncpack", "sherif"] {
        if mentions(&content, tool) {
            issues.push(Issue::new("ci", relative, format!("{tool} invocation still present in CI")));
        }
    }

    Ok(())
}

/// `scanCatalogs`: `syncpack` left in a catalog of `pnpm-workspace.yaml` or of `package.json`.
fn scan_catalogs(root: &Path, manifest: Option<&Json>, issues: &mut Vec<Issue>) -> Result<(), Declined> {
    let yaml = root.join("pnpm-workspace.yaml");

    if accessible(&yaml) {
        // A read that fails leaves the parse result undefined, which reports nothing.
        if let Ok(bytes) = fs::read(&yaml) {
            if bytes.contains(&b'\\') || mentions_anywhere(&bytes, b"syncpack") {
                return Err("a pnpm-workspace.yaml that may list syncpack in a catalog");
            }
        }
    }

    let Some(manifest) = manifest else { return Ok(()) };

    // `workspaces` is read only as an object; the array form (`["packages/*"]`) holds no catalog.
    if let Some(workspaces @ Json::Object(_)) = manifest.get("workspaces") {
        if lists_syncpack(workspaces.get("catalog")) {
            issues.push(Issue::new(
                "catalog",
                "package.json",
                "`syncpack` still listed in package.json#workspaces.catalog",
            ));
        }

        for name in catalogs_with_syncpack(workspaces.get("catalogs"))? {
            issues.push(Issue::new(
                "catalog",
                "package.json",
                format!("`syncpack` still listed in package.json#workspaces.catalogs.{name}"),
            ));
        }
    }

    if lists_syncpack(manifest.get("catalog")) {
        issues.push(Issue::new("catalog", "package.json", "`syncpack` still listed in package.json#catalog"));
    }

    Ok(())
}

/// Whether `text` holds `needle` anywhere, as text (no word boundary).
fn mentions_anywhere(text: &[u8], needle: &[u8]) -> bool {
    text.windows(needle.len()).any(|window| window == needle)
}

/// `catalog && typeof catalog["syncpack"] === "string"`.
fn lists_syncpack(catalog: Option<&Json>) -> bool {
    matches!(catalog.and_then(|catalog| catalog.get("syncpack")), Some(Json::Str(_)))
}

/// The names of the `catalogs` buckets that list `syncpack`, in order.
fn catalogs_with_syncpack(catalogs: Option<&Json>) -> Result<Vec<&str>, Declined> {
    match catalogs {
        Some(Json::Object(buckets)) => Ok(buckets
            .iter()
            .filter(|(_, bucket)| lists_syncpack(Some(bucket)))
            .map(|(name, _)| name.as_str())
            .collect()),
        // An array is walked by position, and its elements can be objects with the key.
        Some(Json::Array(_)) => Err("a package.json whose catalogs are an array"),
        _ => Ok(Vec::new()),
    }
}

/// The text of the report: stdout, stderr and the exit status.
fn render(issues: &[Issue]) -> (String, String, i32) {
    if issues.is_empty() {
        return (
            "\u{2713} No unmigrated gitleaks/secretlint/sherif/syncpack references found.\n".to_owned(),
            String::new(),
            0,
        );
    }

    let mut stderr = format!("Found {} unmigrated reference(s):\n", issues.len());

    for issue in issues {
        stderr.push_str(&format!("  [{}] {} \u{2014} {}\n", issue.kind, issue.location, issue.detail));
    }

    (String::new(), stderr, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_needs_a_boundary_on_both_sides() {
        assert!(mentions(b"gitleaks detect", "gitleaks"));
        assert!(mentions(b"run gitleaks", "gitleaks"));
        assert!(mentions(b"x&&gitleaks;", "gitleaks"));
        assert!(mentions("\u{e9}gitleaks".as_bytes(), "gitleaks"), "a non-ASCII letter is no word character");
        assert!(!mentions(b"gitleaks2", "gitleaks"));
        assert!(!mentions(b"_gitleaks", "gitleaks"));
        assert!(!mentions(b"my-gitleaksx", "gitleaks"));
        assert!(!mentions(b"", "gitleaks"));
        assert!(mentions(b"xgitleaksx gitleaks", "gitleaks"), "a later whole word counts");
    }

    #[test]
    fn a_clean_report_is_one_line_on_stdout() {
        let (stdout, stderr, status) = render(&[]);

        assert_eq!(stdout, "\u{2713} No unmigrated gitleaks/secretlint/sherif/syncpack references found.\n");
        assert_eq!((stderr.as_str(), status), ("", 0));
    }

    #[test]
    fn a_dirty_report_goes_to_stderr_with_status_one() {
        let (stdout, stderr, status) =
            render(&[Issue::new("hook", ".husky/pre-commit", "gitleaks invocation still present in hook")]);

        assert_eq!(stdout, "");
        assert_eq!(stderr, "Found 1 unmigrated reference(s):\n  [hook] .husky/pre-commit \u{2014} gitleaks invocation still present in hook\n");
        assert_eq!(status, 1);
    }

    #[test]
    fn only_the_exact_shape_is_answered() {
        for args in
            [&["migrate", "verify", "--json"][..], &["migrate"], &["migrate", "all"], &["migrate", "verify-graph"]]
        {
            let args: Vec<String> = args.iter().map(|word| (*word).to_owned()).collect();

            assert!(answer(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn a_manifest_that_is_not_an_object_is_handed_over() {
        let directory = std::env::temp_dir().join(format!("vis-migrate-verify-manifest-{}", std::process::id()));

        fs::create_dir_all(&directory).expect("create the directory");

        for (text, handed_over) in
            [("null", true), ("[]", true), ("{\"scripts\":[\"gitleaks\"]}", true), ("\u{feff}{}", false), ("{}", false)]
        {
            fs::write(directory.join("package.json"), text).expect("write package.json");

            let scanned = read_manifest(&directory).and_then(|manifest| {
                let mut issues = Vec::new();

                if let Some(manifest) = &manifest {
                    scan_manifest(manifest, &mut issues)?;
                }

                Ok(issues)
            });

            assert_eq!(scanned.is_err(), handed_over, "{text:?}");
        }

        fs::remove_dir_all(&directory).expect("remove the directory");
    }
}
