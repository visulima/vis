//! The output formats of `vis audit` this crate prints, and the progress row of a scan that lists findings.
//!
//! The batch endpoint of OSV returns the id of a finding and nothing else, which the Node handler maps to the severity
//! `UNKNOWN`; no `--severity` level lets that through, so such a finding never reaches the results, the summary or an
//! exit gate (see [`super::osv::documented_findings`]). What Node prints for it is the report of a clean scan, and
//! the progress row says `N found` with a warning glyph where a clean scan says `none found`. That holds for every
//! format below, so each is the document Node writes for an empty result:
//!
//! - `json`: [`super::report::clean_report`];
//! - `sarif`: the document below. The handler prints `Scan completed in …` as a pail block
//!   on stdout ahead of them (its `isJson` test, where the quiet formats need `quietHeader`), which makes the document
//!   follow a line that is not part of it; that line is reproduced, because the run is byte for byte Node's or not
//!   Node's at all.
//!
//! The others stay in Node: `table` draws a live progress view (cursor moves and a spinner frame whose number depends on
//! how long the scan took), and `cyclonedx-vex` embeds the whole bill of materials with a random `serialNumber`.
//! The clock in a document is the one value that differs between two Node runs by design.

use std::time::Duration;

use super::report::elapsed;
use crate::pail::{Layout, Level};
use crate::term::Style;

/// The `--format` values answered here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Format {
    Json,
    Sarif,
}

impl Format {
    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "json" => Some(Self::Json),
            "sarif" => Some(Self::Sarif),
            _ => None,
        }
    }

    /// Whether the handler prints its `Scan completed in …` block for this format (`!isJson`).
    pub(super) fn prints_banner(self) -> bool {
        self != Self::Json
    }
}

/// `startScanProgress`'s row for a scan that listed `count` findings: a yellow warning glyph (`!` when `TERM` is
/// `linux`), the label and the dimmed summary.
pub(super) fn found_row(style: Style, count: usize, took: Duration, term_is_linux: bool) -> String {
    let glyph = if term_is_linux { "!" } else { "\u{26a0}" };
    let summary = style.dim(&format!("\u{2014} {count} found \u{b7} {}", elapsed(took)));

    format!("  {} Known vulnerabilities (OSV) {summary}\n", style.yellow(glyph))
}

/// The block `pail.info(dim("Scan completed in …"))` writes to stdout, or `None` where this crate cannot lay it out as
/// pail does (a coloured header, a message wider than a line). `took` is the time of the request: Node counts from just
/// before it to just after the progress row, a difference no run reproduces.
pub(super) fn banner(layout: Layout, took: Duration) -> Option<String> {
    let message = format!("Scan completed in {}", elapsed(took));

    (!layout.colour && layout.fits_one_line(&message)).then(|| layout.block(Level::Info, &message))
}

/// `JSON.stringify(emitSarif(…), undefined, 2)` and a line feed, for a scan with no finding, policy decision or
/// unauditable package: the `run` has no `invocations` key then, and the lockfile path does not appear.
const SARIF: &str = "{\n  \"$schema\": \"https://json.schemastore.org/sarif-2.1.0.json\",\n  \"runs\": [\n    {\n      \"results\": [],\n      \"tool\": {\n        \"driver\": {\n          \"informationUri\": \"https://github.com/visulima/visulima\",\n          \"name\": \"vis-audit\",\n          \"rules\": [],\n          \"version\": \"alpha\"\n        }\n      }\n    }\n  ],\n  \"version\": \"2.1.0\"\n}\n";

/// The document of a format other than `json` (whose report is [`super::report::clean_report`]), with `now` as its
/// clock, or `None` for `json`.
pub(super) fn document(format: Format, _now: &str) -> Option<String> {
    match format {
        Format::Json => None,
        Format::Sarif => Some(SARIF.to_owned()),
    }
}
