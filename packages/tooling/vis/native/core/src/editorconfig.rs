//! `.editorconfig` defaults for a file: the indent string and the line ending a formatter should write.
//!
//! The `vis-native` addon exposes this to Node (`resolveEditorconfigDefaults`) and the `vis` CLI calls
//! it directly, so both read a project's `.editorconfig` through the same `ec4rs` parser.

use ec4rs::property::{EndOfLine, IndentSize, IndentStyle};

/// Widest `indent_size` taken at face value. A larger value is treated like an unparseable one, because
/// `" ".repeat(width)` on an absurd width aborts the process on allocation failure.
pub const MAX_INDENT_SIZE: usize = 255;

/// What `.editorconfig` configures for one file. A field is `None` when nothing usable is set.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Defaults {
    /// A tab, or that many spaces.
    pub indent: Option<String>,
    /// `"lf"` or `"crlf"`.
    pub line_ending: Option<&'static str>,
}

/// Resolves the `.editorconfig` defaults of `file_path` with the spec-compliant `ec4rs` parser. Parse and
/// I/O failures collapse to an empty result so callers can fall back to sniffing the file's contents.
pub fn resolve(file_path: &str) -> Defaults {
    let Ok(properties) = ec4rs::properties_of(file_path) else {
        return Defaults::default();
    };

    let indent = if matches!(properties.get::<IndentStyle>(), Ok(IndentStyle::Tabs)) {
        Some("\t".to_string())
    } else if let Ok(IndentSize::Value(width)) = properties.get::<IndentSize>() {
        (1..=MAX_INDENT_SIZE).contains(&width).then(|| " ".repeat(width))
    } else {
        None
    };

    let line_ending = match properties.get::<EndOfLine>() {
        Ok(EndOfLine::Lf) => Some("lf"),
        Ok(EndOfLine::CrLf) => Some("crlf"),
        _ => None,
    };

    Defaults { indent, line_ending }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

    /// Writes `.editorconfig` into a fresh temp dir and resolves a file next to it.
    fn resolve_with(editorconfig: &str) -> Defaults {
        let dir = std::env::temp_dir().join(format!(
            "vis-core-editorconfig-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".editorconfig"), editorconfig).unwrap();
        let defaults = resolve(dir.join("package.json").to_str().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
        defaults
    }

    #[test]
    fn indent_size_becomes_that_many_spaces() {
        let defaults = resolve_with("root = true\n[*]\nindent_style = space\nindent_size = 4\n");

        assert_eq!(defaults.indent.as_deref(), Some("    "));
    }

    #[test]
    fn an_absurd_indent_size_is_ignored_instead_of_aborting_on_allocation() {
        let defaults = resolve_with("root = true\n[*]\nindent_style = space\nindent_size = 1000000000000000\n");

        assert_eq!(defaults.indent, None);
    }

    #[test]
    fn the_largest_accepted_indent_size_still_resolves() {
        let defaults = resolve_with(&format!("root = true\n[*]\nindent_size = {MAX_INDENT_SIZE}\n"));

        assert_eq!(defaults.indent.map(|indent| indent.len()), Some(MAX_INDENT_SIZE));
    }
}
