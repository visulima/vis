//! Sorting the way Node's `String.prototype.localeCompare` does for the printable ASCII this crate prints: the ICU root
//! collation, which only holds under a locale that has no tailoring.

use std::cmp::Ordering;
#[cfg(not(windows))]
use std::env;

/// Whether Node's `localeCompare` orders ASCII like the root collation [`collate`] reproduces. A
/// tailored locale (`da`, `cs`, …) orders some letter pairs differently.
///
/// Where Node takes its default locale from decides what is asked. On unix ICU reads the locale variables. On Windows
/// it reads the user's locale (`GetUserDefaultLocaleName`) and ignores the variables altogether (observed on Windows
/// with `LC_ALL` and `LANG` set to `cs_CZ`: `Intl.Collator().resolvedOptions().locale` stayed `en-US`, and with the
/// user locale set to `cs-CZ` it was `cs-CZ` whatever `LC_ALL` said), so there the variables are not read and a locale
/// that cannot be read is not the root collation.
pub(crate) fn root_collation() -> bool {
    #[cfg(windows)]
    {
        user_locale_name().is_some_and(|name| locale_sorts_like_root(&name))
    }

    #[cfg(not(windows))]
    {
        env_locale_sorts_like_root()
    }
}

#[cfg(not(windows))]
fn env_locale_sorts_like_root() -> bool {
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

/// The Windows user locale name, `en-US` style; `None` when Windows does not give one.
#[cfg(windows)]
fn user_locale_name() -> Option<String> {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;

    // `LOCALE_NAME_MAX_LENGTH`, with the terminating NUL.
    let mut buffer = [0u16; 85];
    // SAFETY: the buffer is writable for the length passed with it.
    let written = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), i32::try_from(buffer.len()).ok()?) };
    let length = usize::try_from(written).ok()?.checked_sub(1)?;

    String::from_utf16(buffer.get(..length)?).ok()
}

/// Whether the locale `name` (`en-US`, `cs-CZ`, `es-ES_tradnl`) has no collation tailoring of its own: English with
/// an optional script and region and nothing else (`en-US-posix` is a tailoring), or the root locale `und`. Anything
/// else, including a name that is empty, is a locale this crate cannot say anything about.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn locale_sorts_like_root(name: &str) -> bool {
    let mut parts = name.split(['-', '_']);
    let language = parts.next().unwrap_or_default();

    if language.eq_ignore_ascii_case("und") {
        return parts.next().is_none();
    }

    if !language.eq_ignore_ascii_case("en") {
        return false;
    }

    let script = |part: &str| part.len() == 4 && part.bytes().all(|byte| byte.is_ascii_alphabetic());
    let region = |part: &str| {
        (part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_alphabetic()))
            || (part.len() == 3 && part.bytes().all(|byte| byte.is_ascii_digit()))
    };

    match parts.collect::<Vec<_>>()[..] {
        [] => true,
        [one] => script(one) || region(one),
        [first, second] => script(first) && region(second),
        _ => false,
    }
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
    fn only_english_and_the_root_locale_sort_like_the_root_collation() {
        for name in ["en", "en-US", "en-GB", "EN-us", "en_US", "en-001", "en-150", "en-Latn", "en-Latn-US", "und"] {
            assert!(locale_sorts_like_root(name), "{name}");
        }

        for name in [
            "",
            "cs-CZ",
            "sk-SK",
            "da-DK",
            "hu-HU",
            "es-ES-tradnl",
            "es-ES_tradnl",
            "sv-SE",
            "de-DE",
            "lt-LT",
            "en-US-posix",
            "en-US-x-twain",
            "en-US-u-co-trad",
            "en-",
            "en-US-",
            "en--US",
            "english",
            "enm",
            "und-CZ",
            "-",
        ] {
            assert!(!locale_sorts_like_root(name), "{name:?}");
        }
    }

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
