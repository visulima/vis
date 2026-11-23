//! Read-only lookup of a local cache entry, answering what `Cache.get` answers in
//! TypeScript: whether `<cache dir>/<hash>/` holds a complete entry, and the exit
//! code and terminal output it stored. Nothing here writes, touches or deletes.

use std::path::Path;

use crate::run_graph::NotReproducible;

/// What a complete entry stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheEntry {
    /// The stored exit code. A hit does not imply `0`; the caller decides what to do with another code.
    pub code: i64,
    /// The merged stdout and stderr of the run, `""` when the entry has none.
    pub terminal_output: String,
}

/// The outcome of a lookup that was answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CacheLookup {
    Hit(CacheEntry),
    /// No complete entry: the directory, `.commit` or `code` is missing or unreadable, or `code` is not a number.
    Miss,
}

/// JS `String.prototype.trim` whitespace: the Unicode space separators, the line
/// terminators, tab, vertical tab, form feed and the byte order mark.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `Number.parseInt(text.trim(), 10)`: an optional sign and the leading decimal
/// digits, anything after them ignored. `None` is NaN. A value beyond `i64`
/// saturates; it is no exit code a process can have.
fn parse_int(text: &str) -> Option<i64> {
    let trimmed = text.trim_matches(is_js_whitespace);
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: &str = &digits[..digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len())];

    if digits.is_empty() {
        return None;
    }

    let magnitude = digits
        .bytes()
        .try_fold(0i64, |acc, digit| acc.checked_mul(10)?.checked_add(i64::from(digit - b'0')))
        .unwrap_or(i64::MAX);

    Some(if negative { -magnitude } else { magnitude })
}

fn is_hash(hash: &str) -> bool {
    hash.len() == 32 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Looks up the entry of `hash` in `cache_dir` (the directory `Cache` is given, e.g.
/// `<root>/node_modules/.cache/vis`).
///
/// An entry exists when `.commit` is readable and `code` is readable and starts
/// with a number, exactly the test of `Cache.get`; a missing `terminalOutput` is
/// the empty string. Anything the local hit path would do more than read is not
/// reproduced: an entry that holds outputs to restore (`outputs.tar.br`,
/// `outputs-manifest.json`), one from a traced run (`fingerprint.json`), or a
/// text file that is not valid UTF-8.
pub fn lookup_entry(cache_dir: &Path, hash: &str) -> Result<CacheLookup, NotReproducible> {
    if !is_hash(hash) {
        return Err(NotReproducible::InvalidHash(hash.to_owned()));
    }

    let entry = cache_dir.join(hash);

    if std::fs::read(entry.join(".commit")).is_err() {
        return Ok(CacheLookup::Miss);
    }

    let Ok(code_bytes) = std::fs::read(entry.join("code")) else { return Ok(CacheLookup::Miss) };
    let code_text = String::from_utf8(code_bytes)
        .map_err(|_| NotReproducible::EntryNotUtf8 { entry: hash.to_owned(), file: "code" })?;

    let Some(code) = parse_int(&code_text) else { return Ok(CacheLookup::Miss) };

    for restored in ["outputs.tar.br", "outputs-manifest.json"] {
        if entry.join(restored).exists() {
            return Err(NotReproducible::EntryHasOutputs(hash.to_owned()));
        }
    }

    if entry.join("fingerprint.json").exists() {
        return Err(NotReproducible::EntryIsTraced(hash.to_owned()));
    }

    let terminal_output = match std::fs::read(entry.join("terminalOutput")) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| NotReproducible::EntryNotUtf8 { entry: hash.to_owned(), file: "terminalOutput" })?,
        Err(_) => String::new(),
    };

    Ok(CacheLookup::Hit(CacheEntry { code, terminal_output }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    const HASH: &str = "0bf3560be734757197a4fee351196867";

    fn cache(name: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cache-entry-{name}-{}-{unique}", std::process::id()));

        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(HASH)).unwrap();

        dir
    }

    fn put(dir: &Path, file: &str, content: &[u8]) {
        fs::write(dir.join(HASH).join(file), content).unwrap();
    }

    fn entry(code: &str, output: &str) -> PathBuf {
        let dir = cache("entry");

        put(&dir, ".commit", b"");
        put(&dir, "code", code.as_bytes());
        put(&dir, "terminalOutput", output.as_bytes());

        dir
    }

    #[test]
    fn parse_int_follows_js() {
        assert_eq!(parse_int("0"), Some(0));
        assert_eq!(parse_int(" 12\n"), Some(12));
        assert_eq!(parse_int("0x1f"), Some(0));
        assert_eq!(parse_int("12abc"), Some(12));
        assert_eq!(parse_int("-3"), Some(-3));
        assert_eq!(parse_int("+7"), Some(7));
        assert_eq!(parse_int("\u{feff}1"), Some(1));
        assert_eq!(parse_int("1e3"), Some(1));
        assert_eq!(parse_int("3.9"), Some(3));
        assert_eq!(parse_int(""), None);
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int("-"), None);
        assert_eq!(parse_int("\u{85}1"), None, "U+0085 is not JS whitespace");
        assert_eq!(parse_int("99999999999999999999"), Some(i64::MAX));
    }

    #[test]
    fn a_complete_entry_is_a_hit() {
        let dir = entry("0", "hello\nwarn\n");

        assert_eq!(
            lookup_entry(&dir, HASH),
            Ok(CacheLookup::Hit(CacheEntry { code: 0, terminal_output: "hello\nwarn\n".into() }))
        );
    }

    #[test]
    fn a_non_zero_code_is_still_a_hit() {
        assert_eq!(
            lookup_entry(&entry("2", ""), HASH),
            Ok(CacheLookup::Hit(CacheEntry { code: 2, terminal_output: String::new() }))
        );
    }

    #[test]
    fn a_missing_terminal_output_is_empty() {
        let dir = entry("0", "x");

        fs::remove_file(dir.join(HASH).join("terminalOutput")).unwrap();

        assert_eq!(
            lookup_entry(&dir, HASH),
            Ok(CacheLookup::Hit(CacheEntry { code: 0, terminal_output: String::new() }))
        );
    }

    #[test]
    fn an_incomplete_entry_is_a_miss() {
        let dir = entry("0", "x");

        fs::remove_file(dir.join(HASH).join(".commit")).unwrap();
        assert_eq!(lookup_entry(&dir, HASH), Ok(CacheLookup::Miss));

        let dir = entry("0", "x");

        fs::remove_file(dir.join(HASH).join("code")).unwrap();
        assert_eq!(lookup_entry(&dir, HASH), Ok(CacheLookup::Miss));

        assert_eq!(lookup_entry(&entry("abc", ""), HASH), Ok(CacheLookup::Miss));
        assert_eq!(lookup_entry(&cache("empty"), "ffffffffffffffffffffffffffffffff"), Ok(CacheLookup::Miss));
    }

    #[test]
    fn what_a_hit_would_restore_or_replay_is_not_reproducible() {
        for (file, expected) in [
            ("outputs.tar.br", NotReproducible::EntryHasOutputs(HASH.into())),
            ("outputs-manifest.json", NotReproducible::EntryHasOutputs(HASH.into())),
            ("fingerprint.json", NotReproducible::EntryIsTraced(HASH.into())),
        ] {
            let dir = entry("0", "x");

            put(&dir, file, b"");

            assert_eq!(lookup_entry(&dir, HASH), Err(expected), "{file}");
        }
    }

    #[test]
    fn an_incomplete_entry_with_outputs_is_still_a_miss() {
        let dir = entry("abc", "");

        put(&dir, "outputs.tar.br", b"");

        assert_eq!(lookup_entry(&dir, HASH), Ok(CacheLookup::Miss));
    }

    #[test]
    fn invalid_utf8_is_not_reproducible() {
        let dir = entry("0", "");

        put(&dir, "terminalOutput", &[0xff, 0xfe]);

        assert_eq!(
            lookup_entry(&dir, HASH),
            Err(NotReproducible::EntryNotUtf8 { entry: HASH.into(), file: "terminalOutput" })
        );
    }

    #[test]
    fn a_value_that_is_not_a_task_hash_is_refused() {
        let dir = entry("0", "");

        for bad in [
            "",
            "../x",
            "0BF3560BE734757197A4FEE351196867",
            "0bf3560be734757197a4fee35119686",
            "0bf3560be734757197a4fee3511968671",
        ] {
            assert_eq!(lookup_entry(&dir, bad), Err(NotReproducible::InvalidHash(bad.into())));
        }
    }

    #[test]
    fn lookup_never_writes() {
        let dir = entry("0", "x");
        let before = fs::metadata(dir.join(HASH)).unwrap().modified().unwrap();

        lookup_entry(&dir, HASH).unwrap();

        assert_eq!(fs::metadata(dir.join(HASH)).unwrap().modified().unwrap(), before);
        assert_eq!(fs::read_dir(dir.join(HASH)).unwrap().count(), 3);
    }
}
