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
/// the Node loader resolves, `versionConstraint` can fail the run, `security` makes the Node
/// hook report policy errors for package-manager commands, and the four removed keys
/// (`src/config/deprecation.ts`) make the Node loader fail.
const NODE_ONLY_KEYS: [&str; 8] = [
    "runtime",
    "extends",
    "versionConstraint",
    "security",
    "targetDefaults",
    "taskRunnerOptions",
    "taskDefaults",
    "scopedTasks",
];

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

/// Read the config that applies to `cwd`, walking up like the Node loader does. A config that is not a
/// literal is [`ConfigState::Dynamic`]; this never starts Node and never writes anything.
pub fn read(cwd: &Path) -> ConfigState {
    read_config(cwd, false)
}

/// Like [`read`], but a lone config file that is not a literal is evaluated by Node (or read back from the
/// cache of an earlier evaluation, see `config_cache`). Callers use it only once nothing but the config's
/// value can still decide between the native path and Node, because an evaluation costs a Node start.
pub fn read_evaluated(cwd: &Path) -> ConfigState {
    read_config(cwd, true)
}

fn read_config(cwd: &Path, evaluate: bool) -> ConfigState {
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
        // Not readable as a literal: Node's evaluation of it, cached by `config_cache`, stands in. A `.json`
        // file is data or nothing (Node does not load it), so it never reaches the evaluator.
        None if evaluate && path.extension().is_some_and(|extension| extension != "json") => {
            match crate::config_cache::resolve(&path) {
                Some(crate::config_cache::Resolved::Data(value)) if value.is_object() => ConfigState::Static(value),
                _ => ConfigState::Dynamic,
            }
        }
        _ => ConfigState::Dynamic,
    }
}

/// The `install.backend` pin the native path runs itself: `npm`, `pnpm` or `bun`, with no
/// `install.corepack`. Corepack dispatch and every other backend stay with Node, which is why
/// they return `None`.
pub fn native_backend_pin(state: &ConfigState) -> Option<&str> {
    let ConfigState::Static(value) = state else {
        return None;
    };
    let install = value.get("install")?;

    if !install.is_object() || install.get("corepack").is_some() {
        return None;
    }

    install.get("backend")?.as_str().filter(|backend| matches!(*backend, "npm" | "pnpm" | "bun"))
}

/// Whether the native path must hand the command to Node. Node owns the package manager a
/// config pins (`install.backend` unless it is `native_backend_pin`, `install.corepack`), the
/// keys in `NODE_ONLY_KEYS`, and any config it cannot read as data at all.
pub fn requires_node(state: &ConfigState) -> bool {
    match state {
        ConfigState::Absent => false,
        ConfigState::Dynamic => true,
        ConfigState::Static(value) => {
            NODE_ONLY_KEYS.iter().any(|key| value.get(*key).is_some())
                || value.get("install").is_some_and(|install| {
                    !install.is_object()
                        || install.get("corepack").is_some()
                        || (install.get("backend").is_some() && native_backend_pin(state).is_none())
                })
        }
    }
}

/// The monorepo root Node's config loader reads `vis.config` from for `cwd`, or `None` when Node
/// finds none and ignores the config. Mirrors `findMonorepoRoot`: a lerna root, else the workspace
/// marker of the package manager the nearest lockfile or `packageManager` field names. A file that
/// cannot be read or parsed makes Node fail the same lookup, so it counts as no root.
pub fn node_config_root(cwd: &Path) -> Option<PathBuf> {
    for directory in cwd.ancestors() {
        if directory.join("lerna.json").is_file() {
            let lerna = read_json(&directory.join("lerna.json"))?;

            if lerna.is_object() && (is_truthy(lerna.get("useWorkspaces")) || is_truthy(lerna.get("packages"))) {
                return Some(directory.to_path_buf());
            }

            break;
        }

        if directory.join("turbo.json").is_file() {
            break;
        }
    }

    let (directory, manager) = nearest_package_manager(cwd)?;

    let is_root = match manager {
        Some("npm" | "yarn") => read_json(&directory.join("package.json"))
            .and_then(|manifest| manifest.get("workspaces").cloned())
            .is_some_and(|workspaces| workspaces.is_object() || workspaces.is_array()),
        Some("pnpm") => directory.join("pnpm-workspace.yaml").exists(),
        _ => false,
    };

    is_root.then(|| directory.to_path_buf())
}

/// Whether Node reads a `vis.config` pin from `cwd` and runs the pinned manager itself, so the
/// native path may do the same. Node loads only the config file in the workspace root, and only the
/// `.ts`/`.js` names (never `.json`). Node also picks its runtime from a bun lockfile, and a runtime
/// of bun overrides any pinned backend, so a bun lockfile on the way up leaves the pin to Node.
pub fn node_reads_pin(cwd: &Path) -> bool {
    const NODE_CONFIG_FILES: [&str; 6] =
        ["vis.config.ts", "vis.config.mts", "vis.config.cts", "vis.config.js", "vis.config.mjs", "vis.config.cjs"];

    let has_config = NODE_CONFIG_FILES.iter().any(|name| cwd.join(name).is_file());
    let bun_lockfile =
        cwd.ancestors().any(|directory| directory.join("bun.lock").exists() || directory.join("bun.lockb").exists());

    has_config && !bun_lockfile && node_config_root(cwd).as_deref() == Some(cwd)
}

/// Whether Node finds no monorepo root for `cwd` and so ignores every `vis.config` on the way up.
/// `findMonorepoRoot` fails without an error only when no lerna or turbo marker, no lockfile and no
/// `packageManager` pin is found, and every `package.json` parses. Any other failure is reported by Node,
/// so it returns `false` and the command stays with Node.
pub fn node_ignores_config(cwd: &Path) -> bool {
    for directory in cwd.ancestors() {
        let marked = directory.join("lerna.json").exists()
            || directory.join("turbo.json").exists()
            || LOCKFILES.iter().any(|(file, _)| directory.join(file).exists());

        if marked {
            return false;
        }

        let manifest_path = directory.join("package.json");

        if manifest_path.exists() {
            let Some(manifest) = read_json(&manifest_path) else {
                return false;
            };

            if manifest.get("packageManager").and_then(Value::as_str).is_some() {
                return false;
            }
        }
    }

    true
}

/// The lockfiles Node's manager lookup recognises, with the manager each one names.
const LOCKFILES: [(&str, &str); 6] = [
    ("pnpm-lock.yaml", "pnpm"),
    ("package-lock.json", "npm"),
    ("npm-shrinkwrap.json", "npm"),
    ("yarn.lock", "yarn"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
];

/// The nearest directory that names a package manager, with that manager. `None` for the manager
/// means the nearest marker names one Node cannot resolve a workspace from, such as bun.
fn nearest_package_manager(cwd: &Path) -> Option<(&Path, Option<&'static str>)> {
    for directory in cwd.ancestors() {
        if let Some((_, name)) = LOCKFILES.iter().find(|(file, _)| directory.join(file).exists()) {
            return Some((directory, Some(name)));
        }

        let manifest_path = directory.join("package.json");

        if !manifest_path.is_file() {
            continue;
        }

        let manifest = read_json(&manifest_path)?;

        if let Some(field) = manifest.get("packageManager").and_then(Value::as_str) {
            let name = ["npm", "yarn", "pnpm", "bun"].into_iter().find(|name| field.starts_with(name));

            return Some((directory, name));
        }
    }

    None
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// JavaScript truthiness of an optional JSON value, as Node's lookup tests `useWorkspaces || packages`.
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
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
                // Only `defineConfig` from the config module is allowed, and only when that subpath
                // resolves from the config file. Any other binding, and any side-effect import, is left to Node.
                if import.source.value != VIS_CONFIG_MODULE || !config_module_resolves(path) {
                    return None;
                }

                let specifiers = import.specifiers.as_ref().filter(|specifiers| !specifiers.is_empty())?;

                for specifier in specifiers.iter() {
                    let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                        return None;
                    };

                    if specifier.import_kind == ImportOrExportKind::Type {
                        continue;
                    }

                    if !matches!(&specifier.imported, ModuleExportName::IdentifierName(name) if name.name == "defineConfig")
                    {
                        return None;
                    }

                    define_config_names.push(specifier.local.name.to_string());
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

/// Whether `VIS_CONFIG_MODULE` resolves from the directory of `path`: the nearest installed
/// `@visulima/vis` exports that subpath, and its target file exists. Node may still fail to load
/// the target, so this is a check of the package map, not a proof that the module loads.
fn config_module_resolves(path: &Path) -> bool {
    let Some(directory) = path.parent() else {
        return false;
    };

    let Some(package) = directory
        .ancestors()
        .map(|ancestor| ancestor.join("node_modules").join("@visulima").join("vis"))
        .find(|package| package.join("package.json").is_file())
    else {
        return false;
    };

    let Some(manifest) = fs::read_to_string(package.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return false;
    };

    let file = match manifest.get("exports").and_then(|exports| exports.get("./config")) {
        Some(Value::String(file)) => Some(file.as_str()),
        Some(Value::Object(conditions)) => {
            ["import", "default"].iter().find_map(|key| conditions.get(*key).and_then(Value::as_str))
        }
        _ => None,
    };

    file.is_some_and(|file| package.join(file).is_file())
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

    // Lays out an installed `@visulima/vis` that exports `./config`, as the package does.
    fn install_vis_config_module(dir: &Path) {
        let package = dir.join("node_modules").join("@visulima").join("vis");

        fs::create_dir_all(package.join("dist")).unwrap();
        fs::write(
            package.join("package.json"),
            r#"{"exports":{"./config":{"types":"./dist/config.d.ts","default":"./dist/config.js"}}}"#,
        )
        .unwrap();
        fs::write(package.join("dist").join("config.js"), "export const defineConfig = (config) => config;\n").unwrap();
    }

    #[test]
    fn define_config_wrapper_is_unwrapped() {
        let dir = scratch("wrapper");

        install_vis_config_module(&dir);
        fs::write(
            dir.join("vis.config.ts"),
            "import { defineConfig } from '@visulima/vis/config';\nexport default defineConfig({ runtime: 'bun' });\n",
        )
        .unwrap();

        assert_eq!(read(&dir), ConfigState::Static(serde_json::json!({ "runtime": "bun" })));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn define_config_wrapper_with_an_unresolvable_helper_is_dynamic() {
        assert_eq!(
            config(
                "wrapper-unresolved",
                "vis.config.ts",
                "import { defineConfig } from '@visulima/vis/config';\nexport default defineConfig({ lint: {} });\n"
            ),
            ConfigState::Dynamic,
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
        assert!(needs(serde_json::json!({ "install": { "backend": "yarn" } })));
        assert!(needs(serde_json::json!({ "install": { "backend": "auto" } })));
        assert!(needs(serde_json::json!({ "install": { "backend": "npm", "corepack": "strict" } })));
        assert!(!needs(serde_json::json!({ "install": { "backend": "npm" } })));
        assert!(!needs(serde_json::json!({ "install": { "backend": "pnpm" } })));
        assert!(!needs(serde_json::json!({ "install": { "backend": "bun" } })));
        assert!(needs(serde_json::json!({ "install": { "corepack": "strict" } })));
        assert!(needs(serde_json::json!({ "runtime": "bun" })));
        assert!(needs(serde_json::json!({ "security": { "policies": { "installScripts": { "mode": "strict" } } } })));
        assert!(needs(serde_json::json!({ "install": "npm" })));
        assert!(needs(serde_json::json!({ "targetDefaults": {} })));
        assert!(needs(serde_json::json!({ "scopedTasks": [] })));
    }

    fn files(name: &str, entries: &[(&str, &str)]) -> PathBuf {
        let dir = scratch(name);

        for (file, text) in entries {
            fs::write(dir.join(file), text).unwrap();
        }

        dir
    }

    #[test]
    fn a_single_package_is_not_a_monorepo_root_for_node() {
        let dir = files("single", &[("package.json", "{}"), ("pnpm-lock.yaml", "lockfileVersion: 9\n")]);

        assert_eq!(node_config_root(&dir), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bare_pnpm_workspace_has_no_node_root_and_node_ignores_its_config() {
        let dir = files(
            "bare-pnpm-workspace",
            &[("pnpm-workspace.yaml", "packages: []\n"), ("vis.config.ts", "export default {};\n")],
        );

        assert_eq!(node_config_root(&dir), None);
        assert!(node_ignores_config(&dir));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_manifest_that_does_not_parse_is_not_a_silent_node_failure() {
        let dir = files("broken-manifest", &[("package.json", "{"), ("pnpm-workspace.yaml", "packages: []\n")]);

        assert!(!node_ignores_config(&dir));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_workspace_marker_of_the_nearest_manager_is_a_monorepo_root() {
        let pnpm = files(
            "pnpm-root",
            &[("pnpm-workspace.yaml", "packages: []\n"), ("pnpm-lock.yaml", "lockfileVersion: 9\n")],
        );
        let npm = files("npm-root", &[("package.json", "{\"workspaces\":[]}"), ("package-lock.json", "{}")]);

        assert_eq!(node_config_root(&pnpm), Some(pnpm.clone()));
        assert_eq!(node_config_root(&npm), Some(npm.clone()));

        fs::remove_dir_all(&pnpm).ok();
        fs::remove_dir_all(&npm).ok();
    }

    #[test]
    fn lerna_packages_make_a_root_even_for_bun() {
        let dir = files("lerna-bun", &[("lerna.json", "{\"packages\":[]}"), ("bun.lock", "{}")]);

        assert_eq!(node_config_root(&dir), Some(dir.clone()));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bun_workspaces_without_lerna_are_not_a_root_for_node() {
        let dir = files("bun-workspaces", &[("package.json", "{\"workspaces\":[\"p/*\"]}"), ("bun.lock", "{}")]);

        assert_eq!(node_config_root(&dir), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_nearest_package_manager_decides_the_root() {
        let root =
            files("nearest", &[("pnpm-workspace.yaml", "packages: []\n"), ("pnpm-lock.yaml", "lockfileVersion: 9\n")]);
        let child = root.join("child");

        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("package.json"), "{}").unwrap();
        fs::write(child.join("package-lock.json"), "{}").unwrap();

        assert_eq!(node_config_root(&child), None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unparsable_manifest_is_not_a_root_for_node() {
        let dir = files("bad-json", &[("package.json", "{"), ("pnpm-workspace.yaml", "packages: []\n")]);

        assert_eq!(node_config_root(&dir), None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn node_reads_a_pin_only_from_a_root_config_without_a_bun_runtime() {
        let root =
            files("reads-pin", &[("lerna.json", "{\"packages\":[]}"), ("vis.config.ts", "export default {};\n")]);
        let child = root.join("child");

        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("vis.config.ts"), "export default {};\n").unwrap();

        assert!(node_reads_pin(&root));
        assert!(!node_reads_pin(&child), "a subpackage config is not the workspace root's");

        fs::write(root.join("bun.lock"), "{}").unwrap();
        assert!(!node_reads_pin(&root), "a bun lockfile makes Node run bun");
        fs::remove_file(root.join("bun.lock")).unwrap();

        fs::remove_file(root.join("vis.config.ts")).unwrap();
        fs::write(root.join("vis.config.json"), "{}").unwrap();
        assert!(!node_reads_pin(&root), "Node never loads a .json config");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn native_backend_pin_is_only_npm_pnpm_or_bun_without_corepack() {
        let pin = |value: Value| native_backend_pin(&ConfigState::Static(value)).map(str::to_owned);

        assert_eq!(pin(serde_json::json!({ "install": { "backend": "npm" } })).as_deref(), Some("npm"));
        assert_eq!(pin(serde_json::json!({ "install": { "backend": "pnpm" } })).as_deref(), Some("pnpm"));
        assert_eq!(pin(serde_json::json!({ "install": { "backend": "bun" } })).as_deref(), Some("bun"));
        assert_eq!(pin(serde_json::json!({ "install": { "backend": "aube" } })), None);
        assert_eq!(pin(serde_json::json!({ "install": { "backend": "yarn" } })), None);
        assert_eq!(pin(serde_json::json!({ "install": { "backend": "auto" } })), None);
        assert_eq!(pin(serde_json::json!({ "install": { "backend": "npm", "corepack": "off" } })), None);
        assert_eq!(pin(serde_json::json!({ "install": { "corepack": "off" } })), None);
        assert_eq!(pin(serde_json::json!({ "install": "npm" })), None);
        assert_eq!(native_backend_pin(&ConfigState::Dynamic), None);
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

    #[test]
    fn an_inline_type_only_define_config_is_not_a_helper() {
        assert_eq!(
            config(
                "inline-type",
                "vis.config.ts",
                "import { type defineConfig } from '@visulima/vis/config';\nexport default defineConfig({});\n"
            ),
            ConfigState::Dynamic,
        );
    }

    #[test]
    fn other_bindings_and_side_effect_imports_from_the_config_module_are_dynamic() {
        assert_eq!(
            config(
                "other-binding",
                "vis.config.ts",
                "import { other } from '@visulima/vis/config';\nexport default { lint: {} };\n"
            ),
            ConfigState::Dynamic,
        );
        assert_eq!(
            config(
                "side-effect-config",
                "vis.config.ts",
                "import '@visulima/vis/config';\nexport default { lint: {} };\n"
            ),
            ConfigState::Dynamic,
        );
    }
}
