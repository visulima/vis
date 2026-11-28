//! What `vis check` prints for a list of outdated dependencies: the minimal lines, the JSON document and the tables with
//! their summary (`formatOutdatedMinimal`, `formatOutdatedTable`, `formatSummary` of `src/util/catalog/format.ts`).
//!
//! Node draws the table with `@visulima/tui-kit`. For the cells this port can see (printable ASCII) and a table that
//! fits the 80 columns Node assumes off a terminal, the drawing is the one below; a table that is wider than that is
//! wrapped or cut by the component, which is the reason to hand the run to Node, as is any cell with another character.

use super::outdated::Outdated;
use super::version::UpdateType;
use crate::json::{self, Json};

/// `process.stdout.columns || 80` off a terminal.
const COLUMNS: usize = 80;

const HEADER: [&str; 4] = ["current", "package", "target", "type"];

/// Whether `text` is something the table draws as it is: printable ASCII.
fn drawable(text: &str) -> bool {
    text.bytes().all(|byte| (0x20..0x7f).contains(&byte))
}

/// `formatOutdatedMinimal`.
pub(super) fn minimal(outdated: &[Outdated]) -> String {
    outdated
        .iter()
        .map(|entry| format!("{}  {} \u{2192} {}", entry.package_name, entry.current_range, entry.new_range))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `JSON.stringify({ failed, outdated }, undefined, 2)`.
pub(super) fn json_document(failed: &[String], outdated: &[Outdated]) -> String {
    let entry = |entry: &Outdated| {
        let field = |name: &str, value: &str| (name.to_owned(), Json::Str(value.to_owned()));

        Json::Object(vec![
            field("catalogName", &entry.catalog_name),
            field("currentRange", &entry.current_range),
            field("newRange", &entry.new_range),
            field("packageName", &entry.package_name),
            field("targetVersion", &entry.target_version),
            field("updateType", entry.update_type.label()),
        ])
    };
    let document = Json::Object(vec![
        ("failed".to_owned(), Json::Array(failed.iter().map(|name| Json::Str(name.clone())).collect())),
        ("outdated".to_owned(), Json::Array(outdated.iter().map(entry).collect())),
    ]);

    json::stringify(&document, "  ")
}

/// `formatCatalogDisplayName`: `<location> (<field>)`, or `Catalog: <name>` for a name that is no `<path>:<field>`.
fn display_name(catalog: &str) -> String {
    const FIELDS: [&str; 7] = [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "overrides",
        "peerDependencies",
        "pnpm.overrides",
        "resolutions",
    ];

    match catalog.rsplit_once(':') {
        Some((path, field)) if FIELDS.contains(&field) => {
            format!("{} ({field})", if path == "." { "root" } else { path })
        }
        _ => format!("Catalog: {catalog}"),
    }
}

/// One drawn table, or `None` when it is wider than the terminal Node assumes.
fn draw(rows: &[[String; 4]]) -> Option<String> {
    let mut widths = HEADER.map(str::len);

    for row in rows {
        for (width, cell) in widths.iter_mut().zip(row) {
            *width = (*width).max(cell.len());
        }
    }

    if widths.iter().map(|width| width + 2).sum::<usize>() + HEADER.len() + 1 > COLUMNS {
        return None;
    }

    let rule = |left: char, middle: char, right: char| {
        let cells: Vec<String> = widths.iter().map(|width| "\u{2500}".repeat(width + 2)).collect();

        format!("{left}{}{right}", cells.join(&middle.to_string()))
    };
    let line = |cells: Vec<&str>| {
        let padded: Vec<String> = cells.iter().zip(widths).map(|(cell, width)| format!(" {cell:<width$} ")).collect();

        format!("\u{2502}{}\u{2502}", padded.join("\u{2502}"))
    };
    let middle = rule('\u{251c}', '\u{253c}', '\u{2524}');
    let mut lines = vec![rule('\u{250c}', '\u{252c}', '\u{2510}'), line(HEADER.to_vec()), middle.clone()];

    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            lines.push(middle.clone());
        }

        lines.push(line(row.iter().map(String::as_str).collect()));
    }

    lines.push(rule('\u{2514}', '\u{2534}', '\u{2518}'));

    Some(lines.join("\n"))
}

/// `formatSummary` without security data: ` ─ Summary` and the counts, as the tui draws them in a padded box.
fn summary(outdated: &[Outdated]) -> Option<String> {
    let count = |kind: UpdateType| outdated.iter().filter(|entry| entry.update_type == kind).count();
    let patches = outdated.len() - count(UpdateType::Major) - count(UpdateType::Minor);
    let mut parts = Vec::new();

    for (number, label) in
        [(count(UpdateType::Major), "major"), (count(UpdateType::Minor), "minor"), (patches, "patch")]
    {
        if number > 0 {
            parts.push(format!("{number} {label}"));
        }
    }

    let text = format!("   Found {} outdated ({})", outdated.len(), parts.join(", "));

    // The box wraps a line that does not fit its width; the counts of any real run are far below it.
    (text.len() < COLUMNS - 2).then(|| format!(" \u{2500} Summary\n{text}"))
}

/// `formatOutdatedTable` and the summary after it: what Node logs for the table format, or `None` to hand the run over.
pub(super) fn table(outdated: &[Outdated]) -> Option<String> {
    let mut groups: Vec<(&str, Vec<[String; 4]>)> = Vec::new();

    for entry in outdated {
        let row = [
            entry.current_range.clone(),
            entry.package_name.clone(),
            entry.new_range.clone(),
            entry.update_type.label().to_owned(),
        ];

        if !row.iter().all(|cell| drawable(cell)) || !drawable(&entry.catalog_name) {
            return None;
        }

        match groups.iter_mut().find(|(name, _)| *name == entry.catalog_name) {
            Some((_, rows)) => rows.push(row),
            None => groups.push((&entry.catalog_name, vec![row])),
        }
    }

    let mut text = String::new();

    // `logger.info(`${name}\n${table}\n`)`: the message, then the line break `info` adds.
    for (name, rows) in &groups {
        text.push_str(&format!("{}\n{}\n\n", display_name(name), draw(rows)?));
    }

    text.push_str(&summary(outdated)?);
    text.push('\n');

    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outdated(catalog: &str, package: &str, current: &str, new: &str, kind: UpdateType) -> Outdated {
        Outdated {
            catalog_name: catalog.into(),
            current_range: current.into(),
            new_range: new.into(),
            package_name: package.into(),
            target_version: new.trim_start_matches(['^', '~']).into(),
            update_type: kind,
        }
    }

    fn sample() -> Vec<Outdated> {
        vec![
            outdated(".:dependencies", "calm", "^1.0.0", "^1.2.0", UpdateType::Minor),
            outdated(".:dependencies", "@scope/scoped", "^1.0.0", "^1.0.1", UpdateType::Patch),
            outdated(".:devDependencies", "devtool", "~2.0.0", "~2.1.0", UpdateType::Minor),
            outdated("packages/app:dependencies", "calm", "^1.1.0", "^1.2.0", UpdateType::Minor),
        ]
    }

    #[test]
    fn the_tables_are_drawn_as_node_draws_them() {
        let expected = "root (dependencies)\n\
┌─────────┬───────────────┬────────┬───────┐\n\
│ current │ package       │ target │ type  │\n\
├─────────┼───────────────┼────────┼───────┤\n\
│ ^1.0.0  │ calm          │ ^1.2.0 │ minor │\n\
├─────────┼───────────────┼────────┼───────┤\n\
│ ^1.0.0  │ @scope/scoped │ ^1.0.1 │ patch │\n\
└─────────┴───────────────┴────────┴───────┘\n\
\n\
root (devDependencies)\n\
┌─────────┬─────────┬────────┬───────┐\n\
│ current │ package │ target │ type  │\n\
├─────────┼─────────┼────────┼───────┤\n\
│ ~2.0.0  │ devtool │ ~2.1.0 │ minor │\n\
└─────────┴─────────┴────────┴───────┘\n\
\n\
packages/app (dependencies)\n\
┌─────────┬─────────┬────────┬───────┐\n\
│ current │ package │ target │ type  │\n\
├─────────┼─────────┼────────┼───────┤\n\
│ ^1.1.0  │ calm    │ ^1.2.0 │ minor │\n\
└─────────┴─────────┴────────┴───────┘\n\
\n\
\u{20}─ Summary\n\
\u{20}\u{20}\u{20}Found 4 outdated (3 minor, 1 patch)\n";

        assert_eq!(table(&sample()).as_deref(), Some(expected));
    }

    #[test]
    fn minimal_and_json_follow_the_formatters() {
        assert_eq!(minimal(&sample()[..2]), "calm  ^1.0.0 → ^1.2.0\n@scope/scoped  ^1.0.0 → ^1.0.1");
        assert_eq!(
            json_document(&["x".to_owned()], &sample()[..1]),
            "{\n  \"failed\": [\n    \"x\"\n  ],\n  \"outdated\": [\n    {\n      \"catalogName\": \".:dependencies\",\n      \"currentRange\": \"^1.0.0\",\n      \"newRange\": \"^1.2.0\",\n      \"packageName\": \"calm\",\n      \"targetVersion\": \"1.2.0\",\n      \"updateType\": \"minor\"\n    }\n  ]\n}"
        );
        assert_eq!(json_document(&[], &[]), "{\n  \"failed\": [],\n  \"outdated\": []\n}");
    }

    #[test]
    fn a_table_wider_than_the_terminal_or_with_other_text_is_left_to_node() {
        let long = "a".repeat(70);

        assert!(table(&[outdated(".:dependencies", &long, "^1.0.0", "^1.1.0", UpdateType::Minor)]).is_none());
        assert!(table(&[outdated(".:dependencies", "réact", "^1.0.0", "^1.1.0", UpdateType::Minor)]).is_none());
        assert!(table(&[outdated(".:dependencies", "a\tb", "^1.0.0", "^1.1.0", UpdateType::Minor)]).is_none());
    }

    #[test]
    fn catalog_names_read_as_their_location_and_field() {
        assert_eq!(display_name(".:dependencies"), "root (dependencies)");
        assert_eq!(display_name("packages/a:peerDependencies"), "packages/a (peerDependencies)");
        assert_eq!(display_name("default"), "Catalog: default");
        assert_eq!(display_name("a:unknown"), "Catalog: a:unknown");
    }
}
