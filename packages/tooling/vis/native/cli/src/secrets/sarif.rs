//! The SARIF report: the log model and its renderer, with the ordering of the rules the way Node's
//! `localeCompare` gives it.

use std::collections::HashMap;
use std::env;
use std::path::Path;

use secret_scanner_core::{Finding, RuleInfo};
use serde::Serialize;

/// The tool version Node stamps into SARIF (`toolVersion` in the secrets handler).
const TOOL_VERSION: &str = "0.0.0-alpha";

/// Whether Node's `localeCompare` orders rule ids as the root collation does: the locale variables
/// ICU reads are unset, `C`/`POSIX` or English. Other locales order some letter pairs differently
/// (Czech `ch`, Danish `aa`, Lithuanian `y`).
pub(super) fn root_collation() -> bool {
    ["LC_ALL", "LC_COLLATE", "LC_MESSAGES", "LANG", "LANGUAGE"].iter().all(|name| {
        env::var_os(name).is_none_or(|value| {
            let value = value.to_string_lossy().to_ascii_lowercase();

            value.is_empty() || value == "c" || value == "posix" || value.starts_with("c.") || value.starts_with("en")
        })
    })
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

pub(super) fn render_sarif(findings: &[Finding], rules: &[RuleInfo], root: &Path) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
