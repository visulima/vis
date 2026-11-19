//! The `vis.config.*` file that applies to a directory, read as data.
//!
//! A config that is a plain literal (optionally wrapped in `defineConfig(...)`) is
//! read here without running it. Anything that would need evaluation (calls, values
//! from imports, environment reads, several default exports, …) is reported as
//! [`ConfigState::Dynamic`], and the caller hands the decision to the Node CLI.

use std::fs;
use std::path::{Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ArrayExpressionElement, Expression, ImportDeclarationSpecifier, ImportOrExportKind, ModuleExportName,
    ObjectPropertyKind, PropertyKey, PropertyKind, Statement, UnaryOperator,
};
use oxc_parser::Parser;
use oxc_span::SourceType;
use serde_json::{Map, Number, Value};

/// Top-level keys the native path must leave to Node. `runtime` and `extends` change what
/// the Node loader resolves, `versionConstraint` can fail the run, and the four removed keys
/// (`src/config/deprecation.ts`) make the Node loader fail.
const NODE_ONLY_KEYS: [&str; 7] =
    ["runtime", "extends", "versionConstraint", "targetDefaults", "taskRunnerOptions", "taskDefaults", "scopedTasks"];

/// The module `defineConfig` is imported from. Its evaluation is harmless, so a value import
/// from it is allowed, and only a `defineConfig` bound to it is unwrapped.
const VIS_CONFIG_MODULE: &str = "@visulima/vis/config";

/// Config file names in the order the Node loader tries them within one directory.
const NAMES: [&str; 7] = [
    "vis.config.ts",
    "vis.config.mts",
    "vis.config.cts",
    "vis.config.js",
    "vis.config.mjs",
    "vis.config.cjs",
    "vis.config.json",
];

#[derive(Debug, PartialEq)]
pub enum ConfigState {
    Absent,
    Static(Value),
    Dynamic,
}

/// Read the config that applies to `cwd`, walking up like the Node loader does.
pub fn read(cwd: &Path) -> ConfigState {
    let mut paths = configs(cwd);

    // Node loads the config of the workspace root, which is not known here. With several
    // config files on the way up, which one applies is a question only Node can answer.
    let path = match paths.len() {
        0 => return ConfigState::Absent,
        1 => paths.remove(0),
        _ => return ConfigState::Dynamic,
    };

    let Ok(source) = fs::read_to_string(&path) else {
        return ConfigState::Dynamic;
    };

    let value = if path.extension().is_some_and(|extension| extension == "json") {
        serde_json::from_str(&source).ok()
    } else {
        static_default_export(&path, &source)
    };

    match value {
        Some(value) if value.is_object() => ConfigState::Static(value),
        _ => ConfigState::Dynamic,
    }
}

/// Whether the native path must hand the command to Node. Node owns the package manager a
/// config pins (`install.backend`, `install.corepack`), the keys in `NODE_ONLY_KEYS`, and any
/// config it cannot read as data at all.
pub fn requires_node(state: &ConfigState) -> bool {
    match state {
        ConfigState::Absent => false,
        ConfigState::Dynamic => true,
        ConfigState::Static(value) => {
            NODE_ONLY_KEYS.iter().any(|key| value.get(*key).is_some())
                || value.get("install").is_some_and(|install| {
                    !install.is_object() || install.get("backend").is_some() || install.get("corepack").is_some()
                })
        }
    }
}

/// The config file of each directory from `cwd` up to the root, nearest first.
fn configs(cwd: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut current = Some(cwd.to_path_buf());

    while let Some(directory) = current {
        if let Some(path) = NAMES.iter().map(|name| directory.join(name)).find(|path| path.exists()) {
            found.push(path);
        }

        current = directory.parent().map(Path::to_path_buf).filter(|parent| parent != &directory);
    }

    found
}

/// The value of the single `export default`, with an optional `defineConfig(...)` wrapper.
/// Type-only imports are erased. Any other import runs a module, and any other statement
/// may have effects, so either makes the file dynamic. The one exception is the
/// `defineConfig` helper from `VIS_CONFIG_MODULE`.
fn static_default_export(path: &Path, source: &str) -> Option<Value> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).ok()?;
    let parsed = Parser::new(&allocator, source, source_type).parse();

    if parsed.fatal_error || !parsed.diagnostics.is_empty() {
        return None;
    }

    let mut default = None;
    let mut define_config_names = Vec::new();

    for statement in &parsed.program.body {
        match statement {
            Statement::ImportDeclaration(import) if import.import_kind == ImportOrExportKind::Type => {}
            Statement::ImportDeclaration(import) => {
                if import.source.value != VIS_CONFIG_MODULE {
                    return None;
                }

                for specifier in import.specifiers.iter().flatten() {
                    if let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier {
                        if matches!(&specifier.imported, ModuleExportName::IdentifierName(name) if name.name == "defineConfig")
                        {
                            define_config_names.push(specifier.local.name.to_string());
                        }
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                if default.is_some() {
                    return None;
                }

                default = Some(static_value(unwrap_define_config(
                    export.declaration.as_expression()?,
                    &define_config_names,
                ))?);
            }
            _ => return None,
        }
    }

    default
}

/// Unwraps `defineConfig(x)` only when `defineConfig` is bound to the vis config module.
fn unwrap_define_config<'a, 'b>(expression: &'b Expression<'a>, names: &[String]) -> &'b Expression<'a> {
    if let Expression::CallExpression(call) = expression {
        if let (Expression::Identifier(callee), [argument]) = (&call.callee, call.arguments.as_slice()) {
            if names.iter().any(|name| callee.name == name.as_str()) {
                if let Some(inner) = argument.as_expression() {
                    return inner;
                }
            }
        }
    }

    expression
}

fn static_value(expression: &Expression<'_>) -> Option<Value> {
    match expression {
        Expression::ObjectExpression(object) => {
            let mut map = Map::new();

            for property in &object.properties {
                let ObjectPropertyKind::ObjectProperty(property) = property else {
                    return None;
                };

                if property.computed || property.method || property.kind != PropertyKind::Init {
                    return None;
                }

                let key = match &property.key {
                    PropertyKey::StaticIdentifier(identifier) => identifier.name.to_string(),
                    PropertyKey::StringLiteral(literal) => literal.value.to_string(),
                    _ => return None,
                };

                if map.insert(key, static_value(&property.value)?).is_some() {
                    return None;
                }
            }

            Some(Value::Object(map))
        }
        Expression::ArrayExpression(array) => array
            .elements
            .iter()
            .map(|element| match element {
                ArrayExpressionElement::SpreadElement(_) | ArrayExpressionElement::Elision(_) => None,
                element => static_value(element.as_expression()?),
            })
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        Expression::StringLiteral(literal) => Some(Value::String(literal.value.to_string())),
        Expression::NumericLiteral(literal) => Number::from_f64(literal.value).map(Value::Number),
        Expression::BooleanLiteral(literal) => Some(Value::Bool(literal.value)),
        Expression::NullLiteral(_) => Some(Value::Null),
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::UnaryNegation => match &unary.argument {
            Expression::NumericLiteral(literal) => Number::from_f64(-literal.value).map(Value::Number),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vis-config-{}-{name}", std::process::id()));

        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        dir
    }

    fn config(name: &str, file: &str, source: &str) -> ConfigState {
        let dir = scratch(name);

        fs::write(dir.join(file), source).unwrap();

        let state = read(&dir);

        let _ = fs::remove_dir_all(&dir);

        state
    }

    #[test]
    fn no_config_file_is_absent() {
        let dir = scratch("absent");

        assert_eq!(read(&dir), ConfigState::Absent);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_literal_default_export_is_read_as_data() {
        assert_eq!(
            config(
                "literal",
                "vis.config.ts",
                "export default { install: { backend: 'npm' }, list: [1, -2.5, true, null] };\n"
            ),
            ConfigState::Static(
                serde_json::json!({ "install": { "backend": "npm" }, "list": [1.0, -2.5, true, null] })
            ),
        );
    }

    #[test]
    fn define_config_wrapper_is_unwrapped() {
        assert_eq!(
            config(
                "wrapper",
                "vis.config.ts",
                "import { defineConfig } from '@visulima/vis/config';\nexport default defineConfig({ runtime: 'bun' });\n"
            ),
            ConfigState::Static(serde_json::json!({ "runtime": "bun" })),
        );
    }

    #[test]
    fn json_config_is_read_as_data() {
        assert_eq!(
            config("json", "vis.config.json", r#"{"install":{"corepack":"off"}}"#),
            ConfigState::Static(serde_json::json!({ "install": { "corepack": "off" } }))
        );
    }

    #[test]
    fn invalid_json_is_dynamic() {
        assert_eq!(config("bad-json", "vis.config.json", "{"), ConfigState::Dynamic);
    }

    #[test]
    fn environment_reads_and_calls_are_dynamic() {
        assert_eq!(
            config("env", "vis.config.ts", "export default { runtime: process.env.RUNTIME };\n"),
            ConfigState::Dynamic
        );
        assert_eq!(config("call", "vis.config.ts", "export default { runtime: pick() };\n"), ConfigState::Dynamic);
    }

    #[test]
    fn an_identifier_from_an_import_is_dynamic() {
        assert_eq!(
            config("import", "vis.config.ts", "import shared from './shared';\nexport default { install: shared };\n"),
            ConfigState::Dynamic
        );
    }

    #[test]
    fn side_effects_and_several_exports_are_dynamic() {
        assert_eq!(
            config("side-effect", "vis.config.ts", "console.log('hi');\nexport default {};\n"),
            ConfigState::Dynamic
        );
        assert_eq!(
            config("two-defaults", "vis.config.ts", "export default {};\nexport default {};\n"),
            ConfigState::Dynamic
        );
    }

    #[test]
    fn spreads_computed_and_duplicate_keys_are_dynamic() {
        assert_eq!(config("spread", "vis.config.ts", "export default { ...base };\n"), ConfigState::Dynamic);
        assert_eq!(config("computed", "vis.config.ts", "export default { ['a']: 1 };\n"), ConfigState::Dynamic);
        assert_eq!(config("duplicate", "vis.config.ts", "export default { a: 1, a: 2 };\n"), ConfigState::Dynamic);
    }

    #[test]
    fn a_non_object_root_is_dynamic() {
        assert_eq!(config("array-root", "vis.config.json", "[1]"), ConfigState::Dynamic);
    }

    #[test]
    fn node_is_required_for_pins_dynamic_configs_and_removed_keys() {
        let needs = |value: Value| requires_node(&ConfigState::Static(value));

        assert!(!requires_node(&ConfigState::Absent));
        assert!(requires_node(&ConfigState::Dynamic));
        assert!(!needs(serde_json::json!({ "lint": { "enabled": true } })));
        assert!(needs(serde_json::json!({ "install": { "backend": "aube" } })));
        assert!(needs(serde_json::json!({ "install": { "corepack": "strict" } })));
        assert!(needs(serde_json::json!({ "runtime": "bun" })));
        assert!(needs(serde_json::json!({ "install": "npm" })));
        assert!(needs(serde_json::json!({ "targetDefaults": {} })));
        assert!(needs(serde_json::json!({ "scopedTasks": [] })));
    }

    #[test]
    fn extends_and_version_constraint_need_node() {
        let needs = |value: Value| requires_node(&ConfigState::Static(value));

        assert!(needs(serde_json::json!({ "extends": "./base.ts" })));
        assert!(needs(serde_json::json!({ "extends": ["./base.ts"] })));
        assert!(needs(serde_json::json!({ "versionConstraint": ">=1" })));
    }

    #[test]
    fn a_define_config_from_another_module_is_dynamic() {
        assert_eq!(
            config(
                "alias",
                "vis.config.ts",
                "import { defineConfig } from 'other-lib';\nexport default defineConfig({ lint: {} });\n"
            ),
            ConfigState::Dynamic,
        );
    }

    #[test]
    fn an_unbound_define_config_call_is_dynamic() {
        assert_eq!(
            config("unbound", "vis.config.ts", "export default defineConfig({ lint: {} });\n"),
            ConfigState::Dynamic
        );
    }

    #[test]
    fn a_side_effect_import_is_dynamic() {
        assert_eq!(
            config("side-import", "vis.config.ts", "import './setup';\nexport default {};\n"),
            ConfigState::Dynamic
        );
    }

    #[test]
    fn type_only_imports_are_read() {
        assert_eq!(
            config(
                "type-import",
                "vis.config.ts",
                "import type { Config } from './types';\nexport default { lint: {} };\n"
            ),
            ConfigState::Static(serde_json::json!({ "lint": {} })),
        );
    }

    #[test]
    fn several_config_files_on_the_way_up_are_dynamic() {
        let root = scratch("nested");
        let package = root.join("packages").join("app");

        fs::create_dir_all(&package).unwrap();
        fs::write(root.join("vis.config.ts"), "export default { install: { backend: 'npm' } };\n").unwrap();
        fs::write(package.join("vis.config.ts"), "export default { lint: {} };\n").unwrap();

        assert_eq!(read(&package), ConfigState::Dynamic);

        let _ = fs::remove_dir_all(&root);
    }
}
