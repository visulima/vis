//! The startup toolchain preflight of `vis run` (`runToolchainPreflight` in `src/runtime/toolchain.ts`), answered
//! for the pins whose outcome is "nothing is printed and nothing is installed".
//!
//! Node reads every pin it knows (root `package.json` `engines` and `packageManager`, `.nvmrc`, `.node-version`,
//! the `volta` field, `.tool-versions`, mise and proto files), asks each pinned tool for its version
//! (`<tool> --version`, found by scanning `PATH`, two seconds at most) and compares the answer with the pin using a
//! small range matcher. Only when a pin is not met does it go on to print, install or warn. This module answers
//! the case in which every pin is met, and nothing else: whatever it cannot read, parse or compare exactly, a pin
//! it does not know how to probe, a probe that fails, and every mismatch is left to Node, which then runs the
//! whole preflight itself.
//!
//! Supported: pins on `node`, `pnpm` and `npm` from `engines`, `packageManager`, `.nvmrc` and `.node-version`.
//! Delegated: `volta`, `.tool-versions`, mise files, `.prototools`, and a pin on any other tool.

use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::run::is_js_whitespace;
use crate::term::parse_int;

/// Pins of other tools and managers that Node reads from files this module does not parse.
const UNSUPPORTED_FILES: [&str; 5] = [".tool-versions", ".prototools", ".mise.toml", "mise.toml", ".config/mise.toml"];

/// `queryManagerVersion` stops waiting after this long and reports no version.
const PROBE_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Tool {
    Node,
    Npm,
    Pnpm,
}

impl Tool {
    fn binary(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
        }
    }
}

/// What `normalizeToolName` makes of a pin's tool name: a tool this module probes, one it does not (the whole
/// preflight then goes to Node), or a name Node ignores.
enum Named {
    Known(Tool),
    Unsupported,
    Ignored,
}

fn named(raw: &str) -> Named {
    match raw.to_ascii_lowercase().as_str() {
        "node" | "nodejs" => Named::Known(Tool::Node),
        "npm" => Named::Known(Tool::Npm),
        "pnpm" => Named::Known(Tool::Pnpm),
        "aube" | "bun" | "go" | "golang" | "python" | "python3" | "ruby" | "rust" | "rustc" | "yarn" => {
            Named::Unsupported
        }
        _ => Named::Ignored,
    }
}

/// Whether a JavaScript value is falsy (`if (rootPkg.engines)`): the cases a JSON file can hold.
fn falsy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::Bool(flag) => !flag,
        serde_json::Value::Number(number) => number.as_f64() == Some(0.0),
        serde_json::Value::String(text) => text.is_empty(),
        _ => false,
    }
}

/// Printable ASCII, so the string means the same to a regular expression and to a byte comparison.
fn plain_ascii(text: &str) -> bool {
    text.bytes().all(|byte| byte.is_ascii_graphic() || byte == b' ')
}

/// The pins of a workspace that this module can decide, one range per tool.
pub struct Pins(BTreeMap<Tool, String>);

/// The pins of the workspace in the order Node merges them (a later source of the same tool wins), or `None` for
/// anything this module does not decide.
fn read_pins(root: &Path) -> Option<BTreeMap<Tool, String>> {
    if UNSUPPORTED_FILES.iter().any(|name| root.join(name).symlink_metadata().is_ok()) {
        return None;
    }

    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(root.join("package.json")).ok()?).ok()?;
    let manifest = manifest.as_object()?;
    let mut pins = BTreeMap::new();

    if manifest.contains_key("volta") {
        return None;
    }

    if let Some(engines) = manifest.get("engines").filter(|value| !falsy(value)) {
        // The map holds the keys sorted, Node walks them in file order and the last alias of a tool wins
        // (`nodejs` and `node` are one tool); two string-valued aliases are left to Node.
        let mut seen = Vec::new();

        for (name, version) in engines.as_object()? {
            match named(name) {
                Named::Known(tool) => {
                    if let Some(version) = version.as_str() {
                        if seen.contains(&tool) {
                            return None;
                        }

                        seen.push(tool);
                        pins.insert(tool, version.to_owned());
                    }
                }
                Named::Unsupported => {
                    if version.is_string() {
                        return None;
                    }
                }
                Named::Ignored => {}
            }
        }
    }

    if let Some(field) = manifest.get("packageManager").filter(|value| !falsy(value)) {
        let field = field.as_str()?;

        if !plain_ascii(field) {
            return None;
        }

        // `parsePackageManagerField`: the part before the first `+`, then `^(pnpm|yarn|npm|bun)@(.+)$`.
        let head = field.split('+').next().unwrap_or_default();

        if let Some((name, version)) = head.split_once('@') {
            if matches!(name, "pnpm" | "yarn" | "npm" | "bun") && !version.is_empty() {
                match named(name) {
                    Named::Known(tool) => {
                        pins.insert(tool, version.to_owned());
                    }
                    _ => return None,
                }
            }
        }
    }

    // `readVersionFile`: the first of the two files that has any content.
    for name in [".nvmrc", ".node-version"] {
        let path = root.join(name);

        // `isAccessibleSync`: a dangling link is not there.
        if !path.exists() {
            continue;
        }

        let content = fs::read_to_string(&path).ok()?;

        if !content.is_ascii() {
            return None;
        }

        let content = content.trim_matches(is_js_whitespace);

        if content.is_empty() {
            continue;
        }

        pins.insert(Tool::Node, content.strip_prefix('v').unwrap_or(content).to_owned());

        break;
    }

    Some(pins)
}

/// `isOnPath`: the first `PATH` entry that holds `binary` (any file that exists, executable or not), with the
/// quote and space handling of Node's scan.
fn on_path(binary: &str) -> Option<PathBuf> {
    let path = env::var("PATH").ok().filter(|path| !path.is_empty())?;

    for raw in path.split(':') {
        let stripped = raw.strip_prefix(['"', '\'']).unwrap_or(raw);
        let stripped = stripped.strip_suffix(['"', '\'']).unwrap_or(stripped);
        let directory = stripped.trim_matches(is_js_whitespace);

        if directory.is_empty() {
            continue;
        }

        let candidate = PathBuf::from(format!("{directory}/{binary}"));

        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

/// The first `\d+\.\d+(?:\.\d+)?` of a text.
fn first_version(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();

    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() || (start > 0 && bytes[start - 1].is_ascii_digit()) {
            continue;
        }

        let mut end = start;

        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }

        if bytes.get(end) != Some(&b'.') || !bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
            continue;
        }

        end += 1;

        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }

        if bytes.get(end) == Some(&b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
            end += 1;

            while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
        }

        return Some(&text[start..end]);
    }

    None
}

/// The most a probe may print: a version string is a few dozen bytes, so more than this is a tool that is not
/// answering the question, and the probe fails like any other it cannot decide.
const PROBE_OUTPUT_LIMIT: usize = 4096;

/// Ends a probe that is not wanted any more: the child and, on unix, everything it started in its group, so no
/// descendant keeps the output pipe (and the reader thread) alive.
fn stop(child: &mut std::process::Child) {
    #[cfg(unix)]
    if let Ok(group) = i32::try_from(child.id()) {
        // SAFETY: `killpg` takes plain integers; the child is its own group leader (see `query_output`).
        unsafe { libc::killpg(group, libc::SIGKILL) };
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// Runs `<binary> --version` in the working directory with nothing on stdin and stderr discarded, waits two
/// seconds at most, and returns what it printed. `None` for a failure to start, a non-zero exit, a timeout, more
/// than [`PROBE_OUTPUT_LIMIT`] bytes of output, or output that is not UTF-8.
fn query_output(binary: &Path) -> Option<String> {
    let started = Instant::now();
    let mut command = Command::new(binary);

    command.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());

    // Its own process group, so that a timeout can end the tool's descendants as well.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);

    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();

    // The reader takes one byte past the limit and lets go of the pipe, so it never holds more than that.
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout.take(PROBE_OUTPUT_LIMIT as u64 + 1).read_to_end(&mut bytes);

        let _ = sender.send(read.ok().filter(|_| bytes.len() <= PROBE_OUTPUT_LIMIT).map(|_| bytes));
    });

    let mut output = None;
    let status = loop {
        // The reader is done at the end of the output or at the limit: too much output ends the probe at once.
        if output.is_none() {
            if let Ok(bytes) = receiver.try_recv() {
                if bytes.is_none() {
                    stop(&mut child);

                    return None;
                }

                output = Some(bytes);
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => std::thread::sleep(Duration::from_micros(500)),
            _ => {
                stop(&mut child);

                return None;
            }
        }
    };

    // The pipe closes with the process unless a child of it keeps it open; that is bounded by the same two seconds.
    let bytes = match output {
        Some(bytes) => bytes,
        None => {
            let remaining = PROBE_TIMEOUT.saturating_sub(started.elapsed()).max(Duration::from_millis(50));

            match receiver.recv_timeout(remaining) {
                Ok(bytes) => bytes,
                Err(_) => {
                    stop(&mut child);

                    return None;
                }
            }
        }
    };

    status.success().then_some(bytes).flatten().and_then(|bytes| String::from_utf8(bytes).ok())
}

/// What `<binary> --version` printed, keyed by the binary's file and the name it is invoked by. A multi-call binary
/// (a version manager's shim, linked under `node`, `npm` and `pnpm`) picks its tool from that name, so one file
/// under two names is two answers; the same file under the same name is one. A tool is asked once.
#[derive(Default)]
pub struct Versions {
    known: BTreeMap<(PathBuf, OsString), Option<String>>,
}

fn file_of(binary: &Path) -> PathBuf {
    fs::canonicalize(binary).unwrap_or_else(|_| binary.to_path_buf())
}

fn key_of(binary: &Path) -> (PathBuf, OsString) {
    (file_of(binary), binary.file_name().map(OsString::from).unwrap_or_default())
}

impl Versions {
    /// The launcher's own Node reports its version without being asked again: `process.version` is what
    /// `node --version` prints for the same binary (plus a newline), for a `node` that is that binary's file.
    pub fn with_launcher_node(node: Option<&str>, version: Option<&str>) -> Self {
        let mut known = BTreeMap::new();

        if let (Some(node), Some(version)) = (node, version) {
            known.insert((file_of(Path::new(node)), OsString::from("node")), Some(format!("{version}\n")));
        }

        Self { known }
    }

    /// The output of `<binary> --version`, asking when it is not known yet.
    pub fn output(&mut self, binary: &Path) -> Option<String> {
        self.fetch(&[binary.to_path_buf()]);

        self.known.get(&key_of(binary)).cloned().flatten()
    }

    /// Asks for several binaries at once, the ones not known yet.
    pub fn fetch(&mut self, binaries: &[PathBuf]) {
        let mut unknown: Vec<((PathBuf, OsString), &PathBuf)> = Vec::new();

        for binary in binaries {
            let key = key_of(binary);

            if !self.known.contains_key(&key) && !unknown.iter().any(|(known, _)| *known == key) {
                unknown.push((key, binary));
            }
        }

        let answers: Vec<Option<String>> = if unknown.len() < 2 {
            unknown.iter().map(|(_, binary)| query_output(binary)).collect()
        } else {
            std::thread::scope(|scope| {
                let handles: Vec<_> = unknown.iter().map(|(_, binary)| scope.spawn(|| query_output(binary))).collect();

                handles.into_iter().map(|handle| handle.join().ok().flatten()).collect()
            })
        };

        for ((key, _), answer) in unknown.into_iter().zip(answers) {
            self.known.insert(key, answer);
        }
    }
}

/// `queryManagerVersion`: the first version number in the output of `<binary> --version`.
fn version_of(versions: &mut Versions, binary: &Path) -> Option<String> {
    first_version(&versions.output(binary)?).map(str::to_owned)
}

/// `Number.parseInt(part, 10) || 0` for the parts of a version.
fn part(text: &str) -> Option<i64> {
    // Numbers that a JavaScript double would round are not compared here.
    let digits = text.trim_start().trim_start_matches(['+', '-']).bytes().take_while(u8::is_ascii_digit).count();

    if digits > 15 {
        return None;
    }

    Some(parse_int(text).unwrap_or(0))
}

fn parts(version: &str) -> Option<Vec<i64>> {
    version.split(['.', '-', '+']).map(part).collect()
}

fn compare(a: &[i64], b: &[i64]) -> std::cmp::Ordering {
    (0..a.len().max(b.len()))
        .map(|index| a.get(index).copied().unwrap_or(0).cmp(&b.get(index).copied().unwrap_or(0)))
        .find(|ordering| ordering.is_ne())
        .unwrap_or(std::cmp::Ordering::Equal)
}

/// `/^\d[\d.]*$/`
fn is_exact_version(text: &str) -> bool {
    text.as_bytes().first().is_some_and(u8::is_ascii_digit)
        && text.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.')
}

/// One whitespace-separated group of clauses of a range (`matchesAll`). `None` is a number this matcher would
/// not compare the way JavaScript does.
fn matches_all(actual: &[i64], clauses: &[&str]) -> Option<bool> {
    for clause in clauses {
        let (operator, rest) = if let Some(rest) = clause.strip_prefix(">=") {
            (">=", rest)
        } else if let Some(rest) = clause.strip_prefix("<=") {
            ("<=", rest)
        } else if let Some(rest) = clause.strip_prefix('>') {
            (">", rest)
        } else if let Some(rest) = clause.strip_prefix('<') {
            ("<", rest)
        } else if let Some(rest) = clause.strip_prefix('^') {
            ("^", rest)
        } else if let Some(rest) = clause.strip_prefix('~') {
            ("~", rest)
        } else {
            // A clause the matcher does not know passes.
            continue;
        };
        let target = parts(rest.trim_matches(is_js_whitespace))?;
        let ordering = compare(actual, &target);
        let passes = match operator {
            ">=" => ordering.is_ge(),
            "<=" => ordering.is_le(),
            ">" => ordering.is_gt(),
            "<" => ordering.is_lt(),
            _ => {
                // `actualMajor !== targetMajor`, and for `~` also the minors, where a missing minor is `undefined`.
                actual.first() == target.first()
                    && (operator == "^" || actual.get(1) == target.get(1))
                    && ordering.is_ge()
            }
        };

        if !passes {
            return Some(false);
        }
    }

    Some(true)
}

/// `satisfies(actual, range)` of the toolchain module: a deliberately small range matcher whose quirks (a clause
/// it does not know passes, `||` alternatives, `^`/`~` by major and minor only) are part of the answer.
fn satisfies(actual: &str, range: &str) -> Option<bool> {
    let normalized = range.trim_matches(is_js_whitespace);

    if matches!(normalized, "" | "*" | "latest") {
        return Some(true);
    }

    if is_exact_version(normalized) {
        return Some(actual == normalized || actual.starts_with(&format!("{normalized}.")));
    }

    let actual = parts(actual)?;
    let mut alternatives = 0;

    for alternative in normalized.split("||") {
        let clauses: Vec<&str> = alternative
            .trim_matches(is_js_whitespace)
            .split(is_js_whitespace)
            .filter(|clause| !clause.is_empty())
            .collect();

        if clauses.is_empty() {
            continue;
        }

        alternatives += 1;

        if matches_all(&actual, &clauses)? {
            return Some(true);
        }
    }

    Some(alternatives == 0)
}

impl Pins {
    /// The pins of the workspace, or `None` when Node reads one this module does not decide (the preflight then
    /// belongs to Node whole).
    pub fn read(root: &Path) -> Option<Self> {
        read_pins(root).map(Self)
    }

    /// Whether no pin is read, so no tool is asked.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The binaries that report the pinned tools' versions, in the order of [`Pins::are_met`]; `None` when a
    /// pinned tool is not on `PATH`, which Node reads as a mismatch (and for Node itself as a fallback to the
    /// running process that only Node knows).
    pub fn binaries(&self) -> Option<Vec<PathBuf>> {
        self.0.keys().map(|tool| on_path(tool.binary())).collect()
    }

    /// Whether Node's toolchain preflight prints and installs nothing: every pinned tool reports a version that
    /// meets its pin. `versions` has to hold the answers of `binaries` (see [`Versions::fetch`]).
    pub fn are_met(&self, binaries: &[PathBuf], versions: &mut Versions) -> bool {
        self.0.values().zip(binaries).all(|(range, binary)| {
            version_of(versions, binary).is_some_and(|actual| satisfies(&actual, range) == Some(true))
        })
    }
}

/// Where a command name resolves the way the process start does: a name with a `/` as it is, any other name in
/// the first `PATH` entry that holds an executable file of that name (an empty entry is the working directory).
pub fn resolve_command(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        return Some(PathBuf::from(name));
    }

    let path = env::var("PATH").ok()?;

    path.split(':')
        .map(|directory| if directory.is_empty() { PathBuf::from(".") } else { PathBuf::from(directory) }.join(name))
        .find(|candidate| fs::metadata(candidate).is_ok_and(|meta| meta.is_file() && is_executable(&meta)))
}

#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_like_the_regular_expression() {
        assert_eq!(first_version("v22.1.0\n"), Some("22.1.0"));
        assert_eq!(first_version("pnpm 10.0 beta"), Some("10.0"));
        assert_eq!(first_version("go version go1.22.3 darwin/arm64"), Some("1.22.3"));
        assert_eq!(first_version("12.15.0"), Some("12.15.0"));
        assert_eq!(first_version("10"), None);
        assert_eq!(first_version("a.b"), None);
        assert_eq!(first_version("1.2.3.4"), Some("1.2.3"));
        assert_eq!(first_version("v1."), None);
        assert_eq!(first_version("x 7 y 8.9"), Some("8.9"));
    }

    fn ok(actual: &str, range: &str) -> bool {
        satisfies(actual, range) == Some(true)
    }

    #[test]
    fn exact_pins_match_by_prefix() {
        assert!(ok("10.32.1", "10.32.1"));
        assert!(ok("10.32.1", "10"));
        assert!(ok("10.32.1", "10.32"));
        assert!(!ok("10.32.1", "10.3"));
        assert!(!ok("10.32.1", "11"));
        assert!(!ok("101.0.0", "10"));
        assert!(ok("22.1.0", ""));
        assert!(ok("22.1.0", "*"));
        assert!(ok("22.1.0", " latest "));
    }

    #[test]
    fn comparison_ranges() {
        assert!(ok("22.1.0", ">=20"));
        assert!(ok("22.1.0", ">=22.1.0"));
        assert!(!ok("22.1.0", ">=22.1.1"));
        assert!(ok("22.1.0", ">=20 <23"));
        assert!(!ok("23.0.0", ">=20 <23"));
        assert!(ok("22.1.0", ">21"));
        assert!(!ok("22.1.0", ">22.1.0"));
        assert!(ok("22.1.0", "<=22.1.0"));
        assert!(!ok("22.1.1", "<=22.1.0"));
    }

    #[test]
    fn caret_and_tilde_compare_major_and_minor_only() {
        assert!(ok("22.1.0", "^22"));
        assert!(ok("22.5.0", "^22.1.0"));
        assert!(!ok("22.0.0", "^22.1.0"));
        assert!(!ok("23.0.0", "^22"));
        assert!(ok("22.1.4", "~22.1.0"));
        assert!(!ok("22.2.0", "~22.1.0"));
        // A missing minor in the range is `undefined`, which no actual minor equals.
        assert!(!ok("22.1.0", "~22"));
    }

    #[test]
    fn alternatives_and_unknown_clauses() {
        assert!(ok("22.1.0", "^20 || ^22"));
        assert!(!ok("21.0.0", "^20 || ^22"));
        // A clause the matcher does not know passes, so the whole group does.
        assert!(ok("22.1.0", "20.x"));
        assert!(ok("22.1.0", ">=20 20.x"));
        assert!(!ok("18.0.0", ">=20 20.x"));
        assert!(ok("22.1.0", "lts/iron"));
        assert!(ok("22.1.0", " || "));
        assert!(ok("22.1.0", "=22"));
    }

    #[test]
    fn numbers_a_double_would_round_are_not_compared() {
        assert_eq!(satisfies("22.1.0", ">=99999999999999999999"), None);
    }

    #[test]
    fn tool_names_follow_the_aliases() {
        assert!(matches!(named("Node"), Named::Known(Tool::Node)));
        assert!(matches!(named("nodejs"), Named::Known(Tool::Node)));
        assert!(matches!(named("pnpm"), Named::Known(Tool::Pnpm)));
        assert!(matches!(named("yarn"), Named::Unsupported));
        assert!(matches!(named("golang"), Named::Unsupported));
        assert!(matches!(named("vscode"), Named::Ignored));
    }

    /// A fresh directory under the system temp directory.
    fn scratch(name: &str) -> PathBuf {
        let directory = env::temp_dir().join(format!("vis-toolchain-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();

        directory
    }

    #[test]
    fn two_aliases_of_one_tool_are_left_to_node() {
        let root = scratch("aliases");

        for engines in [
            r#"{"nodejs": ">=20", "node": ">=99"}"#,
            r#"{"node": ">=99", "nodejs": ">=20"}"#,
            r#"{"node": ">=20", "Node": ">=20"}"#,
        ] {
            fs::write(root.join("package.json"), format!(r#"{{"engines": {engines}}}"#)).unwrap();

            assert!(read_pins(&root).is_none(), "{engines}");
        }

        // One alias, or an alias whose value Node ignores, is a plain pin.
        for engines in
            [r#"{"nodejs": ">=20"}"#, r#"{"nodejs": ">=20", "node": 22}"#, r#"{"node": ">=20", "npm": ">=9"}"#]
        {
            fs::write(root.join("package.json"), format!(r#"{{"engines": {engines}}}"#)).unwrap();

            assert!(read_pins(&root).is_some(), "{engines}");
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn one_file_under_two_names_is_two_answers() {
        use std::os::unix::fs::symlink;

        let root = scratch("shims");
        let shim = root.join("shim");

        // A multi-call binary: it answers by the name it is started under.
        fs::write(
            &shim,
            "#!/bin/sh\ncase \"$0\" in */node) echo v22.1.0;; */npm) echo 10.5.0;; *) echo 9.0.0;; esac\n",
        )
        .unwrap();
        fs::set_permissions(&shim, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        symlink(&shim, root.join("node")).unwrap();
        symlink(&shim, root.join("npm")).unwrap();

        let mut versions = Versions::default();

        assert_eq!(versions.output(&root.join("node")).as_deref(), Some("v22.1.0\n"));
        assert_eq!(versions.output(&root.join("npm")).as_deref(), Some("10.5.0\n"));
        // The same file under the same name (another path to it) is one answer, asked once.
        assert_eq!(versions.known.len(), 2);
        assert_eq!(versions.output(&root.join(".").join("npm")).as_deref(), Some("10.5.0\n"));
        assert_eq!(versions.known.len(), 2);

        // The launcher's version is for a `node` that is the launcher's file, not for the other names of it.
        let mut launcher = Versions::with_launcher_node(root.join("node").to_str(), Some("v1.2.3"));

        assert_eq!(launcher.output(&root.join("node")).as_deref(), Some("v1.2.3\n"));
        assert_eq!(launcher.output(&root.join("npm")).as_deref(), Some("10.5.0\n"));

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    fn script(root: &Path, name: &str, body: &str) -> PathBuf {
        let path = root.join(name);

        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

        path
    }

    #[cfg(unix)]
    #[test]
    fn a_probe_that_prints_too_much_fails_at_once() {
        let root = scratch("noisy");
        // Ends only when the reader lets go of the pipe; without a limit it would print for a long time first.
        let tool = script(&root, "noisy", "while :; do echo v1.2.3 v1.2.3 v1.2.3 v1.2.3 v1.2.3 v1.2.3; done");
        let started = Instant::now();

        assert_eq!(query_output(&tool), None);
        assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());

        // A short answer is unaffected, and so is one at the limit.
        let short = script(&root, "short", "echo v1.2.3");

        assert_eq!(query_output(&short).as_deref(), Some("v1.2.3\n"));

        let exact = script(&root, "exact", &format!("head -c {PROBE_OUTPUT_LIMIT} /dev/zero | tr '\\0' 'a'"));

        assert_eq!(query_output(&exact).map(|text| text.len()), Some(PROBE_OUTPUT_LIMIT));

        let over = script(&root, "over", &format!("head -c {} /dev/zero | tr '\\0' 'a'", PROBE_OUTPUT_LIMIT + 1));

        assert_eq!(query_output(&over), None);

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_descendant_that_keeps_the_pipe_open_is_ended_with_the_probe() {
        let root = scratch("holder");
        let pid_file = root.join("holder.pid");
        // The tool answers and exits at once; the sleep it left behind holds the pipe's write end.
        let tool = script(&root, "holder", &format!("sleep 30 &\necho $! > {}\necho v1.2.3", pid_file.display()));
        let started = Instant::now();

        assert_eq!(query_output(&tool), None);
        assert!(started.elapsed() < Duration::from_millis(3500), "{:?}", started.elapsed());

        let pid = fs::read_to_string(&pid_file).unwrap().trim().to_owned();

        // Give the kernel a moment to reap it; the group was killed with the probe.
        std::thread::sleep(Duration::from_millis(200));

        let alive = Command::new("kill").args(["-0", &pid]).stderr(Stdio::null()).status().unwrap().success();

        assert!(!alive, "the descendant {pid} is still running");

        let _ = fs::remove_dir_all(&root);
    }
}
