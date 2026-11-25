//! The baseline file: the suppression keys a finding is known under, and the loader of a baseline.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use secret_scanner_core::Finding;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::js::js_number;

/// SHA-256 over `secret NUL rule NUL file`, as 16 hex characters.
fn fingerprint(secret: &str, rule_id: &str, file: &str) -> String {
    let digest = Sha256::digest(format!("{secret}\0{rule_id}\0{file}").as_bytes());

    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

fn legacy_fingerprint(file: &str, rule_id: &str, line: &str) -> String {
    format!("{file}:{rule_id}:{line}")
}

/// Every key a finding is baselined under: content hash, line-based form and the whole match as
/// the secret.
pub(super) fn baseline_keys(finding: &Finding) -> [String; 3] {
    [
        fingerprint(&finding.secret, &finding.rule_id, &finding.file),
        legacy_fingerprint(&finding.file, &finding.rule_id, &finding.start_line.to_string()),
        fingerprint(&finding.r#match, &finding.rule_id, &finding.file),
    ]
}

/// The suppression set of a baseline file: each entry under its content hash and its line-based
/// form. A missing file is an empty baseline. A file Node would complain about (unreadable, not
/// JSON, not an array) is `None`: Node prints its own diagnostic for it.
pub(super) fn load_baseline(path: &Path) -> Option<HashSet<String>> {
    if !path.exists() {
        return Some(HashSet::new());
    }

    let text = String::from_utf8(fs::read(path).ok()?).ok()?;
    let Value::Array(entries) = serde_json::from_str(&text).ok()? else {
        return None;
    };
    let mut set = HashSet::new();

    for entry in &entries {
        let (Some(rule_id), Some(file), Some(Value::Number(line))) = (
            entry.get("ruleId").and_then(Value::as_str),
            entry.get("file").and_then(Value::as_str),
            entry.get("startLine"),
        ) else {
            continue;
        };
        let secret = entry.get("secret").and_then(Value::as_str).unwrap_or("");

        set.insert(fingerprint(secret, rule_id, file));
        set.insert(legacy_fingerprint(file, rule_id, &js_number(line.as_f64()?)));
    }

    Some(set)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_are_the_first_16_hex_digits_of_sha256() {
        assert_eq!(fingerprint("a", "b", "c").len(), 16);
        assert_eq!(fingerprint("a", "b", "c"), fingerprint("a", "b", "c"));
        assert_ne!(fingerprint("a", "b", "c"), fingerprint("a", "b", "d"));
    }

    #[test]
    fn a_baseline_holds_each_entry_under_two_keys() {
        let directory = std::env::temp_dir().join(format!("vis-secrets-baseline-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();

        let path = directory.join("baseline.json");

        fs::write(&path, r#"[{"ruleId":"r","file":"a.env","startLine":3.0,"secret":"s"},{"ruleId":"r"},"x"]"#).unwrap();

        let set = load_baseline(&path).unwrap();

        assert_eq!(set.len(), 2);
        assert!(set.contains(&fingerprint("s", "r", "a.env")));
        assert!(set.contains("a.env:r:3"));

        fs::write(&path, "{").unwrap();
        assert!(load_baseline(&path).is_none());
        fs::write(&path, "{}").unwrap();
        assert!(load_baseline(&path).is_none());
        fs::remove_file(&path).unwrap();
        assert_eq!(load_baseline(&path), Some(HashSet::new()));
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_baseline_line_is_written_as_javascript_writes_a_number() {
        let directory = std::env::temp_dir().join(format!("vis-secrets-baseline-numbers-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();

        let path = directory.join("baseline.json");
        let entry = |line: &str| format!(r#"[{{"ruleId":"r","file":"a","startLine":{line},"secret":"s"}}]"#);
        let keys = |line: &str| {
            fs::write(&path, entry(line)).unwrap();
            load_baseline(&path).unwrap()
        };

        // Past 2^53 the line is the nearest double, as JSON.parse reads it, not the digits that were written.
        assert!(keys("9007199254740993").contains("a:r:9007199254740992"));
        // A line that is not whole, or that is big, has the text Number#toString gives it.
        assert!(keys("1.5").contains("a:r:1.5"));
        assert!(keys("1e21").contains("a:r:1e+21"));
        assert!(keys("1e-7").contains("a:r:1e-7"));
        assert!(keys("2e0").contains("a:r:2"));

        fs::remove_dir_all(&directory).unwrap();
    }
}
