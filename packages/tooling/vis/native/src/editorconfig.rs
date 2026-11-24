use napi_derive::napi;

#[napi(object)]
pub struct EditorconfigDefaults {
    pub indent: Option<String>,
    pub line_ending: Option<String>,
}

/// Resolves `.editorconfig` defaults for `file_path` using the spec-compliant
/// `ec4rs` parser. Mirrors the previous `editorconfig` npm package surface
/// consumed by `src/util/editorconfig.ts`: returns the indent string and a
/// normalized line-ending tag, or `None` for either when no usable value is
/// configured. Parse / IO failures collapse to an empty result so callers can
/// fall back to content sniffing without try/catch noise. The lookup lives in
/// `vis-core`, which the native CLI calls too.
#[napi]
pub fn resolve_editorconfig_defaults(file_path: String) -> EditorconfigDefaults {
    let defaults = vis_core::editorconfig::resolve(&file_path);

    EditorconfigDefaults { indent: defaults.indent, line_ending: defaults.line_ending.map(str::to_owned) }
}
