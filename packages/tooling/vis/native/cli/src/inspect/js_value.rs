//! Reading a parsed JSON value the way the Node marshalls read the object `JSON.parse` gave them: the own property of
//! an object, a string, and the keys in the order JavaScript lists them.

use crate::keys_refresh::{array_index, Js};

impl Js {
    /// The own member `key` of an object; `None` for another kind of value and for a missing member.
    pub(super) fn member(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }

    pub(super) fn text(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text),
            _ => None,
        }
    }

    pub(super) fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }

    /// `Object.entries` of an object: the integer-like keys first and ascending, the others in the order they were
    /// written. An empty list for a value that is not an object.
    pub(super) fn ordered(&self) -> Vec<(&str, &Self)> {
        let Self::Object(entries) = self else { return Vec::new() };
        let mut indexed: Vec<(u32, &str, &Self)> =
            entries.iter().filter_map(|(key, value)| Some((array_index(key)?, key.as_str(), value))).collect();

        indexed.sort_by_key(|(index, ..)| *index);

        indexed
            .into_iter()
            .map(|(_, key, value)| (key, value))
            .chain(
                entries.iter().filter(|(key, _)| array_index(key).is_none()).map(|(key, value)| (key.as_str(), value)),
            )
            .collect()
    }
}

/// `Object.entries` of an object that is taken apart: its entries in JavaScript's order.
pub(super) fn into_ordered(entries: Vec<(String, Js)>) -> Vec<(String, Js)> {
    let (mut indexed, others): (Vec<_>, Vec<_>) = entries.into_iter().partition(|(key, _)| array_index(key).is_some());

    indexed.sort_by_key(|(key, _)| array_index(key));
    indexed.extend(others);

    indexed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Js {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn keys_come_in_javascript_order() {
        let value = parse(r#"{"b":1,"2":2,"1":3,"a":4,"a":5,"01":6}"#);
        let keys: Vec<&str> = value.ordered().into_iter().map(|(key, _)| key).collect();

        assert_eq!(keys, ["1", "2", "b", "a", "01"]);
        assert!(matches!(value.member("a"), Some(Js::Number(number)) if *number == 5.0));
        assert!(value.member("missing").is_none() && parse("[1]").member("0").is_none());
    }
}
