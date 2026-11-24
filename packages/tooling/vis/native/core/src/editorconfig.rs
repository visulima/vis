//! `.editorconfig` defaults for a file: the indent string and the line ending a formatter should write.
//!
//! The `vis-native` addon exposes this to Node (`resolveEditorconfigDefaults`) and the `vis` CLI calls
//! it directly, so both read a project's `.editorconfig` through the same `ec4rs` parser.

use ec4rs::property::{EndOfLine, IndentSize, IndentStyle};

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
        (width > 0).then(|| " ".repeat(width))
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
