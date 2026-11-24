//! The steps Node applies to the sorted object before it writes it: `restoreUnsortedSections`,
//! `applySortOrder` (both in `src/commands/sort-package-json/handler.ts`) and `formatPackageJsonFields`
//! (`src/util/format-package-json-fields.ts`). Each works on the ordered [`Json`] tree.

use super::json::Json;

/// The condition names of `exports` objects, in the order they are listed first.
const CANONICAL_EXPORT_CONDITIONS: [&str; 6] = ["types", "node-addons", "node", "import", "require", "default"];

/// The three cosmetic rewrites, each on unless switched off.
#[derive(Clone, Copy)]
pub struct Format {
    pub bugs: bool,
    pub repository: bool,
    pub exports: bool,
}

/// `restoreUnsortedSections`: each listed top-level key takes the value it had in the original file, in the
/// place it has in the sorted one (a key the sorted object lacks goes last).
pub fn restore_unsorted(
    sorted: Vec<(String, Json)>,
    original: &[(String, Json)],
    unsorted: &[String],
) -> Vec<(String, Json)> {
    let mut result = sorted;

    for key in unsorted {
        let Some((_, value)) = original.iter().find(|(name, _)| name == key) else {
            continue;
        };

        match result.iter_mut().find(|(name, _)| name == key) {
            Some(entry) => entry.1 = value.clone(),
            None => result.push((key.clone(), value.clone())),
        }
    }

    result
}

/// `applySortOrder`: the listed top-level keys first, in the listed order, then the others as they were.
pub fn apply_sort_order(object: Vec<(String, Json)>, order: &[String]) -> Vec<(String, Json)> {
    if order.is_empty() {
        return object;
    }

    let mut first: Vec<(String, Json)> = Vec::new();

    for key in order {
        if first.iter().all(|(name, _)| name != key) {
            if let Some(entry) = object.iter().find(|(name, _)| name == key) {
                first.push(entry.clone());
            }
        }
    }

    let rest: Vec<(String, Json)> =
        object.into_iter().filter(|(name, _)| first.iter().all(|(taken, _)| taken != name)).collect();

    first.extend(rest);

    first
}

/// `formatPackageJsonFields`, on the top-level object.
pub fn format_fields(object: &mut [(String, Json)], format: Format) {
    for (key, value) in object.iter_mut() {
        match key.as_str() {
            "bugs" if format.bugs => format_bugs(value),
            "repository" if format.repository => format_repository(value),
            "exports" if format.exports => sort_exports(value),
            _ => {}
        }
    }
}

/// `{ "url": "…" }` becomes the bare string.
fn format_bugs(value: &mut Json) {
    if let Json::Object(entries) = value {
        if let [(key, Json::Str(url))] = entries.as_slice() {
            if key == "url" {
                *value = Json::Str(url.clone());
            }
        }
    }
}

/// `{ "type": "git", "url": "git+https://github.com/owner/repo.git" }` becomes `owner/repo`.
fn format_repository(value: &mut Json) {
    let Json::Object(entries) = &*value else {
        return;
    };

    if matches!(value.get("directory"), Some(Json::Str(directory)) if !directory.is_empty()) {
        return;
    }

    // `type` may be absent or `"git"`; any other value (even `null`) keeps the object.
    if value.get("type").is_some_and(|kind| kind.as_str() != Some("git")) {
        return;
    }

    let Some(Json::Str(url)) = value.get("url") else {
        return;
    };

    if entries.iter().any(|(key, _)| key != "type" && key != "url") {
        return;
    }

    if let Some(shorthand) = github_shorthand(url) {
        *value = Json::Str(shorthand);
    }
}

/// `owner/repo` for `git+https://github.com/owner/repo[.git]` and `git+ssh://git@github.com/owner/repo[.git]`.
/// The repo name has no `.` and no `/`, like the regular expressions of the Node code
/// (`^git\+https:\/\/github\.com\/([^/]+)\/([^/.]+(?:\.git)?)$`).
fn github_shorthand(url: &str) -> Option<String> {
    let rest = url.strip_prefix("git+https://github.com/").or_else(|| url.strip_prefix("git+ssh://git@github.com/"))?;
    let (owner, repository) = rest.split_once('/')?;

    if owner.is_empty() {
        return None;
    }

    // `[^/.]+` then an optional `.git`: a name of at least one character, with no `/` or `.` in it.
    let name = repository.strip_suffix(".git").unwrap_or(repository);

    if name.is_empty() || name.contains(['/', '.']) {
        return None;
    }

    Some(format!("{owner}/{name}"))
}

/// Orders the keys of every plain object under `exports` (arrays are not entered): the canonical conditions
/// first, in canonical order, then every other key in its original order.
fn sort_exports(value: &mut Json) {
    let Json::Object(entries) = value else {
        return;
    };

    for (_, child) in entries.iter_mut() {
        sort_exports(child);
    }

    order_conditions(entries);
}

fn order_conditions(entries: &mut Vec<(String, Json)>) {
    let mut ordered: Vec<(String, Json)> = Vec::with_capacity(entries.len());

    for canonical in CANONICAL_EXPORT_CONDITIONS {
        if let Some(entry) = entries.iter().find(|(name, _)| name == canonical) {
            ordered.push(entry.clone());
        }
    }

    ordered.extend(entries.iter().filter(|(name, _)| !CANONICAL_EXPORT_CONDITIONS.contains(&name.as_str())).cloned());

    *entries = ordered;
}

#[cfg(test)]
mod tests {
    use super::super::json::{parse, stringify};
    use super::*;

    fn formatted(text: &str, format: Format) -> String {
        let Some(Json::Object(mut entries)) = parse(text) else {
            panic!("not an object: {text}");
        };

        format_fields(&mut entries, format);

        stringify(&Json::Object(entries), "")
    }

    const ALL: Format = Format { bugs: true, repository: true, exports: true };

    #[test]
    fn bugs_with_only_a_url_collapse() {
        assert_eq!(formatted(r#"{"bugs":{"url":"https://x"}}"#, ALL), r#"{"bugs":"https://x"}"#);
        assert_eq!(
            formatted(r#"{"bugs":{"url":"https://x","email":"a"}}"#, ALL),
            r#"{"bugs":{"url":"https://x","email":"a"}}"#
        );
        assert_eq!(formatted(r#"{"bugs":{"url":1}}"#, ALL), r#"{"bugs":{"url":1}}"#);
        assert_eq!(
            formatted(r#"{"bugs":{"url":"https://x"}}"#, Format { bugs: false, ..ALL }),
            r#"{"bugs":{"url":"https://x"}}"#
        );
    }

    #[test]
    fn github_repositories_collapse_to_the_shorthand() {
        let cases = [
            (r#"{"repository":{"type":"git","url":"git+https://github.com/a/b.git"}}"#, r#"{"repository":"a/b"}"#),
            (r#"{"repository":{"url":"git+https://github.com/a/b"}}"#, r#"{"repository":"a/b"}"#),
            (r#"{"repository":{"type":"git","url":"git+ssh://git@github.com/a/b.git"}}"#, r#"{"repository":"a/b"}"#),
            (
                r#"{"repository":{"type":"git","url":"git+https://github.com/a/b.c.git"}}"#,
                r#"{"repository":{"type":"git","url":"git+https://github.com/a/b.c.git"}}"#,
            ),
            (
                r#"{"repository":{"type":"git","url":"git+https://github.com/a/b/c"}}"#,
                r#"{"repository":{"type":"git","url":"git+https://github.com/a/b/c"}}"#,
            ),
            (
                r#"{"repository":{"type":"svn","url":"git+https://github.com/a/b"}}"#,
                r#"{"repository":{"type":"svn","url":"git+https://github.com/a/b"}}"#,
            ),
            (
                r#"{"repository":{"type":null,"url":"git+https://github.com/a/b"}}"#,
                r#"{"repository":{"type":null,"url":"git+https://github.com/a/b"}}"#,
            ),
            (
                r#"{"repository":{"url":"git+https://github.com/a/b","directory":"x"}}"#,
                r#"{"repository":{"url":"git+https://github.com/a/b","directory":"x"}}"#,
            ),
            (
                r#"{"repository":{"url":"git+https://github.com//b"}}"#,
                r#"{"repository":{"url":"git+https://github.com//b"}}"#,
            ),
            (
                r#"{"repository":{"url":"git+https://github.com/a/.git"}}"#,
                r#"{"repository":{"url":"git+https://github.com/a/.git"}}"#,
            ),
        ];

        for (input, expected) in cases {
            assert_eq!(formatted(input, ALL), expected, "{input}");
        }
    }

    #[test]
    fn export_conditions_are_ordered_at_every_object_level() {
        assert_eq!(
            formatted(r#"{"exports":{"default":"d","x":{"require":"r","types":"t","other":1},"types":"t"}}"#, ALL),
            r#"{"exports":{"types":"t","default":"d","x":{"types":"t","require":"r","other":1}}}"#
        );
        assert_eq!(
            formatted(r#"{"exports":[{"default":"d","types":"t"}]}"#, ALL),
            r#"{"exports":[{"default":"d","types":"t"}]}"#
        );
    }

    #[test]
    fn a_sort_order_puts_the_listed_keys_first() {
        let Some(Json::Object(entries)) = parse(r#"{"a":1,"b":2,"c":3}"#) else {
            panic!();
        };
        let ordered = apply_sort_order(entries, &["c".to_owned(), "x".to_owned(), "c".to_owned(), "b".to_owned()]);

        assert_eq!(stringify(&Json::Object(ordered), ""), r#"{"c":3,"b":2,"a":1}"#);
    }

    #[test]
    fn unsorted_sections_keep_their_original_value_in_the_sorted_place() {
        let Some(Json::Object(original)) = parse(r#"{"z":{"b":1,"a":2},"a":1}"#) else {
            panic!();
        };
        let Some(Json::Object(sorted)) = parse(r#"{"a":1,"z":{"a":2,"b":1}}"#) else {
            panic!();
        };
        let restored = restore_unsorted(sorted, &original, &["z".to_owned(), "missing".to_owned()]);

        assert_eq!(stringify(&Json::Object(restored), ""), r#"{"a":1,"z":{"b":1,"a":2}}"#);
    }
}
