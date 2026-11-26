//! How many runtime findings `checkRuntimeVersions` (`src/runtime/runtime-check.ts`) reports for a workspace root:
//! the count `vis status` prints. The text of a finding never reaches that output, so only whether each check fires
//! is reproduced, not its message or its severity (which is why `aube` on `PATH` does not matter here).
//!
//! The checks compare the root `package.json` (`engines.node`, `devEngines.runtime`, `packageManager`,
//! `devEngines.packageManager`) and `.nvmrc` / `.node-version` with the Node that runs the CLI and with the package
//! manager named in `npm_config_user_agent`. The Node is asked only when a Node pin exists, and it is the one the run
//! would be handed to (see [`crate::status`]). A version, a range or a file this module does not read the way
//! JavaScript does (non-ASCII text, a version component of more than 15 digits, a field whose type makes the
//! JavaScript throw) is `None`, which leaves the run to Node.

use std::cmp::Ordering;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde_json::{Map, Value};

/// The characters of JavaScript's `\s` and `String.prototype.trim` that can occur in ASCII text.
fn is_js_space(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r')
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// Whether JavaScript counts the value as true.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `text.split(/[.\-+]/).map((part) => Number.parseInt(part, 10) || 0)`: the leading digits of each part. `None` for
/// a part with more digits than a double holds exactly.
fn version_parts(text: &str) -> Option<Vec<u64>> {
    text.split(['.', '-', '+'])
        .map(|part| {
            let digits = part.bytes().take_while(u8::is_ascii_digit).count();

            if digits > 15 {
                return None;
            }

            Some(part[..digits].parse().unwrap_or(0))
        })
        .collect()
}

/// `compareVersions`: the order of two dotted versions, a missing component being zero.
fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let (a, b) = (version_parts(a)?, version_parts(b)?);

    for index in 0..a.len().max(b.len()) {
        let order = a.get(index).copied().unwrap_or(0).cmp(&b.get(index).copied().unwrap_or(0));

        if order != Ordering::Equal {
            return Some(order);
        }
    }

    Some(Ordering::Equal)
}

/// `satisfiesRange`: the subset of ranges the check reads (`>=`, `<=`, `>`, `<` and plain versions, joined by
/// whitespace); a clause it does not recognise is ignored, as in JavaScript.
fn satisfies_range(actual: &str, range: &str) -> Option<bool> {
    if !actual.is_ascii() || !range.is_ascii() {
        return None;
    }

    let range = js_trim(range);

    if range.is_empty() || range == "*" {
        return Some(true);
    }

    let actual_parts: Vec<&str> = actual.split('.').collect();

    for clause in range.split(is_js_space).filter(|clause| !clause.is_empty()) {
        let holds = if let Some(rest) = clause.strip_prefix(">=") {
            compare_versions(actual, js_trim(rest))? != Ordering::Less
        } else if let Some(rest) = clause.strip_prefix("<=") {
            compare_versions(actual, js_trim(rest))? != Ordering::Greater
        } else if let Some(rest) = clause.strip_prefix('>') {
            compare_versions(actual, js_trim(rest))? == Ordering::Greater
        } else if let Some(rest) = clause.strip_prefix('<') {
            compare_versions(actual, js_trim(rest))? == Ordering::Less
        } else if clause.starts_with(|character: char| character.is_ascii_digit()) {
            clause.split('.').enumerate().all(|(index, part)| actual_parts.get(index) == Some(&part))
        } else {
            true
        };

        if !holds {
            return Some(false);
        }
    }

    Some(true)
}

/// The Node of a run, asked at most once and only when a check needs it.
struct Node<'a> {
    ask: &'a mut dyn FnMut() -> Option<String>,
    known: Option<Option<String>>,
}

impl Node<'_> {
    /// `process.versions.node`: `X.Y.Z`.
    fn version(&mut self) -> Option<String> {
        let ask = &mut self.ask;

        self.known.get_or_insert_with(ask).clone()
    }
}

/// The entries of a `devEngines.<tool>` value that name a string: one object, or the objects of an array
/// (`devEnginesEntries`). An entry is its name, its `onFail` when that is a string, and its `version`.
fn dev_engine_entries(value: &Value) -> Vec<(&str, Option<&str>, Option<&Value>)> {
    let items: &[Value] = match value {
        Value::Array(items) => items,
        single => std::slice::from_ref(single),
    };

    items
        .iter()
        .filter_map(|item| {
            let Value::Object(entry) = item else {
                return None;
            };
            let name = entry.get("name")?.as_str()?;

            Some((name, entry.get("onFail").and_then(Value::as_str), entry.get("version")))
        })
        .collect()
}

/// `checkDevEngines`: whether the declaration is violated by `actual`. It is judged against the entries that name
/// `tool` and a string version: fine when one is satisfied, otherwise the last one decides, unless it has no
/// version or says `onFail: "ignore"`. `actual` is asked only when such an entry exists.
fn dev_engines_violated(value: Option<&Value>, tool: &str, actual: &mut dyn FnMut() -> Option<String>) -> Option<bool> {
    let Some(value) = value else {
        return Some(false);
    };

    let same_tool: Vec<(&str, Option<&str>)> = dev_engine_entries(value)
        .into_iter()
        .filter(|(name, _, _)| *name == tool)
        .filter_map(|(_, on_fail, version)| Some((version?.as_str()?, on_fail)))
        .collect();

    let Some(&(_, on_fail)) = same_tool.last() else {
        return Some(false);
    };

    let actual = actual()?;

    for (version, _) in &same_tool {
        if satisfies_range(&actual, version)? {
            return Some(false);
        }
    }

    // A last entry without a version is met by any `actual` above, so it never gets here.
    Some(on_fail.unwrap_or("warn") != "ignore")
}

/// `readNodeVersionFile` of `.nvmrc` / `.node-version`: the content of the first that can be read, trimmed and
/// without a leading `v`; `Some("")` for an empty one. A file that cannot be read is skipped, and one that is not
/// ASCII text is `None`.
fn pinned_node(root: &Path) -> Option<String> {
    for name in [".nvmrc", ".node-version"] {
        if fs::metadata(root.join(name)).is_err() {
            continue;
        }

        match fs::read_to_string(root.join(name)) {
            Ok(content) if content.is_ascii() => {
                let content = js_trim(&content);

                return Some(content.strip_prefix('v').unwrap_or(content).to_owned());
            }
            Ok(_) => return None,
            Err(error) if error.kind() == ErrorKind::InvalidData => return None,
            Err(_) => {}
        }
    }

    Some(String::new())
}

/// The running package manager of `npm_config_user_agent`: the name and the version of its first token.
fn running_package_manager(user_agent: &str) -> Option<(&str, &str)> {
    let token = user_agent.split(' ').next().unwrap_or("");

    if !token.is_ascii() || token.contains(is_js_space) {
        return None;
    }

    let mut parts = token.split('/');

    Some((parts.next().unwrap_or(""), parts.next().unwrap_or("")))
}

/// The number of findings for the root `root`, with `user_agent` the value of `npm_config_user_agent` and
/// `ask_node` the way to learn `process.versions.node` (`X.Y.Z`).
pub(crate) fn count_findings(
    root: &Path,
    user_agent: Option<&str>,
    ask_node: &mut dyn FnMut() -> Option<String>,
) -> Option<usize> {
    let text = match fs::read_to_string(root.join("package.json")) {
        Ok(text) => text,
        // A manifest that cannot be read has no findings in Node.
        Err(error) if error.kind() == ErrorKind::NotFound => return Some(0),
        Err(_) => return None,
    };
    let Value::Object(manifest) = serde_json::from_str::<Value>(&text).ok()? else {
        return None;
    };

    findings(&manifest, root, user_agent, ask_node)
}

fn findings(
    manifest: &Map<String, Value>,
    root: &Path,
    user_agent: Option<&str>,
    ask_node: &mut dyn FnMut() -> Option<String>,
) -> Option<usize> {
    let mut node = Node { ask: ask_node, known: None };
    let mut count = 0;

    // `engines.node`: a string range, or a truthy value `trim` would throw on.
    if let Some(Value::Object(engines)) = manifest.get("engines") {
        match engines.get("node") {
            Some(Value::String(range)) if !range.is_empty() => {
                count += usize::from(!satisfies_range(&node.version()?, range)?)
            }
            Some(value) if truthy(value) => return None,
            _ => {}
        }
    }

    let dev_engines = match manifest.get("devEngines") {
        Some(Value::Object(dev_engines)) => Some(dev_engines),
        _ => None,
    };

    count +=
        usize::from(dev_engines_violated(dev_engines.and_then(|fields| fields.get("runtime")), "node", &mut || {
            node.version()
        })?);

    // `.nvmrc` / `.node-version`: the major, and the minor when the pin has one.
    let pinned = pinned_node(root)?;

    if !pinned.is_empty() {
        let actual = node.version()?;
        let (mut wanted, mut running) = (pinned.split('.'), actual.split('.'));
        let (wanted_major, wanted_minor) = (wanted.next(), wanted.next());
        let (running_major, running_minor) = (running.next(), running.next());

        count +=
            usize::from(wanted_major != running_major || (wanted_minor.is_some() && wanted_minor != running_minor));
    }

    match manifest.get("packageManager") {
        Some(Value::String(pin)) if !pin.is_empty() => {
            let (running, running_version) = running_package_manager(user_agent.unwrap_or(""))?;
            let mut parts = pin.split('@');
            let (expected, expected_version) = (parts.next().unwrap_or(""), parts.next());

            let other_manager = !running.is_empty() && !expected.is_empty() && running != expected;
            let other_version = !running_version.is_empty()
                && expected_version.is_some_and(|version| !version.is_empty() && version != running_version);

            if other_manager || other_version {
                count += 1;
            }
        }
        // `split` on any other truthy value throws.
        Some(value) if truthy(value) => return None,
        // Without a pin, the package manager the CLI runs under is judged by `devEngines.packageManager`.
        _ => {
            if let Some(declared) = dev_engines.and_then(|fields| fields.get("packageManager")) {
                let (running, running_version) = running_package_manager(user_agent.unwrap_or(""))?;

                if !running.is_empty() && !running_version.is_empty() {
                    count += usize::from(dev_engines_violated(Some(declared), running, &mut || {
                        Some(running_version.to_owned())
                    })?);
                }
            }
        }
    }

    Some(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn satisfied(actual: &str, range: &str) -> bool {
        satisfies_range(actual, range) == Some(true)
    }

    #[test]
    fn ranges_read_the_clauses_the_check_knows() {
        assert!(satisfied("20.5.1", ">=18"));
        assert!(satisfied("20.5.1", ">=18 <21"));
        assert!(!satisfied("20.5.1", ">=18 <20"));
        assert!(!satisfied("20.5.1", ">20.5.1"));
        assert!(satisfied("20.5.1", "<=20.5.1"));
        assert!(satisfied("20.5.1", "20"));
        assert!(satisfied("20.5.1", "20.5"));
        assert!(!satisfied("20.5.1", "20.6"));
        assert!(!satisfied("20.5.1", "20.5.1.2"));
        assert!(satisfied("20.5.1", "*"));
        assert!(satisfied("20.5.1", "  "));
    }

    #[test]
    fn a_clause_it_does_not_know_is_ignored_and_a_caret_range_is_one_of_them() {
        assert!(satisfied("20.5.1", "^99"));
        assert!(satisfied("20.5.1", "lts/*"));
        assert!(satisfied("20.5.1", "~1.0.0 >=1"));
    }

    #[test]
    fn components_read_their_leading_digits() {
        assert_eq!(compare_versions("20.5.1", "20.5.1-beta.2"), Some(Ordering::Less));
        assert_eq!(compare_versions("1.x", "1.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("1.2", "1.10"), Some(Ordering::Less));
        assert_eq!(compare_versions("1.2.0", "1.2"), Some(Ordering::Equal));
        assert_eq!(compare_versions("1.2", ""), Some(Ordering::Greater));
        assert_eq!(compare_versions("1.1234567890123456", "1"), None);
    }

    #[test]
    fn text_javascript_would_read_differently_is_left_to_node() {
        assert_eq!(satisfies_range("20.5.1", ">=18\u{a0}<21"), None);
        assert_eq!(satisfies_range("2\u{a0}0", ">=1"), None);
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("json")
    }

    #[test]
    fn a_dev_engines_declaration_is_violated_only_when_no_entry_for_the_tool_is_met() {
        let mut node = || Some("20.5.1".to_owned());
        let mut violated = |text: &str| dev_engines_violated(Some(&json(text)), "node", &mut node);

        assert_eq!(violated(r#"{"name":"node","version":">=18"}"#), Some(false));
        assert_eq!(violated(r#"{"name":"node","version":">=99"}"#), Some(true));
        assert_eq!(violated(r#"{"name":"node","version":">=99","onFail":"ignore"}"#), Some(false));
        assert_eq!(violated(r#"{"name":"node","version":">=99","onFail":"error"}"#), Some(true));
        assert_eq!(violated(r#"{"name":"node","version":">=99","onFail":3}"#), Some(true));
        assert_eq!(violated(r#"[{"name":"node","version":">=99"},{"name":"node","version":">=18"}]"#), Some(false));
        assert_eq!(
            violated(r#"[{"name":"node","version":">=18"},{"name":"node","version":">=99","onFail":"ignore"}]"#),
            Some(false)
        );
        assert_eq!(violated(r#"{"name":"bun","version":">=99"}"#), Some(false));
        assert_eq!(violated(r#"{"name":"node"}"#), Some(false));
        assert_eq!(violated(r#"{"name":"node","version":5}"#), Some(false));
        assert_eq!(violated(r#"{"name":"node","version":""}"#), Some(false));
        assert_eq!(violated(r#"["node", null, []]"#), Some(false));
    }

    #[test]
    fn the_node_is_asked_only_when_a_check_needs_it() {
        let mut asked = 0;
        let mut ask = || {
            asked += 1;

            Some("20.5.1".to_owned())
        };

        assert_eq!(
            dev_engines_violated(Some(&json(r#"{"name":"bun","version":">=1"}"#)), "node", &mut ask),
            Some(false)
        );
        assert_eq!(dev_engines_violated(None, "node", &mut ask), Some(false));
        assert_eq!(asked, 0);
    }

    #[test]
    fn the_user_agent_names_the_running_package_manager() {
        assert_eq!(running_package_manager("pnpm/10.1.0 npm/? node/v24.0.0"), Some(("pnpm", "10.1.0")));
        assert_eq!(running_package_manager("pnpm"), Some(("pnpm", "")));
        assert_eq!(running_package_manager(""), Some(("", "")));
        assert_eq!(running_package_manager("a/b/c"), Some(("a", "b")));
        assert_eq!(running_package_manager("pnpm/1\t0"), None);
    }
}
