//! The JSON and the plain text reports of the findings.

use std::collections::HashMap;

use secret_scanner_core::Finding;
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;

use crate::js::json_number;

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

pub(super) fn render_json(findings: &[Finding]) -> Option<String> {
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
pub(super) fn render_text(findings: &[Finding]) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    use crate::secrets::tests::finding;

    #[test]
    fn integral_numbers_print_without_a_fraction() {
        let print = |value: f64| serde_json::to_string(&JsNumber(value)).unwrap();

        assert_eq!(print(0.0), "0");
        assert_eq!(print(3.0), "3");
        assert_eq!(print(4.75), "4.75");
        assert_eq!(print(3.251_629_114_151_001), "3.251629114151001");
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
