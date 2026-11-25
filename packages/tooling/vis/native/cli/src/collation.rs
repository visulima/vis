//! Sorting the way Node's `String.prototype.localeCompare` does for the printable ASCII this crate prints: the ICU root
//! collation, which only holds under a locale that has no tailoring.

use std::cmp::Ordering;
use std::env;

/// Whether Node's `localeCompare` orders ASCII like the root collation [`collate`] reproduces. A
/// tailored locale (`da`, `cs`, …) orders some letter pairs differently, and Node takes its default
/// locale from these variables.
pub(crate) fn root_collation() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LC_COLLATE", "LANG", "LANGUAGE"].iter().all(|key| match env::var(key) {
        Ok(value) => {
            let value = value.trim();
            let language = value.split(['_', '.', '@', '-', ':']).next().unwrap_or_default();

            value.is_empty() || matches!(language, "C" | "POSIX" | "en")
        }
        Err(env::VarError::NotPresent) => true,
        Err(env::VarError::NotUnicode(_)) => false,
    })
}

/// Printable ASCII in the root collation's primary order (punctuation, digits, then letters, case
/// folded). Checked against `String.prototype.localeCompare` (see the unit test and `__tests__/native/cache-hash-parity.test.ts`).
const COLLATION_ORDER: &[u8] = b" _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

const fn primary_weights() -> [u8; 128] {
    let mut weights = [0u8; 128];
    let mut index = 0;

    while index < COLLATION_ORDER.len() {
        weights[COLLATION_ORDER[index] as usize] = index as u8 + 1;
        index += 1;
    }

    weights
}

static PRIMARY: [u8; 128] = primary_weights();

/// `a.localeCompare(b)` for printable ASCII under the root collation: the primary weights of the
/// whole strings first, then at the first case difference lowercase before uppercase.
pub(crate) fn collate(a: &str, b: &str) -> Ordering {
    let primary = |byte: u8| PRIMARY[usize::from(byte.to_ascii_lowercase())];

    a.bytes().map(primary).cmp(b.bytes().map(primary)).then_with(|| {
        a.bytes().map(|byte| byte.is_ascii_uppercase()).cmp(b.bytes().map(|byte| byte.is_ascii_uppercase()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collation_matches_the_root_order_for_ascii() {
        let mut keys = vec![
            "b",
            "B",
            "a",
            "A",
            "a-b",
            "a_b",
            "a.b",
            "a/b",
            "ab",
            "a1",
            "A1",
            "_x",
            "-x",
            "10",
            "9",
            "packages/app/a.txt",
            "packages/App/a.txt",
        ];

        keys.sort_by(|a, b| collate(a, b));

        // Ground truth from `Array.prototype.sort((a, b) => a.localeCompare(b))` on Node 22 with ICU.
        assert_eq!(
            keys,
            [
                "_x",
                "-x",
                "10",
                "9",
                "a",
                "A",
                "a_b",
                "a-b",
                "a.b",
                "a/b",
                "a1",
                "A1",
                "ab",
                "b",
                "B",
                "packages/app/a.txt",
                "packages/App/a.txt"
            ]
        );
    }
}
