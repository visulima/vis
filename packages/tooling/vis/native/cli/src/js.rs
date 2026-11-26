//! The JavaScript behaviours the native commands reproduce, in one place: whitespace and `parseInt`, truthiness,
//! `Number#toString`, `JSON.stringify` of a string, the keys an object lists before all others, `randomUUID`, and the
//! `Object.prototype` names a plain-object lookup would resolve to an inherited member.
//!
//! Whitespace, `parseInt` and the string escape are owned by `task_runner_core::js` (the task hasher needs them too)
//! and re-exported here. Calendar arithmetic is in `vis_core::date`, which the addon uses as well.

use serde_json::Value;
pub(crate) use task_runner_core::js::{is_js_whitespace, json_string, parse_int};

/// `Number.MAX_SAFE_INTEGER`: the largest integer a JavaScript number holds exactly.
pub(crate) const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The names of `Object.prototype` members: `defaults[name]` and `key in {}` resolve these through the prototype in
/// the Node path, and `__proto__` is assigned through its setter, so a map holding one is Node's to answer.
pub(crate) const PROTOTYPE_NAMES: [&str; 12] = [
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// The names a task or script may not take: the prototype members and `prototype`.
pub(crate) const RESERVED_NAMES: [&str; 13] = [
    "__proto__",
    "constructor",
    "prototype",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// `String.prototype.trim`.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Bool(true) | Value::Array(_) | Value::Object(_) => true,
    }
}

/// Whether JavaScript lists `key` ahead of the other keys of an object, or stores it other than as a plain property:
/// `__proto__`, and a canonical array index (`"0"`, `"17"`). Every all-digit key without a leading zero counts, past
/// 2^32 - 2 as well, which only makes a caller hand more to Node. `""` and `"007"` are ordinary keys.
pub(crate) fn is_index_like(key: &str) -> bool {
    key == "__proto__"
        || (!key.is_empty() && key.bytes().all(|byte| byte.is_ascii_digit()) && (key == "0" || !key.starts_with('0')))
}

/// `JSON.stringify(object, undefined, 2)` and a newline, for fields whose values are already written as JSON.
pub(crate) fn pretty_document(fields: &[(&str, String)]) -> String {
    let lines: Vec<String> = fields.iter().map(|(name, value)| format!("  \"{name}\": {value}")).collect();

    format!("{{\n{}\n}}\n", lines.join(",\n"))
}

/// `Number.prototype.toString` for a double: the shortest digits that read back as the same double, in decimal from
/// 1e-6 up to 1e21 and in exponent form beyond.
pub(crate) fn js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }

    if value.is_infinite() {
        return if value < 0.0 { "-Infinity" } else { "Infinity" }.to_owned();
    }

    if value == 0.0 {
        return "0".to_owned();
    }

    if value < 0.0 {
        return format!("-{}", js_number(-value));
    }

    // Rust prints the shortest digits that round-trip too: `d.ddde<exponent>`.
    let scientific = format!("{value:e}");
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|character| *character != '.').collect();
    let point = exponent.parse::<i32>().unwrap_or(0) + 1;
    let length = digits.len() as i32;

    if length <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - length) as usize))
    } else if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(point as usize);

        format!("{whole}.{fraction}")
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let power = point - 1;
        let sign = if power < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        let fraction = if rest.is_empty() { String::new() } else { format!(".{rest}") };

        format!("{first}{fraction}e{sign}{}", power.abs())
    }
}

/// `JSON.stringify` of a number: [`js_number`], and `null` for one that is not finite.
pub(crate) fn json_number(value: f64) -> String {
    if value.is_finite() {
        js_number(value)
    } else {
        "null".to_owned()
    }
}

/// Fills `bytes` from the operating system's entropy.
#[cfg(unix)]
pub(crate) fn fill_random(bytes: &mut [u8; 16]) -> Option<()> {
    use std::io::Read;

    std::fs::File::open("/dev/urandom").ok()?.read_exact(bytes).ok()
}

/// Fills `bytes` from the randomly keyed hasher the standard library seeds, mixed with the time and process id.
#[cfg(not(unix))]
pub(crate) fn fill_random(bytes: &mut [u8; 16]) -> Option<()> {
    use std::hash::{BuildHasher, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    for chunk in bytes.chunks_mut(8) {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();

        hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos()));
        hasher.write_u32(std::process::id());
        chunk.copy_from_slice(&hasher.finish().to_le_bytes());
    }

    Some(())
}

/// `crypto.randomUUID()`: a version 4 UUID. `None` where the system gives no entropy to read.
pub(crate) fn random_uuid() -> Option<String> {
    let mut bytes = [0u8; 16];

    fill_random(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();

    Some(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

/// `new Date().toISOString()`.
pub(crate) fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    vis_core::date::iso_from_millis(
        i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()).unwrap_or(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_strips_what_javascript_strips() {
        assert_eq!(trim("\u{feff} \t a b \u{a0}\u{2028}\n"), "a b");
        // U+0085 is whitespace to Rust and not to JavaScript.
        assert_eq!(trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
        // `\s` and `trim` agree: every character one strips is whitespace to the other.
        assert!((0..=0x10ffff)
            .filter_map(char::from_u32)
            .all(|c| is_js_whitespace(c) == (c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))));
    }

    #[test]
    fn parse_int_leads_with_javascript_whitespace() {
        assert_eq!(parse_int("  42px"), Some(42));
        assert_eq!(parse_int("\u{feff}7"), Some(7));
        assert_eq!(parse_int("\u{85}7"), None);
        assert_eq!(parse_int("-3"), Some(-3));
        assert_eq!(parse_int("x"), None);
    }

    #[test]
    fn truthiness_follows_javascript() {
        for falsy in
            [Value::Null, Value::Bool(false), serde_json::json!(0), serde_json::json!(-0.0), serde_json::json!("")]
        {
            assert!(!is_truthy(&falsy), "{falsy}");
        }

        for truthy in [
            Value::Bool(true),
            serde_json::json!(1),
            serde_json::json!(0.5),
            serde_json::json!("0"),
            serde_json::json!([]),
            serde_json::json!({}),
        ] {
            assert!(is_truthy(&truthy), "{truthy}");
        }
    }

    #[test]
    fn index_like_keys_are_the_ones_javascript_lists_first() {
        for key in ["__proto__", "0", "1", "17", "4294967295", "99999999999999999999"] {
            assert!(is_index_like(key), "{key}");
        }

        for key in ["", "00", "007", "01", "-1", "1.5", "1e3", "a1", "1a", "proto", "__proto", " 1", "٣"] {
            assert!(!is_index_like(key), "{key:?}");
        }
    }

    #[test]
    fn js_number_matches_number_to_string() {
        let cases: [(f64, &str); 20] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (100.0, "100"),
            (1.5, "1.5"),
            (0.001, "0.001"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e15, "1000000000000000"),
            (1e21, "1e+21"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (9_007_199_254_740_992.0, "9007199254740992"),
            (-2.5, "-2.5"),
            (4.5, "4.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::MAX, "1.7976931348623157e+308"),
        ];

        for (value, expected) in cases {
            assert_eq!(js_number(value), expected, "value {value:?}");
        }
    }

    #[test]
    fn a_document_is_stringified_with_two_spaces_and_a_final_newline() {
        assert_eq!(
            pretty_document(&[("a", "1".to_owned()), ("b", "\"x\"".to_owned())]),
            "{\n  \"a\": 1,\n  \"b\": \"x\"\n}\n"
        );
    }

    #[test]
    fn json_numbers_that_are_not_finite_are_null() {
        assert_eq!(json_number(f64::NAN), "null");
        assert_eq!(json_number(f64::NEG_INFINITY), "null");
        assert_eq!(json_number(-2.5), "-2.5");
    }

    #[test]
    fn a_random_uuid_is_version_4_and_differs_each_time() {
        let uuid = random_uuid().unwrap();
        let again = random_uuid().unwrap();

        assert_eq!(uuid.len(), 36);
        assert_eq!(uuid.as_bytes()[14], b'4');
        assert!(matches!(uuid.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(uuid, again);
    }

    #[test]
    fn the_reserved_names_are_the_prototype_names_and_prototype() {
        assert!(PROTOTYPE_NAMES.iter().all(|name| RESERVED_NAMES.contains(name)));
        assert_eq!(RESERVED_NAMES.len(), PROTOTYPE_NAMES.len() + 1);
        assert!(RESERVED_NAMES.contains(&"prototype") && !PROTOTYPE_NAMES.contains(&"prototype"));
    }

    #[test]
    fn the_timestamp_is_an_iso_string_with_milliseconds() {
        let text = iso_now();

        assert_eq!(text.len(), 24);
        assert!(text.ends_with('Z') && text.as_bytes()[10] == b'T' && text.as_bytes()[19] == b'.');
    }
}
