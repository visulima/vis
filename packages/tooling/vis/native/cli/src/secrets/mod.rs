//! Native `vis secrets`: the working-tree scan of the workspace root, reported as JSON or SARIF,
//! or as the plain text view with `--quiet`.
//!
//! Mirrors `src/commands/secrets/handler.ts` and the scanner's post-scan pipeline
//! (`packages/tooling/secret-scanner/src/pipeline.ts`) for the default ruleset. The detection engine
//! is the `secret-scanner-core` crate, the same one the Node addon wraps, so the findings are the
//! same; this module reproduces what Node does around them: the opt-in rule gate, the generic-rule
//! shadowing, the false-positive heuristics, masking, the baseline, the reports and the exit code.
//!
//! The native path is narrow on purpose. It answers `vis secrets` with any of `--format
//! json|sarif|text`, `--quiet` and `--baseline <file>`, each at most once, and the text view only
//! with `--quiet` (the progress lines of the default text view carry a frame count that depends
//! on timing). Everything else goes to Node: every other flag, a path argument, `--validate`,
//! `--no-redact`, the other report formats, git modes, and every config or ignore file this module
//! does not read (`vis.config.*`, `.gitleaksignore`, `.secretlintignore`).
//!
//! Output is buffered and the run is decided before the first byte is written, so a case found
//! late (a finding of a checksum rule, a non-ASCII secret, a baseline that does not parse) can
//! still hand the whole invocation to Node.

mod baseline;
mod filter;
mod report;
mod sarif;

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::exit;

use secret_scanner_core::{list_rules, scan_dirs, ScanOptions, SkippedFile};
use serde_json::Value;

use crate::js::is_truthy;
use crate::node_context::{ci_root_context, quiet_context};
use crate::output::write_streams;
use crate::pail::{Layout, Level as LogLevel};

use baseline::load_baseline;
use filter::{report_findings, shown};
use report::{render_json, render_text};
use sarif::{render_sarif, root_collation};

/// Where the bundled ruleset lives inside the `@visulima/secret-scanner` package: the package
/// directory under a `node_modules`, and the ruleset file in it.
const PACKAGE_DIR: [&str; 3] = ["node_modules", "@visulima", "secret-scanner"];
const RULESET_FILE: &str = "data/ruleset.json";

#[derive(Clone, Copy, Debug, PartialEq)]
enum Format {
    Text,
    Json,
    Sarif,
}

#[derive(Debug, PartialEq)]
struct Plan {
    format: Format,
    quiet: bool,
    baseline: Option<String>,
}

/// The value of an option: the next argument, or the `=` part. A value that looks like a flag, or
/// an empty one, is left to Node.
fn value_of<'a>(argument: &'a str, name: &str, rest: &mut impl Iterator<Item = &'a String>) -> Option<Option<&'a str>> {
    let value = if argument == name {
        rest.next()?.as_str()
    } else if let Some(value) = argument.strip_prefix(name).and_then(|tail| tail.strip_prefix('=')) {
        value
    } else {
        return Some(None);
    };

    (!value.is_empty() && !value.starts_with('-')).then_some(Some(value))
}

/// Parses the arguments after `secrets` the way cerebro does for this command. `args[0]` is
/// `secrets`. Returns `None` for any shape this module does not answer.
fn parse(args: &[String]) -> Option<Plan> {
    let (mut format, mut quiet, mut baseline) = (None, false, None);
    let mut rest = args.iter().skip(1);

    while let Some(argument) = rest.next() {
        if argument == "--quiet" {
            if quiet {
                return None;
            }

            quiet = true;

            continue;
        }

        if let Some(value) = value_of(argument, "--format", &mut rest)? {
            if format.is_some() {
                return None;
            }

            format = Some(match value {
                "text" => Format::Text,
                "json" => Format::Json,
                "sarif" => Format::Sarif,
                _ => return None,
            });

            continue;
        }

        match value_of(argument, "--baseline", &mut rest)? {
            Some(value) if baseline.is_none() => baseline = Some(value.to_owned()),
            _ => return None,
        }
    }

    let format = format.unwrap_or(Format::Text);

    // The default text view prints progress frames whose count depends on timing.
    (format != Format::Text || quiet).then_some(Plan { format, quiet, baseline })
}

/// Everything the scan needs from the machine, once the context is proven.
struct Context {
    root: PathBuf,
    layout: Layout,
    ruleset: PathBuf,
}

/// Whether Node would reach the same answer, and where the scanner's bundled ruleset is.
fn context(args: &[String]) -> Option<Context> {
    if !cfg!(unix) {
        return None;
    }

    let layout = Layout::detect(args)?;
    let cwd = env::current_dir().ok()?;

    // Node scans the workspace root; the text view prints paths relative to the working directory.
    // Both agree only when the root is the working directory.
    if !ci_root_context(&cwd) {
        return None;
    }

    if !quiet_context(&cwd, &cwd) {
        return None;
    }

    // Ignore files the native path does not read: they change which files are scanned or which
    // findings are reported.
    if cwd.join(".gitleaksignore").exists() || secretlintignore_applies(&cwd) {
        return None;
    }

    Some(Context { ruleset: ruleset_path()?, root: cwd, layout })
}

/// Whether a `.secretlintignore` is discovered for `root`: in it or a parent up to the repository
/// root (the nearest ancestor with a `.git`), or only in `root` outside a repository.
fn secretlintignore_applies(root: &Path) -> bool {
    let top = root.ancestors().find(|directory| directory.join(".git").exists()).unwrap_or(root);

    root.ancestors()
        .take_while(|directory| directory.starts_with(top))
        .any(|directory| directory.join(".secretlintignore").is_file())
}

/// The `data/ruleset.json` of the `@visulima/secret-scanner` the Node CLI would load: the nearest
/// `node_modules` above the Node entry that holds it, as Node's resolution walks.
///
/// An entry with no such `node_modules` above it finds nothing, and the whole run goes to Node, whatever
/// the arguments. The launcher passes the real `dist/bin.js`, which always has one; a stand-in entry
/// outside the package tree (a harness that only needs to see a delegation) does not, so a plain
/// `vis secrets --quiet` in a pnpm workspace delegates there.
fn ruleset_path() -> Option<PathBuf> {
    let entry = fs::canonicalize(env::var_os("VIS_FALLBACK_ENTRY")?).ok()?;

    entry.ancestors().skip(1).map(|directory| directory.join(PACKAGE_DIR.iter().collect::<PathBuf>())).find_map(
        |package| {
            let ruleset = package.join(RULESET_FILE);

            ruleset.is_file().then_some(ruleset)
        },
    )
}

/// The bundled config with the opt-in rules removed (`gateOptInRules` with nothing enabled), and
/// the ids of the rules whose findings Node filters by a checksum.
fn bundled_config(path: &Path) -> Option<(Value, HashSet<String>)> {
    let mut config: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let rules = config.get_mut("rules")?.as_array_mut()?;
    let mut checksum_rules = HashSet::new();

    for rule in rules.iter() {
        if rule.get("patternRequirements").and_then(|requirements| requirements.get("checksum")).is_some_and(is_truthy)
        {
            checksum_rules.insert(rule.get("id")?.as_str()?.to_owned());
        }
    }

    rules.retain(|rule| rule.get("defaultEnabled") != Some(&Value::Bool(false)));

    Some((config, checksum_rules))
}

/// The stderr summary of the files the scan could not read.
fn skipped_summary(skipped: &[SkippedFile]) -> String {
    let mut counts: Vec<(&str, usize)> = Vec::new();

    for entry in skipped {
        match counts.iter_mut().find(|(reason, _)| *reason == entry.reason) {
            Some((_, count)) => *count += 1,
            None => counts.push((&entry.reason, 1)),
        }
    }

    let breakdown = counts.iter().map(|(reason, count)| format!("{reason}: {count}")).collect::<Vec<_>>().join(", ");

    format!("{} file(s) not scanned ({breakdown}); use --verbose to list them\n", skipped.len())
}

/// What a run prints and the exit code it ends with.
struct Output {
    stdout: String,
    stderr: String,
    code: i32,
}

/// Runs the scan and builds the output, or `None` when Node has to answer.
fn answer(plan: &Plan, context: &Context) -> Option<Output> {
    let (config, checksum_rules) = bundled_config(&context.ruleset)?;
    let baseline = match &plan.baseline {
        Some(path) => load_baseline(&context.root.join(path))?,
        None => HashSet::new(),
    };
    let options = ScanOptions { config: Some(config), respect_gitignore: Some(true), ..ScanOptions::default() };
    let report = scan_dirs(vec![context.root.to_str()?.to_owned()], &options).ok()?;
    let findings = shown(report_findings(report.findings, &checksum_rules)?, &baseline);

    let mut out = Output { stdout: String::new(), stderr: String::new(), code: i32::from(!findings.is_empty()) };

    if !plan.quiet {
        if !report.skipped.is_empty() {
            out.stderr.push_str(&skipped_summary(&report.skipped));
        }

        if !report.allow_warnings.is_empty() {
            out.stderr.push_str(&format!(
                "{} allow marker(s) name unknown rule ids and still suppress every rule (rename or remove the ids):\n",
                report.allow_warnings.len()
            ));

            for warning in &report.allow_warnings {
                if warning.file.starts_with('/') {
                    return None;
                }

                out.stderr.push_str(&format!(
                    "  - {}:{} unknown: {}\n",
                    warning.file,
                    warning.line,
                    warning.unknown_rule_ids.join(", ")
                ));
            }
        }
    }

    out.stdout = match plan.format {
        Format::Text => render_text(&findings),
        Format::Json => render_json(&findings)?,
        Format::Sarif => {
            if !root_collation() {
                return None;
            }

            let rules = list_rules(&options).ok()?;

            render_sarif(&findings, &rules, &context.root)?
        }
    };

    if !plan.quiet {
        if findings.is_empty() {
            out.stderr.push_str(&context.layout.block(LogLevel::Success, "No secrets detected."));
        } else {
            out.stderr.push_str(
                &context.layout.block(LogLevel::Warning, &format!("{} potential secret(s) found", findings.len())),
            );
            out.stderr.push_str(&context.layout.block(
                LogLevel::Notice,
                "Suppress individual lines with `gitleaks:allow` / `secret-scanner:allow`, or run `vis secrets --update-baseline`.",
            ));
        }
    }

    Some(out)
}

/// Answers `vis secrets` natively or hands the whole invocation to Node. `args` keeps the raw
/// argv for the delegation; the `String` view is only for matching. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let output = parse(args).and_then(|plan| answer(&plan, &context(args)?));

    let Some(output) = output else {
        crate::process::delegate(raw_args);
    };

    write_streams("secrets", &output.stdout, &output.stderr);

    exit(output.code)
}

#[cfg(test)]
mod tests {
    use secret_scanner_core::Finding;

    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    pub(super) fn finding(secret: &str, file: &str) -> Finding {
        Finding {
            rule_id: "demo".to_owned(),
            description: String::new(),
            file: file.to_owned(),
            start_line: 1,
            end_line: 1,
            start_column: 1,
            end_column: 2,
            r#match: secret.to_owned(),
            secret: secret.to_owned(),
            entropy: 0.0,
            tags: Vec::new(),
            source: None,
            confidence: "low".to_owned(),
            alternate_matches: Vec::new(),
            decoded: None,
            required_findings: None,
            root: None,
            source_span: None,
            span_unavailable_reason: None,
        }
    }

    #[test]
    fn parses_the_native_shapes() {
        assert_eq!(
            parse(&argv(&["secrets", "--quiet"])).map(|plan| (plan.format, plan.quiet)),
            Some((Format::Text, true))
        );
        assert_eq!(parse(&argv(&["secrets", "--format", "json"])).map(|plan| plan.format), Some(Format::Json));
        assert_eq!(
            parse(&argv(&["secrets", "--format=sarif", "--quiet"])).map(|plan| plan.format),
            Some(Format::Sarif)
        );
        assert_eq!(
            parse(&argv(&["secrets", "--format=json", "--baseline", "b.json"])).and_then(|plan| plan.baseline),
            Some("b.json".to_owned())
        );
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["secrets"][..],
            &["secrets", "--format", "text"],
            &["secrets", "--format=csv"],
            &["secrets", "--format=JSON"],
            &["secrets", "--format"],
            &["secrets", "--format", "--quiet"],
            &["secrets", "--baseline"],
            &["secrets", "--baseline="],
            &["secrets", "--format=json", "--format=json"],
            &["secrets", "--quiet", "--quiet"],
            &["secrets", "--no-redact"],
            &["secrets", "--validate"],
            &["secrets", "src"],
            &["secrets", "--format=json", "src"],
            &["secrets", "--staged"],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }

    #[test]
    fn a_checksum_requirement_is_found_where_javascript_finds_it_truthy() {
        let directory = std::env::temp_dir().join(format!("vis-secrets-checksum-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();

        let path = directory.join("rules.json");
        let rule =
            |id: &str, checksum: &str| format!(r#"{{"id":"{id}","patternRequirements":{{"checksum":{checksum}}}}}"#);
        let rules = [
            rule("object", r#"{"expected":"x"}"#),
            rule("string", r#""x""#),
            rule("one", "1"),
            rule("zero", "0"),
            rule("empty", r#""""#),
            rule("no", "false"),
            rule("null", "null"),
        ];

        fs::write(&path, format!(r#"{{"rules":[{}]}}"#, rules.join(","))).unwrap();

        let (_, checksum_rules) = bundled_config(&path).unwrap();
        let mut found: Vec<_> = checksum_rules.into_iter().collect();

        found.sort();
        assert_eq!(found, ["object", "one", "string"]);
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_ruleset_the_scanner_rejects_fails_the_scan_and_the_rule_listing_alike() {
        let options =
            ScanOptions { config: Some(serde_json::json!({ "rules": "not a list" })), ..ScanOptions::default() };

        // `answer` lists the rules only after the scan succeeded, and both read the ruleset the same way,
        // so a listing error never follows a good scan: it hands the run to Node instead of printing a
        // rule table with no rules in it.
        assert!(scan_dirs(vec![".".to_owned()], &options).is_err());
        assert!(list_rules(&options).is_err());
    }
}
