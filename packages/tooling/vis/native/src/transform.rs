//! TypeScript / JSX → JavaScript transpilation via oxc.
//!
//! Powers vis's runtime TS loader (config files, generators, `vis x`), replacing
//! the `jiti` JS dependency with vis's own native addon — one binary, no extra
//! native dep. Strips types and lowers non-erasable syntax (enums, namespaces,
//! parameter properties, legacy decorators) and JSX. Does NOT type-check.

use std::path::Path;

use napi_derive::napi;
use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions, CodegenReturn};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};

#[napi(object)]
pub struct TransformResult {
    /// Transpiled JavaScript source.
    pub code: String,
}

/// Longest diagnostic list put into one error message.
const MAX_REPORTED_DIAGNOSTICS: usize = 10;

/// One `file:line:column: message` line. `offset` is a byte offset into `source`, the line and column
/// are 1-based and the column counts characters. Without an offset only the file is named.
fn diagnostic_line(filename: &str, source: &str, message: &str, offset: Option<u32>) -> String {
    let Some(offset) = offset else {
        return format!("{filename}: {message}");
    };

    let before = &source.as_bytes()[..(offset as usize).min(source.len())];
    let line = before.iter().filter(|byte| **byte == b'\n').count() + 1;
    let line_start = before.iter().rposition(|byte| *byte == b'\n').map_or(0, |newline| newline + 1);
    let column = String::from_utf8_lossy(&before[line_start..]).chars().count() + 1;

    format!("{filename}:{line}:{column}: {message}")
}

/// `headline`, then one indented line per diagnostic (at most [`MAX_REPORTED_DIAGNOSTICS`]).
fn failure_reason(headline: String, mut lines: Vec<String>) -> String {
    let hidden = lines.len().saturating_sub(MAX_REPORTED_DIAGNOSTICS);
    lines.truncate(MAX_REPORTED_DIAGNOSTICS);
    if hidden > 0 {
        lines.push(format!("... and {hidden} more"));
    }

    let mut reason = headline;
    for line in lines {
        reason.push_str("\n  ");
        reason.push_str(&line);
    }
    reason
}

/// Transpile a TS/TSX/JS/JSX source string to JavaScript. `filename` selects the
/// source dialect by extension (`.ts`/`.tsx`/`.mts`/`.cts`/`.js`/...). Returns the
/// emitted JS; throws on a fatal parse failure.
#[napi(catch_unwind)]
pub fn transform_ts(filename: String, source: String) -> napi::Result<TransformResult> {
    let allocator = Allocator::default();
    let path = Path::new(&filename);
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::ts());

    let parser_return = Parser::new(&allocator, &source, source_type).parse();

    if parser_return.fatal_error {
        let lines = parser_return
            .diagnostics
            .errors()
            .map(|d| diagnostic_line(&filename, &source, &d.message, d.labels.first().map(|label| label.offset())))
            .collect();

        return Err(napi::Error::from_reason(failure_reason(format!("vis-native: failed to parse {filename}"), lines)));
    }

    let mut program = parser_return.program;

    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();

    let options = TransformOptions::default();

    let transformer_return = Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);

    if transformer_return.diagnostics.has_errors() {
        let lines = transformer_return
            .diagnostics
            .errors()
            .map(|d| diagnostic_line(&filename, &source, &d.message, d.labels.first().map(|label| label.offset())))
            .collect();

        return Err(napi::Error::from_reason(failure_reason(
            format!("vis-native: failed to transform {filename}"),
            lines,
        )));
    }

    // Emit a source map so stack traces from `vis x`/config point at the original
    // TS source, not the transpiled output. Inlined as a base64 data URL so it
    // travels with the code through both loader tiers (registerHooks + temp file);
    // the runtime enables `process.setSourceMapsEnabled(true)` to consume it.
    let CodegenReturn { mut code, map, .. } = Codegen::new()
        .with_options(CodegenOptions { source_map_path: Some(path.to_path_buf()), ..Default::default() })
        .build(&program);

    if let Some(map) = map {
        code.push_str("\n//# sourceMappingURL=");
        code.push_str(&map.to_data_url());
        code.push('\n');
    }

    Ok(TransformResult { code })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(filename: &str, source: &str) -> String {
        match transform_ts(filename.to_string(), source.to_string()) {
            Ok(result) => panic!("expected a failure, got:\n{}", result.code),
            Err(error) => error.reason.to_string(),
        }
    }

    #[test]
    fn a_syntax_error_names_the_file_line_and_column() {
        let reason = failure("/work/vis.config.ts", "export default {\n  name: \"x\",\n  value: ,\n};\n");

        let mut lines = reason.lines();
        assert_eq!(lines.next(), Some("vis-native: failed to parse /work/vis.config.ts"));
        assert!(reason.contains("/work/vis.config.ts:3:10"), "no file:line:column in:\n{reason}");
    }

    #[test]
    fn the_column_counts_characters_not_bytes() {
        let reason = failure("a.ts", "const s = \"ééé\"; const = 1;\n");
        // The unexpected `=` is the 24th character and the 30th byte.
        assert!(reason.contains("a.ts:1:24: "), "column was not counted in characters:\n{reason}");
    }

    #[test]
    fn valid_source_still_transpiles() {
        let result = transform_ts("ok.ts".to_string(), "const x: number = 1; export default x;".to_string()).unwrap();

        assert!(result.code.contains("const x = 1"));
    }
}
