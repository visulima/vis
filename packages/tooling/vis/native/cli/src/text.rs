//! Predicates on the text the native commands print, named for the bytes they accept. Pail and `padEnd` count
//! UTF-16 units and this crate counts bytes, so a command prints a string itself only when the two agree.

use std::path::Path;

/// Printable ASCII without the space: the strings pail and `padEnd` handle exactly.
pub(crate) fn is_ascii_graphic(text: &str) -> bool {
    text.bytes().all(|byte| byte.is_ascii_graphic())
}

/// Printable ASCII, the space included: the bytes `padEnd` and a slice treat as one unit each.
pub(crate) fn is_ascii_printable(text: &str) -> bool {
    text.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

/// Whether a path is valid UTF-8 made of [`is_ascii_graphic`] text.
pub(crate) fn is_ascii_graphic_path(path: &Path) -> bool {
    path.to_str().is_some_and(is_ascii_graphic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_space_separates_the_two() {
        assert!(is_ascii_graphic("a-b_1"));
        assert!(!is_ascii_graphic("a b"));
        assert!(is_ascii_printable("a b"));
        assert!(!is_ascii_printable("a\tb"));
        assert!(!is_ascii_printable("caf\u{e9}"));
        assert!(is_ascii_graphic("") && is_ascii_printable(""));
    }
}
