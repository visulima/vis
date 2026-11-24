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

use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::exit;

use secret_scanner_core::{list_rules, scan_dirs, Finding, RuleInfo, ScanOptions, SkippedFile};
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::js::{is_truthy, js_number, json_number};
use crate::node_context::{in_ci, monorepo_root, output_settings_are_default, quiet_context};
use crate::pail::{Layout, Level as LogLevel};

/// The tool version Node stamps into SARIF (`toolVersion` in the secrets handler).
const TOOL_VERSION: &str = "0.0.0-alpha";

/// Where the bundled ruleset lives inside the `@visulima/secret-scanner` package.
const RULESET: [&str; 4] = ["node_modules", "@visulima", "secret-scanner", "data/ruleset.json"];

const GENERIC_RULE: &str = "generic-api-key";

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

/// Whether Node's `localeCompare` orders rule ids as the root collation does: the locale variables
/// ICU reads are unset, `C`/`POSIX` or English. Other locales order some letter pairs differently
/// (Czech `ch`, Danish `aa`, Lithuanian `y`).
fn root_collation() -> bool {
    ["LC_ALL", "LC_COLLATE", "LC_MESSAGES", "LANG", "LANGUAGE"].iter().all(|name| {
        env::var_os(name).is_none_or(|value| {
            let value = value.to_string_lossy().to_ascii_lowercase();

            value.is_empty() || value == "c" || value == "posix" || value.starts_with("c.") || value.starts_with("en")
        })
    })
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

    if !in_ci() || io::stdout().is_terminal() || io::stderr().is_terminal() {
        return None;
    }

    // pail's level comes from NODE_ENV (`test` hides the notice and success lines, `debug` shows more),
    // `DEBUG` and `PAIL_LOG_LEVEL`, and cerebro's output level from `CEREBRO_*`. Node answers for those.
    if !output_settings_are_default() {
        return None;
    }

    let layout = Layout::detect(args)?;
    let cwd = env::current_dir().ok()?;

    // Node scans the workspace root; the text view prints paths relative to the working directory.
    // Both agree only when the root is the working directory.
    if monorepo_root(&cwd).as_deref() != Some(cwd.as_path()) {
        return None;
    }

    if env::var_os("VIS_MONOREPO_ROOT").is_some_and(|inherited| Path::new(&inherited) != cwd) {
        return None;
    }

    if !quiet_context(&cwd, &cwd) || crate::vis_config::read(&cwd) != crate::vis_config::ConfigState::Absent {
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

    entry.ancestors().skip(1).map(|directory| directory.join(RULESET[..3].iter().collect::<PathBuf>())).find_map(
        |package| {
            let ruleset = package.join(RULESET[3]);

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

/// `abc***xyz`, and `******` for six characters or fewer. Counts characters like the Node mask.
fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();

    if chars.len() <= 6 {
        return "******".to_owned();
    }

    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 3..].iter().collect();

    format!("{head}{}{tail}", "*".repeat(chars.len() - 6))
}

/// SHA-256 over `secret NUL rule NUL file`, as 16 hex characters.
fn fingerprint(secret: &str, rule_id: &str, file: &str) -> String {
    let digest = Sha256::digest(format!("{secret}\0{rule_id}\0{file}").as_bytes());

    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

fn legacy_fingerprint(file: &str, rule_id: &str, line: &str) -> String {
    format!("{file}:{rule_id}:{line}")
}

/// Every key a finding is baselined under: content hash, line-based form and the whole match as
/// the secret.
fn baseline_keys(finding: &Finding) -> [String; 3] {
    [
        fingerprint(&finding.secret, &finding.rule_id, &finding.file),
        legacy_fingerprint(&finding.file, &finding.rule_id, &finding.start_line.to_string()),
        fingerprint(&finding.r#match, &finding.rule_id, &finding.file),
    ]
}

/// The suppression set of a baseline file: each entry under its content hash and its line-based
/// form. A missing file is an empty baseline. A file Node would complain about (unreadable, not
/// JSON, not an array) is `None`: Node prints its own diagnostic for it.
fn load_baseline(path: &Path) -> Option<HashSet<String>> {
    if !path.exists() {
        return Some(HashSet::new());
    }

    let text = String::from_utf8(fs::read(path).ok()?).ok()?;
    let Value::Array(entries) = serde_json::from_str(&text).ok()? else {
        return None;
    };
    let mut set = HashSet::new();

    for entry in &entries {
        let (Some(rule_id), Some(file), Some(Value::Number(line))) = (
            entry.get("ruleId").and_then(Value::as_str),
            entry.get("file").and_then(Value::as_str),
            entry.get("startLine"),
        ) else {
            continue;
        };
        let secret = entry.get("secret").and_then(Value::as_str).unwrap_or("");

        set.insert(fingerprint(secret, rule_id, file));
        set.insert(legacy_fingerprint(file, rule_id, &js_number(line.as_f64()?)));
    }

    Some(set)
}

/// The content-shape heuristics, on an ASCII secret: lock files by name, runs of one character or
/// of a sequence, UUIDs, and secrets with no alphanumeric character.
fn is_false_positive(finding: &Finding) -> bool {
    const LOCK_FILES: [&str; 28] = [
        ".terraform.lock.hcl",
        "Berksfile.lock",
        "Brewfile.lock.json",
        "bun.lock",
        "bun.lockb",
        "Cargo.lock",
        "Cartfile.resolved",
        "composer.lock",
        "conda-lock.yml",
        "flake.lock",
        "Gemfile.lock",
        "go.sum",
        "gradle.lockfile",
        "mix.lock",
        "npm-shrinkwrap.json",
        "package-lock.json",
        "Package.resolved",
        "packages.lock.json",
        "pdm.lock",
        "Pipfile.lock",
        "pnpm-lock.yaml",
        "pnpm-lock.yml",
        "Podfile.lock",
        "poetry.lock",
        "pubspec.lock",
        "shrinkwrap.yaml",
        "uv.lock",
        "yarn.lock",
    ];

    let secret = finding.secret.as_str();
    let basename = finding.file.rsplit('/').next().unwrap_or("");

    if !finding.tags.iter().any(|tag| tag == "exposure") && LOCK_FILES.contains(&basename) {
        return true;
    }

    is_sequential(secret)
        || is_uuid(secret)
        || (!secret.is_empty() && !secret.bytes().any(|byte| byte.is_ascii_alphanumeric()))
}

/// `AAAAAAAA`, `xxxxxxxx`, `abcdefgh`, `12345678`: six or more characters of one repeated
/// character or a substring of the alphabet, the digits or the hex digits (case-insensitively).
fn is_sequential(secret: &str) -> bool {
    if secret.len() < 6 {
        return false;
    }

    let bytes = secret.as_bytes();

    // `.` in the JS pattern does not match a line terminator.
    if bytes[0] != b'\n' && bytes[0] != b'\r' && bytes.iter().all(|byte| *byte == bytes[0]) {
        return true;
    }

    let upper = secret.to_ascii_uppercase();
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(2);
    let digits = "0123456789".repeat(6);
    let hex = "0123456789ABCDEF".repeat(4);

    [&alphabet[..alphabet.len().min(60)], &digits[..60], &hex[..60]].iter().any(|sequence| sequence.contains(&upper))
}

fn is_uuid(secret: &str) -> bool {
    let groups: Vec<&str> = secret.split('-').collect();

    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, length)| group.len() == length && group.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// The line and column of one end of a finding, compared as a pair.
fn before(line_a: u32, column_a: u32, line_b: u32, column_b: u32) -> bool {
    (line_a, column_a) < (line_b, column_b)
}

fn overlaps(a: &Finding, b: &Finding) -> bool {
    before(a.start_line, a.start_column, b.end_line, b.end_column)
        && before(b.start_line, b.start_column, a.end_line, a.end_column)
}

/// The findings a scan reports: the generic rule yields to any overlapping finding of another
/// rule, then the heuristics drop false positives. `None` when a finding needs something this
/// module does not do (a checksum, composite dependencies, JS string semantics, a path outside the
/// root).
fn report_findings(found: Vec<Finding>, checksum_rules: &HashSet<String>) -> Option<Vec<Finding>> {
    for finding in &found {
        if finding.required_findings.is_some()
            || checksum_rules.contains(&finding.rule_id)
            || !finding.secret.is_ascii()
            || finding.file.starts_with('/')
            || finding.file.contains('\\')
        {
            return None;
        }
    }

    let shadowers: Vec<&Finding> =
        found.iter().filter(|finding| !is_false_positive(finding) && finding.rule_id != GENERIC_RULE).collect();
    let mut by_file: HashMap<&str, Vec<&Finding>> = HashMap::new();

    for finding in shadowers {
        by_file.entry(finding.file.as_str()).or_default().push(finding);
    }

    let shadowed = |finding: &Finding| {
        finding.rule_id == GENERIC_RULE
            && by_file
                .get(finding.file.as_str())
                .is_some_and(|others| others.iter().any(|other| overlaps(finding, other)))
    };

    Some(found.iter().filter(|finding| !shadowed(finding) && !is_false_positive(finding)).cloned().collect())
}

/// Masks the findings, as the report shows them, and drops the baselined ones.
fn shown(found: Vec<Finding>, baseline: &HashSet<String>) -> Vec<Finding> {
    found
        .into_iter()
        .filter_map(|finding| {
            let mut masked = finding.clone();

            masked.r#match = mask(&finding.r#match);
            masked.secret = mask(&finding.secret);

            let baselined = !baseline.is_empty()
                && baseline_keys(&finding)
                    .iter()
                    .chain(baseline_keys(&masked).iter())
                    .any(|key| baseline.contains(key));

            (!baselined).then_some(masked)
        })
        .collect()
}

/// A JS number: written as `Number#toString` writes it (`0`, not `0.0`).
struct JsNumber(f64);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        RawValue::from_string(json_number(self.0)).map_err(serde::ser::Error::custom)?.serialize(serializer)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonSpan {
    match_start: u32,
    match_end: u32,
    secret_start: u32,
    secret_end: u32,
}

/// The finding as `JSON.stringify` prints it after `toRelativeFinding`: required fields first, then
/// the optional ones in the order of the scanner's finding object, without `root`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonFinding<'a> {
    rule_id: &'a str,
    description: &'a str,
    file: &'a str,
    start_line: u32,
    end_line: u32,
    start_column: u32,
    end_column: u32,
    r#match: &'a str,
    secret: &'a str,
    entropy: JsNumber,
    tags: &'a [String],
    confidence: &'a str,
    alternate_matches: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decoded: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_span: Option<JsonSpan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    span_unavailable_reason: Option<&'a str>,
}

fn render_json(findings: &[Finding]) -> Option<String> {
    let rows: Vec<JsonFinding> = findings
        .iter()
        .map(|finding| JsonFinding {
            rule_id: &finding.rule_id,
            description: &finding.description,
            file: &finding.file,
            start_line: finding.start_line,
            end_line: finding.end_line,
            start_column: finding.start_column,
            end_column: finding.end_column,
            r#match: &finding.r#match,
            secret: &finding.secret,
            entropy: JsNumber(finding.entropy),
            tags: &finding.tags,
            confidence: &finding.confidence,
            alternate_matches: &finding.alternate_matches,
            source: finding.source.as_deref(),
            decoded: finding.decoded.as_deref(),
            source_span: finding.source_span.as_ref().map(|span| JsonSpan {
                match_start: span.match_start,
                match_end: span.match_end,
                secret_start: span.secret_start,
                secret_end: span.secret_end,
            }),
            span_unavailable_reason: finding.span_unavailable_reason.as_deref(),
        })
        .collect();

    Some(format!("{}\n", serde_json::to_string_pretty(&rows).ok()?))
}

/// The grouped text view without colour and without source context (findings are masked).
fn render_text(findings: &[Finding]) -> String {
    if findings.is_empty() {
        return "No secrets detected.\n".to_owned();
    }

    let mut order: Vec<&str> = Vec::new();
    let mut by_file: HashMap<&str, Vec<&Finding>> = HashMap::new();

    for finding in findings {
        if !by_file.contains_key(finding.file.as_str()) {
            order.push(&finding.file);
        }

        by_file.entry(&finding.file).or_default().push(finding);
    }

    let mut lines: Vec<String> = Vec::new();

    for file in order {
        lines.push(file.to_owned());

        for finding in &by_file[file] {
            let provenance: Vec<&str> = [finding.source.as_deref().unwrap_or(""), finding.confidence.as_str()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect();
            let suffix = if provenance.is_empty() { String::new() } else { format!(" ({})", provenance.join(", ")) };
            let alternates = if finding.alternate_matches.is_empty() {
                String::new()
            } else {
                format!(" also: {}", finding.alternate_matches.join(", "))
            };

            lines.push(format!(
                "  ✖ [{}]{suffix} line {}:{}{alternates}",
                finding.rule_id, finding.start_line, finding.start_column
            ));
            lines.push(String::new());
        }
    }

    format!("{}\n", lines.join("\n").trim_end())
}

/// `encodeURIComponent` over one path segment.
fn encode_segment(segment: &str) -> String {
    let mut out = String::new();

    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }

    out
}

/// A path as the SARIF `uri` of a root-relative file.
fn sarif_uri(file: &str) -> String {
    file.split('/').map(encode_segment).collect::<Vec<_>>().join("/")
}

/// The ICU root collation order of the characters rule ids use: `_ - .`, then digits, then letters.
/// Rule ids outside this alphabet have no order here (`None`).
fn collation_key(id: &str) -> Option<Vec<u8>> {
    id.bytes()
        .map(|byte| match byte {
            b'_' => Some(0),
            b'-' => Some(1),
            b'.' => Some(2),
            b'0'..=b'9' => Some(3 + (byte - b'0')),
            b'a'..=b'z' => Some(13 + (byte - b'a')),
            _ => None,
        })
        .collect()
}

/// SARIF's short description: at most 100 characters, cut with an ellipsis.
fn short_text(text: &str) -> Option<String> {
    if text.chars().count() <= 100 {
        return Some(text.to_owned());
    }

    // JS counts UTF-16 units and trims its own whitespace set.
    if !text.is_ascii() {
        return None;
    }

    Some(format!("{}…", text[..99].trim_end()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Text<'a> {
    text: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SarifRegion<'a> {
    end_column: u32,
    end_line: u32,
    snippet: Text<'a>,
    start_column: u32,
    start_line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SarifArtifact {
    uri: String,
    uri_base_id: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SarifPhysical<'a> {
    artifact_location: SarifArtifact,
    region: SarifRegion<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SarifLocation<'a> {
    physical_location: SarifPhysical<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SarifResultProperties<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a str>,
    confidence: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    alternate_rules: Option<&'a [String]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SarifResult<'a> {
    level: &'static str,
    locations: [SarifLocation<'a>; 1],
    message: Text<'a>,
    properties: SarifResultProperties<'a>,
    rule_id: &'a str,
    rule_index: usize,
}

#[derive(Serialize)]
struct Level {
    level: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleProperties<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<&'a str>,
}

impl RuleProperties<'_> {
    fn is_empty(&self) -> bool {
        self.tags.is_none() && self.source.is_none() && self.confidence.is_none()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SarifRule<'a> {
    default_configuration: Level,
    full_description: Text<'a>,
    help_uri: &'static str,
    id: &'a str,
    name: &'a str,
    #[serde(skip_serializing_if = "RuleProperties::is_empty")]
    properties: RuleProperties<'a>,
    short_description: Text<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SarifDriver<'a> {
    information_uri: &'static str,
    name: &'static str,
    rules: Vec<SarifRule<'a>>,
    version: &'static str,
}

#[derive(Serialize)]
struct Uri {
    uri: String,
}

#[derive(Serialize)]
struct BaseIds {
    #[serde(rename = "SRCROOT")]
    srcroot: Uri,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SarifRun<'a> {
    original_uri_base_ids: BaseIds,
    results: Vec<SarifResult<'a>>,
    tool: Tool<'a>,
}

#[derive(Serialize)]
struct Tool<'a> {
    driver: SarifDriver<'a>,
}

#[derive(Serialize)]
struct Sarif<'a> {
    #[serde(rename = "$schema")]
    schema: &'static str,
    runs: [SarifRun<'a>; 1],
    version: &'static str,
}

/// The `file://` URL of the root. Roots with a character that needs percent-encoding are left to
/// Node.
fn root_url(root: &Path) -> Option<String> {
    let text = root.to_str()?;

    text.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/-_.~".contains(&byte)).then(|| format!("file://{text}"))
}

fn render_sarif(findings: &[Finding], rules: &[RuleInfo], root: &Path) -> Option<String> {
    let by_id: HashMap<&str, &RuleInfo> = rules.iter().map(|rule| (rule.id.as_str(), rule)).collect();
    let mut ids: Vec<&str> = by_id.keys().copied().collect();

    for finding in findings {
        if !by_id.contains_key(finding.rule_id.as_str()) && !ids.contains(&finding.rule_id.as_str()) {
            ids.push(&finding.rule_id);
        }
    }

    let mut keyed = ids.into_iter().map(|id| Some((collation_key(id)?, id))).collect::<Option<Vec<_>>>()?;

    keyed.sort();

    let ids: Vec<&str> = keyed.into_iter().map(|(_, id)| id).collect();
    let index: HashMap<&str, usize> = ids.iter().enumerate().map(|(position, id)| (*id, position)).collect();

    let descriptions: Vec<String> = ids
        .iter()
        .map(|id| by_id.get(id).map_or_else(|| format!("Detected by rule `{id}`"), |rule| rule.description.clone()))
        .collect();
    let shorts: Vec<String> = descriptions.iter().map(|text| short_text(text)).collect::<Option<_>>()?;

    let sarif_rules: Vec<SarifRule> = ids
        .iter()
        .enumerate()
        .map(|(position, id)| {
            let meta = by_id.get(id);
            let properties = RuleProperties {
                tags: meta.map(|rule| rule.tags.as_slice()).filter(|tags| !tags.is_empty()),
                source: meta.and_then(|rule| rule.source.as_deref()).filter(|source| !source.is_empty()),
                confidence: meta.map(|rule| rule.confidence.as_str()).filter(|confidence| !confidence.is_empty()),
            };

            SarifRule {
                default_configuration: Level { level: "error" },
                full_description: Text { text: &descriptions[position] },
                help_uri: "https://visulima.com/packages/secret-scanner",
                id,
                name: id,
                properties,
                short_description: Text { text: &shorts[position] },
            }
        })
        .collect();

    let results: Vec<SarifResult> = findings
        .iter()
        .map(|finding| SarifResult {
            level: "error",
            locations: [SarifLocation {
                physical_location: SarifPhysical {
                    artifact_location: SarifArtifact { uri: sarif_uri(&finding.file), uri_base_id: "SRCROOT" },
                    region: SarifRegion {
                        end_column: finding.end_column,
                        end_line: finding.end_line,
                        snippet: Text { text: &finding.r#match },
                        start_column: finding.start_column,
                        start_line: finding.start_line,
                    },
                },
            }],
            message: Text {
                text: if finding.description.is_empty() { &finding.rule_id } else { &finding.description },
            },
            properties: SarifResultProperties {
                source: finding.source.as_deref().filter(|source| !source.is_empty()),
                confidence: &finding.confidence,
                alternate_rules: Some(finding.alternate_matches.as_slice()).filter(|rules| !rules.is_empty()),
            },
            rule_id: &finding.rule_id,
            rule_index: index.get(finding.rule_id.as_str()).copied().unwrap_or(0),
        })
        .collect();

    let log = Sarif {
        schema: "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0.json",
        runs: [SarifRun {
            original_uri_base_ids: BaseIds { srcroot: Uri { uri: root_url(root)? } },
            results,
            tool: Tool {
                driver: SarifDriver {
                    information_uri: "https://visulima.com/packages/secret-scanner",
                    name: "visulima-secret-scanner",
                    rules: sarif_rules,
                    version: TOOL_VERSION,
                },
            },
        }],
        version: "2.1.0",
    };

    Some(format!("{}\n", serde_json::to_string_pretty(&log).ok()?))
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

            let rules = list_rules(&options).unwrap_or_default();

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

fn write_stream(stream: &mut impl Write, text: &str) -> io::Result<()> {
    stream.write_all(text.as_bytes())?;
    stream.flush()
}

/// Answers `vis secrets` natively or hands the whole invocation to Node. `args` keeps the raw
/// argv for the delegation; the `String` view is only for matching. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let output = parse(args).and_then(|plan| answer(&plan, &context(args)?));

    let Some(output) = output else {
        crate::delegate(raw_args);
    };

    // Each stream is written even when the other fails.
    let results = [
        write_stream(&mut io::stdout().lock(), &output.stdout),
        write_stream(&mut io::stderr().lock(), &output.stderr),
    ];

    for result in results {
        // A closed pipe is not an error worth reporting.
        if let Err(error) = result {
            if error.kind() != io::ErrorKind::BrokenPipe {
                crate::error::WrapperError::write("secrets", "the output", error).exit();
            }
        }
    }

    exit(output.code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    fn finding(secret: &str, file: &str) -> Finding {
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
    fn masks_like_the_node_pipeline() {
        assert_eq!(mask("abcdef"), "******");
        assert_eq!(mask("abcdefg"), "abc*efg");
        assert_eq!(mask("abcdefghijklmnop"), "abc**********nop");
        assert_eq!(mask("äöüäöüä"), "äöü*öüä");
    }

    #[test]
    fn fingerprints_are_the_first_16_hex_digits_of_sha256() {
        assert_eq!(fingerprint("a", "b", "c").len(), 16);
        assert_eq!(fingerprint("a", "b", "c"), fingerprint("a", "b", "c"));
        assert_ne!(fingerprint("a", "b", "c"), fingerprint("a", "b", "d"));
    }

    #[test]
    fn sequences_uuids_and_punctuation_are_false_positives() {
        for secret in [
            "AAAAAAAA",
            "xxxxxx",
            "abcdefgh",
            "12345678",
            "ABCDEF",
            "89abcdef",
            "*****",
            "------",
            "123e4567-e89b-12d3-a456-426614174000",
        ] {
            assert!(is_false_positive(&finding(secret, "a.env")), "{secret}");
        }

        for secret in ["abcde", "Zx9fK2mQ", "abcdefgz", ""] {
            assert!(!is_false_positive(&finding(secret, "a.env")), "{secret}");
        }
    }

    #[test]
    fn lock_files_are_false_positives_unless_tagged_exposure() {
        assert!(is_false_positive(&finding("Zx9fK2mQ", "sub/yarn.lock")));
        assert!(!is_false_positive(&finding("Zx9fK2mQ", "sub/yarn.lock.txt")));

        let mut exposed = finding("Zx9fK2mQ", "package-lock.json");

        exposed.tags.push("exposure".to_owned());
        assert!(!is_false_positive(&exposed));
    }

    #[test]
    fn a_generic_finding_yields_to_an_overlapping_one() {
        let mut generic = finding("Zx9fK2mQ", "a.env");
        let mut specific = finding("Zx9fK2mQ", "a.env");

        generic.rule_id = GENERIC_RULE.to_owned();
        generic.end_column = 20;
        specific.start_column = 5;
        specific.end_column = 15;

        let kept = report_findings(vec![generic.clone(), specific], &HashSet::new()).unwrap();

        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].rule_id, "demo");

        // Touching spans do not overlap.
        let mut adjacent = finding("Zx9fK2mQ", "a.env");

        adjacent.start_column = 20;
        adjacent.end_column = 25;
        assert_eq!(report_findings(vec![generic, adjacent], &HashSet::new()).unwrap().len(), 2);
    }

    #[test]
    fn findings_that_need_node_are_not_reported_natively() {
        let checksum: HashSet<String> = ["demo".to_owned()].into();

        assert!(report_findings(vec![finding("Zx9fK2mQ", "a.env")], &checksum).is_none());
        assert!(report_findings(vec![finding("Zx9fK2mQ", "/abs/a.env")], &HashSet::new()).is_none());
        assert!(report_findings(vec![finding("Zx9fK2mÖ", "a.env")], &HashSet::new()).is_none());
    }

    #[test]
    fn integral_numbers_print_without_a_fraction() {
        let print = |value: f64| serde_json::to_string(&JsNumber(value)).unwrap();

        assert_eq!(print(0.0), "0");
        assert_eq!(print(3.0), "3");
        assert_eq!(print(4.75), "4.75");
        assert_eq!(print(3.251_629_114_151_001), "3.251629114151001");
    }

    #[test]
    fn rule_ids_sort_like_icu_root_collation() {
        let mut ids = ["kingfisher.a.2", "kingfisher.a.10", "a_b", "a-b", "a.b", "ab", "a1", "A"];
        let sortable: Vec<&str> = ids.iter().copied().filter(|id| collation_key(id).is_some()).collect();

        assert_eq!(sortable.len(), 7);

        ids.sort_by_key(|id| collation_key(id).unwrap_or_default());

        assert_eq!(&ids[1..], ["a_b", "a-b", "a.b", "a1", "ab", "kingfisher.a.10", "kingfisher.a.2"]);
    }

    #[test]
    fn only_root_collation_locales_get_a_native_sarif_report() {
        let allowed = |value: &str| {
            ["LC_ALL", "LANG"].iter().for_each(|name| env::remove_var(name));
            env::set_var("LANG", value);

            root_collation()
        };

        // One test mutates the environment, so the cases run in sequence here.
        assert!(allowed("C"));
        assert!(allowed("POSIX"));
        assert!(allowed("C.UTF-8"));
        assert!(allowed("en_US.UTF-8"));
        assert!(allowed("en_GB"));
        assert!(allowed(""));
        assert!(!allowed("cs_CZ.UTF-8"));
        assert!(!allowed("da_DK.UTF-8"));
        assert!(!allowed("sv_SE.UTF-8"));

        env::remove_var("LANG");
        env::set_var("LC_ALL", "cs_CZ.UTF-8");
        assert!(!root_collation());
        env::remove_var("LC_ALL");
        assert!(root_collation());
    }

    #[test]
    fn sarif_uris_encode_each_segment() {
        assert_eq!(sarif_uri("src/a b/c#d.env"), "src/a%20b/c%23d.env");
        assert_eq!(sarif_uri("a-b_c.d~e!f*g'h(i)"), "a-b_c.d~e!f*g'h(i)");
        assert_eq!(sarif_uri("é.env"), "%C3%A9.env");
    }

    #[test]
    fn long_descriptions_are_cut_with_an_ellipsis() {
        assert_eq!(short_text("short").as_deref(), Some("short"));
        assert_eq!(short_text(&"a".repeat(100)).as_deref(), Some("a".repeat(100).as_str()));
        assert_eq!(
            short_text(&format!("{}  {}", "a".repeat(98), "b".repeat(10))).as_deref(),
            Some(format!("{}…", "a".repeat(98)).as_str())
        );
        assert_eq!(short_text(&format!("é{}", "a".repeat(100))), None);
    }

    #[test]
    fn a_baseline_holds_each_entry_under_two_keys() {
        let directory = std::env::temp_dir().join(format!("vis-secrets-baseline-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();

        let path = directory.join("baseline.json");

        fs::write(&path, r#"[{"ruleId":"r","file":"a.env","startLine":3.0,"secret":"s"},{"ruleId":"r"},"x"]"#).unwrap();

        let set = load_baseline(&path).unwrap();

        assert_eq!(set.len(), 2);
        assert!(set.contains(&fingerprint("s", "r", "a.env")));
        assert!(set.contains("a.env:r:3"));

        fs::write(&path, "{").unwrap();
        assert!(load_baseline(&path).is_none());
        fs::write(&path, "{}").unwrap();
        assert!(load_baseline(&path).is_none());
        fs::remove_file(&path).unwrap();
        assert_eq!(load_baseline(&path), Some(HashSet::new()));
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_baseline_line_is_written_as_javascript_writes_a_number() {
        let directory = std::env::temp_dir().join(format!("vis-secrets-baseline-numbers-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();

        let path = directory.join("baseline.json");
        let entry = |line: &str| format!(r#"[{{"ruleId":"r","file":"a","startLine":{line},"secret":"s"}}]"#);
        let keys = |line: &str| {
            fs::write(&path, entry(line)).unwrap();
            load_baseline(&path).unwrap()
        };

        // Past 2^53 the line is the nearest double, as JSON.parse reads it, not the digits that were written.
        assert!(keys("9007199254740993").contains("a:r:9007199254740992"));
        // A line that is not whole, or that is big, has the text Number#toString gives it.
        assert!(keys("1.5").contains("a:r:1.5"));
        assert!(keys("1e21").contains("a:r:1e+21"));
        assert!(keys("1e-7").contains("a:r:1e-7"));
        assert!(keys("2e0").contains("a:r:2"));

        fs::remove_dir_all(&directory).unwrap();
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
    fn a_finding_prints_its_entropy_as_a_javascript_number() {
        let mut row = finding("s", "a");

        for (entropy, text) in [(0.0, "0"), (4.5, "4.5"), (3.0, "3"), (1e-7, "1e-7"), (2.5e21, "2.5e+21")] {
            row.entropy = entropy;
            assert!(
                render_json(std::slice::from_ref(&row)).unwrap().contains(&format!("\"entropy\": {text},")),
                "{entropy}"
            );
        }
    }

    #[test]
    fn the_text_view_groups_by_file() {
        let mut first = finding("Zx9fK2mQ", "a.env");
        let mut second = finding("Zx9fK2mQ", "b.env");

        first.source = Some("gitleaks".to_owned());
        second.alternate_matches = vec!["x".to_owned(), "y".to_owned()];

        let text = render_text(&[first, second]);

        assert_eq!(text, "a.env\n  ✖ [demo] (gitleaks, low) line 1:1\n\nb.env\n  ✖ [demo] (low) line 1:1 also: x, y\n");
        assert_eq!(render_text(&[]), "No secrets detected.\n");
    }
}
