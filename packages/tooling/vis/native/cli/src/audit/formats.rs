//! The progress row of a scan that lists findings.
//!
//! The batch endpoint of OSV returns the id of a finding and nothing else, which the Node handler maps to the severity
//! `UNKNOWN`; no `--severity` level lets that through, so such a finding never reaches the results, the summary or an
//! exit gate (see [`super::osv::documented_findings`]). What Node prints for it is the report of a clean scan, and
//! the progress row says `N found` with a warning glyph where a clean scan says `none found`.

use std::time::Duration;

use super::report::elapsed;
use crate::term::Style;

/// `startScanProgress`'s row for a scan that listed `count` findings: a yellow warning glyph (`!` when `TERM` is
/// `linux`), the label and the dimmed summary.
pub(super) fn found_row(style: Style, count: usize, took: Duration, term_is_linux: bool) -> String {
    let glyph = if term_is_linux { "!" } else { "\u{26a0}" };
    let summary = style.dim(&format!("\u{2014} {count} found \u{b7} {}", elapsed(took)));

    format!("  {} Known vulnerabilities (OSV) {summary}\n", style.yellow(glyph))
}
