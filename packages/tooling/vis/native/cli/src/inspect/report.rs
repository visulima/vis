//! The JSON report: `JSON.stringify(formatMarshallFindingsAsJson(findings), undefined, 2)` and a line break.

use super::marshalls::{Finding, Severity};
use crate::js::json_string;

/// One finding as `JSON.stringify` writes it at `depth` levels of indentation (two spaces each), with its keys in the
/// order the handler builds them.
fn finding(finding: &Finding, depth: usize, out: &mut String) {
    let (outer, inner) = ("  ".repeat(depth), "  ".repeat(depth + 1));

    out.push_str(&format!(
        "{outer}{{\n{inner}\"marshall\": {},\n{inner}\"message\": {},\n{inner}\"packageName\": {},\n{inner}\"severity\": {}\n{outer}}}",
        json_string(finding.marshall),
        json_string(&finding.message),
        json_string(&finding.package),
        json_string(finding.severity.name())
    ));
}

fn list(key: &str, findings: &[&Finding], out: &mut String) {
    out.push_str(&format!("  \"{key}\": "));

    if findings.is_empty() {
        out.push_str("[]");

        return;
    }

    out.push_str("[\n");

    for (index, one) in findings.iter().enumerate() {
        if index > 0 {
            out.push_str(",\n");
        }

        finding(one, 2, out);
    }

    out.push_str("\n  ]");
}

/// The report of `findings`, in the order the handler prints its keys: `errors`, `findings`, `summary`, `warnings`.
pub(super) fn json(findings: &[Finding]) -> String {
    let of = |severity: Severity| -> Vec<&Finding> { findings.iter().filter(|one| one.severity == severity).collect() };
    let (errors, warnings) = (of(Severity::Error), of(Severity::Warning));
    let all: Vec<&Finding> = findings.iter().collect();
    let mut out = String::from("{\n");

    list("errors", &errors, &mut out);
    out.push_str(",\n");
    list("findings", &all, &mut out);
    out.push_str(&format!(
        ",\n  \"summary\": {{\n    \"errorCount\": {},\n    \"warningCount\": {}\n  }},\n",
        errors.len(),
        warnings.len()
    ));
    list("warnings", &warnings, &mut out);
    out.push_str("\n}\n");

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_report_is_what_stringify_writes() {
        assert_eq!(
            json(&[]),
            "{\n  \"errors\": [],\n  \"findings\": [],\n  \"summary\": {\n    \"errorCount\": 0,\n    \"warningCount\": 0\n  },\n  \"warnings\": []\n}\n"
        );
    }

    #[test]
    fn findings_are_listed_by_severity_and_all_together() {
        let one = |severity, message: &str| Finding {
            marshall: "author",
            message: message.to_owned(),
            package: "pkg".to_owned(),
            severity,
        };
        let report = json(&[one(Severity::Warning, "w \"q\" \u{2014}"), one(Severity::Error, "e")]);

        assert_eq!(
            report,
            concat!(
                "{\n  \"errors\": [\n    {\n      \"marshall\": \"author\",\n      \"message\": \"e\",\n      \"packageName\": \"pkg\",\n      \"severity\": \"error\"\n    }\n  ],\n",
                "  \"findings\": [\n    {\n      \"marshall\": \"author\",\n      \"message\": \"w \\\"q\\\" \u{2014}\",\n      \"packageName\": \"pkg\",\n      \"severity\": \"warning\"\n    },\n",
                "    {\n      \"marshall\": \"author\",\n      \"message\": \"e\",\n      \"packageName\": \"pkg\",\n      \"severity\": \"error\"\n    }\n  ],\n",
                "  \"summary\": {\n    \"errorCount\": 1,\n    \"warningCount\": 1\n  },\n",
                "  \"warnings\": [\n    {\n      \"marshall\": \"author\",\n      \"message\": \"w \\\"q\\\" \u{2014}\",\n      \"packageName\": \"pkg\",\n      \"severity\": \"warning\"\n    }\n  ]\n}\n"
            )
        );
    }
}
