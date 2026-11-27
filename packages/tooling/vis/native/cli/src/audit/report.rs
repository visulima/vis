//! What a clean `vis audit --format json` run prints: the report on stdout and one progress row on stderr.
//!
//! Both are the Node output for a scan that found nothing, written the way `JSON.stringify(report, undefined, 2)` and
//! the non-live `startScanProgress` write them.

use std::collections::HashMap;
use std::time::Duration;

use crate::collation::collate;
use crate::js::json_string;
use crate::term::Style;

/// `auditReportTool` of the handler: the same three fields in every report.
const TOOL: &str = "{\n    \"informationUri\": \"https://github.com/visulima/visulima\",\n    \"name\": \"vis-audit\",\n    \"version\": \"alpha\"\n  }";

/// One package of the lockfile, as the report counts it.
pub(super) struct Package<'a> {
    pub(super) name: &'a str,
    pub(super) version: &'a str,
}

/// A package name installed in more than one version, in the order the lockfile lists them.
pub(super) struct Duplicate<'a> {
    pub(super) name: &'a str,
    pub(super) versions: Vec<&'a str>,
}

/// `findDuplicateDependencies`: the names with more than one version, sorted with `localeCompare`.
pub(super) fn duplicates<'a>(packages: &[Package<'a>]) -> Vec<Duplicate<'a>> {
    let mut found: Vec<Duplicate<'a>> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();

    for package in packages {
        let slot = *index.entry(package.name).or_insert_with(|| {
            found.push(Duplicate { name: package.name, versions: Vec::new() });

            found.len() - 1
        });

        if !found[slot].versions.contains(&package.version) {
            found[slot].versions.push(package.version);
        }
    }

    found.retain(|duplicate| duplicate.versions.len() > 1);
    found.sort_by(|a, b| collate(a.name, b.name));
    found
}

fn duplicate_entry(duplicate: &Duplicate<'_>) -> String {
    let versions: Vec<String> =
        duplicate.versions.iter().map(|version| format!("        {}", json_string(version))).collect();

    format!(
        "    {{\n      \"name\": {},\n      \"versionCount\": {},\n      \"versions\": [\n{}\n      ]\n    }}",
        json_string(duplicate.name),
        duplicate.versions.len(),
        versions.join(",\n")
    )
}

/// The report of a scan that found nothing: `JSON.stringify(buildAuditReport(...), undefined, 2)` and a line feed.
/// `packages` is the number of installed packages scanned, `generated_at` the `toISOString` text and `workspace_root`
/// the root as the handler prints it.
pub(super) fn clean_report(
    packages: usize,
    duplicates: &[Duplicate<'_>],
    generated_at: &str,
    workspace_root: &str,
) -> String {
    let entries: Vec<String> = duplicates.iter().map(duplicate_entry).collect();
    let listed = if entries.is_empty() { "[]".to_owned() } else { format!("[\n{}\n  ]", entries.join(",\n")) };

    format!(
        "{{\n  \"bloomHits\": [],\n  \"duplicates\": {listed},\n  \"generatedAt\": {},\n  \"packages\": {packages},\n  \"policies\": [],\n  \"results\": [],\n  \"schemaVersion\": \"1.1\",\n  \"summary\": {{\n    \"accepted\": 0,\n    \"duplicatePackages\": {},\n    \"issues\": 0,\n    \"policyBlocks\": 0,\n    \"policyDecisions\": 0,\n    \"total\": 0\n  }},\n  \"tool\": {TOOL},\n  \"warnings\": [],\n  \"workspaceRoot\": {},\n  \"unauditable\": []\n}}\n",
        json_string(generated_at),
        duplicates.len(),
        json_string(workspace_root)
    )
}

/// `fmtElapsed` of the handler: whole milliseconds below a second, otherwise seconds with `toFixed(1)`, which rounds
/// a value exactly halfway between two tenths up (`1.25` is `1.3`) where Rust's `{:.1}` rounds it to even.
pub(super) fn elapsed(duration: Duration) -> String {
    let ms = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);

    if ms < 1000 {
        return format!("{ms}ms");
    }

    // `ms / 1000` is a double, so only a quarter second is exactly halfway between two tenths.
    if ms % 500 == 250 {
        let tenths = (ms + 50) / 100;

        return format!("{}.{}s", tenths / 10, tenths % 10);
    }

    format!("{:.1}s", ms as f64 / 1000.0)
}

/// The row `startScanProgress` writes to stderr when a scan ends without findings: a green tick (`v` when `TERM` is
/// `linux`, which `SYMBOLS` of the handler takes for a console without Unicode), the label and the dimmed summary.
pub(super) fn progress_row(style: Style, took: Duration, term_is_linux: bool) -> String {
    let tick = if term_is_linux { "v" } else { "\u{2713}" };
    let summary = style.dim(&format!("\u{2014} none found \u{b7} {}", elapsed(took)));

    format!("  {} Known vulnerabilities (OSV) {summary}\n", style.green(tick))
}
