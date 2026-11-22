//! The settings `vis sync ci-workflow` reads from `vis.config.*`, read natively and in source order.
//!
//! The native path answers only a config it can reproduce exactly: a literal `export default` (see
//! `vis_config`) at the workspace root, whose top-level keys are all ones that cannot change which
//! projects or targets exist, and whose `ci.workflow` holds only the documented keys with the documented
//! shapes. `serde_json::Value` sorts a map's keys, and the workflow prints `env`, `with`, `services`
//! and the like in the order they were written, so the config is read into [`Yaml`], which keeps it.
//! Anything else gives `None`, and Node runs the command.

use std::collections::BTreeMap;
use std::path::Path;

use oxc_ast::ast::{ArrayExpressionElement, Expression, UnaryOperator};

use super::github::{RunStep, Uses};
use super::yaml::{is_index_like, printable, Yaml};
use crate::vis_config::{config_file_in, convert_default_export, object_properties};

/// Top-level keys that cannot change the projects, their targets or anything the workflow prints, apart
/// from the ones read below.
const ALLOWED_KEYS: [&str; 6] = ["$schema", "ci", "defaultBase", "taskRunner", "tasks", "toolchain"];

const WORKFLOW_KEYS: [&str; 12] = [
    "affected",
    "branches",
    "buildFirst",
    "checkDrift",
    "github",
    "gitlab",
    "nodeVersion",
    "partitions",
    "providers",
    "runsOn",
    "targets",
    "timeoutMinutes",
];

#[derive(Clone, Debug, Default)]
pub struct TargetSetting {
    pub env: Option<Vec<(String, String)>>,
    pub name: String,
}

#[derive(Clone, Debug, Default)]
pub struct GithubSettings {
    pub after: Vec<RunStep>,
    pub after_setup: Vec<RunStep>,
    pub env: Option<Yaml>,
    pub permissions: Vec<(String, String)>,
    pub services: Option<Yaml>,
}

#[derive(Clone, Debug, Default)]
pub struct GitlabSettings {
    pub after_script: Option<Yaml>,
    pub before_script: Vec<String>,
    pub image: Option<String>,
    pub services: Option<Yaml>,
    pub stage: Option<String>,
    pub tags: Option<Yaml>,
    pub variables: Vec<(String, String)>,
}

/// `ci.workflow`.
#[derive(Clone, Debug, Default)]
pub struct Settings {
    pub affected: Option<bool>,
    pub branches: Option<Vec<String>>,
    pub build_first: Option<bool>,
    pub check_drift: Option<bool>,
    pub github: GithubSettings,
    pub gitlab: GitlabSettings,
    pub node_version: Option<String>,
    pub partitions: Vec<(String, u64)>,
    pub providers: Option<Vec<String>>,
    pub runs_on: Option<String>,
    pub targets: Option<Vec<TargetSetting>>,
    pub timeout_minutes: Option<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct Config {
    pub cache_directory: Option<String>,
    pub default_base: Option<String>,
    pub settings: Settings,
    /// `dependsOn` target names of each `tasks` default (`^` stripped).
    pub task_depends_on: BTreeMap<String, Vec<String>>,
    pub toolchain_pins: BTreeMap<String, String>,
}

/// The config that applies to the workspace at `root`, or `None` when Node must answer. Node reads
/// `vis.config` from the workspace root only, so a config anywhere else on the way up is one this path
/// cannot tell Node's treatment of; a `.json` config is one Node does not load at all.
pub fn read(root: &Path) -> Option<Config> {
    if root.ancestors().skip(1).any(|directory| config_file_in(directory).is_some())
        || root.join("vis.config.json").exists()
    {
        return None;
    }

    let Some(path) = config_file_in(root) else {
        return Some(Config::default());
    };

    parse(&convert_default_export(&path, convert)?)
}

fn convert(expression: &Expression<'_>) -> Option<Yaml> {
    match expression {
        Expression::ObjectExpression(object) => {
            let mut entries: Vec<(String, Yaml)> = Vec::new();

            for (key, value) in object_properties(object)? {
                // A repeated key is a plain override in JavaScript; leave it to Node as `vis_config` does.
                if is_index_like(&key) || entries.iter().any(|(existing, _)| *existing == key) {
                    return None;
                }

                entries.push((key, convert(value)?));
            }

            Some(Yaml::Map(entries))
        }
        Expression::ArrayExpression(array) => array
            .elements
            .iter()
            .map(|element| match element {
                ArrayExpressionElement::SpreadElement(_) | ArrayExpressionElement::Elision(_) => None,
                element => convert(element.as_expression()?),
            })
            .collect::<Option<Vec<_>>>()
            .map(Yaml::List),
        // A lone surrogate has no UTF-8 form: the parser stores it as an escape, and Node prints its own escape for it.
        Expression::StringLiteral(literal) if !literal.lone_surrogates => Some(Yaml::Str(literal.value.to_string())),
        Expression::NumericLiteral(literal) => literal.value.is_finite().then_some(Yaml::Number(literal.value)),
        Expression::BooleanLiteral(literal) => Some(Yaml::Bool(literal.value)),
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::UnaryNegation => match &unary.argument {
            Expression::NumericLiteral(literal) => literal.value.is_finite().then_some(Yaml::Number(-literal.value)),
            _ => None,
        },
        _ => None,
    }
}

fn entries(value: &Yaml) -> Option<&[(String, Yaml)]> {
    match value {
        Yaml::Map(entries) => Some(entries),
        _ => None,
    }
}

fn get<'a>(map: &'a [(String, Yaml)], key: &str) -> Option<&'a Yaml> {
    map.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

/// The map's entries, or `None` when it holds a key outside `allowed`.
fn only<'a>(value: &'a Yaml, allowed: &[&str]) -> Option<&'a [(String, Yaml)]> {
    let map = entries(value)?;

    map.iter().all(|(name, _)| allowed.contains(&name.as_str())).then_some(map)
}

fn string(value: &Yaml) -> Option<String> {
    match value {
        Yaml::Str(text) => Some(text.clone()),
        _ => None,
    }
}

fn boolean(value: &Yaml) -> Option<bool> {
    match value {
        Yaml::Bool(flag) => Some(*flag),
        _ => None,
    }
}

/// A positive integer JavaScript's `Number.isInteger` accepts and prints without an exponent.
fn positive_integer(value: &Yaml) -> Option<u64> {
    match value {
        Yaml::Number(number) if number.fract() == 0.0 && *number >= 1.0 && *number <= 9_007_199_254_740_991.0 => {
            Some(*number as u64)
        }
        _ => None,
    }
}

fn strings(value: &Yaml) -> Option<Vec<String>> {
    match value {
        Yaml::List(items) => items.iter().map(string).collect(),
        _ => None,
    }
}

fn string_map(value: &Yaml) -> Option<Vec<(String, String)>> {
    entries(value)?.iter().map(|(name, value)| Some((name.clone(), string(value)?))).collect()
}

/// An optional field: absent is `Some(None)`, present but unreadable is `None`.
fn field<'a, T>(map: &'a [(String, Yaml)], key: &str, read: impl Fn(&'a Yaml) -> Option<T>) -> Option<Option<T>> {
    match get(map, key) {
        None => Some(None),
        Some(value) => read(value).map(Some),
    }
}

fn parse(config: &Yaml) -> Option<Config> {
    let top = only(config, &ALLOWED_KEYS)?;
    let mut parsed = Config::default();

    if let Some(ci) = get(top, "ci") {
        if let Some(workflow) = get(only(ci, &["workflow"])?, "workflow") {
            parsed.settings = settings(workflow)?;
        }
    }

    parsed.default_base = field(top, "defaultBase", string)?;

    if let Some(task_runner) = get(top, "taskRunner") {
        parsed.cache_directory = field(entries(task_runner)?, "cacheDirectory", string)?;
    }

    if let Some(toolchain) = get(top, "toolchain") {
        if let Some(tools) = get(only(toolchain, &["tools"])?, "tools") {
            parsed.toolchain_pins = string_map(tools)?.into_iter().collect();
        }
    }

    if let Some(tasks) = get(top, "tasks") {
        parsed.task_depends_on = task_defaults(tasks)?;
    }

    Some(parsed)
}

/// A target name a `dependsOn` entry points at, `^` stripped. Only plain names are read: Node rejects
/// file patterns and empty names with an error, and treats `@inherit` as a splice marker.
fn depends_on_name(entry: &str) -> Option<String> {
    let name = entry.strip_prefix('^').unwrap_or(entry);
    let plain = !name.is_empty()
        && !name.starts_with('@')
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'@' | b'-'));

    plain.then(|| name.to_owned())
}

/// `tasks`: the defaults of each target. Only `cache` and `dependsOn` are read; any other key could
/// make the default a target of its own or change what a project's target is.
fn task_defaults(tasks: &Yaml) -> Option<BTreeMap<String, Vec<String>>> {
    let mut result = BTreeMap::new();

    for (name, task) in entries(tasks)? {
        if crate::targets::PROTOTYPE_NAMES.contains(&name.as_str()) || name == "prototype" {
            return None;
        }

        let map = only(task, &["cache", "dependsOn"])?;

        field(map, "cache", boolean)?;

        let mut names = Vec::new();

        if let Some(depends_on) = get(map, "dependsOn") {
            let Yaml::List(items) = depends_on else {
                return None;
            };

            for item in items {
                names.push(match item {
                    Yaml::Str(entry) => depends_on_name(entry)?,
                    object => depends_on_name(&string(get(only(object, &["target"])?, "target")?)?)?,
                });
            }
        }

        result.insert(name.clone(), names);
    }

    Some(result)
}

fn settings(workflow: &Yaml) -> Option<Settings> {
    let map = only(workflow, &WORKFLOW_KEYS)?;
    let mut parsed = Settings {
        affected: field(map, "affected", boolean)?,
        branches: field(map, "branches", strings)?,
        build_first: field(map, "buildFirst", boolean)?,
        check_drift: field(map, "checkDrift", boolean)?,
        node_version: field(map, "nodeVersion", string)?,
        providers: field(map, "providers", strings)?,
        runs_on: field(map, "runsOn", string)?,
        timeout_minutes: field(map, "timeoutMinutes", positive_integer)?,
        ..Settings::default()
    };

    if let Some(partitions) = get(map, "partitions") {
        parsed.partitions = entries(partitions)?
            .iter()
            .map(|(name, shards)| Some((name.clone(), positive_integer(shards)?)))
            .collect::<Option<_>>()?;
    }

    if let Some(targets) = get(map, "targets") {
        let Yaml::List(items) = targets else {
            return None;
        };

        parsed.targets = Some(
            items
                .iter()
                .map(|item| match item {
                    Yaml::Str(name) => Some(TargetSetting { env: None, name: name.clone() }),
                    object => {
                        let target = only(object, &["env", "name"])?;

                        Some(TargetSetting {
                            env: field(target, "env", string_map)?,
                            name: string(get(target, "name")?)?,
                        })
                    }
                })
                .collect::<Option<_>>()?,
        );
    }

    if let Some(github) = get(map, "github") {
        parsed.github = github_settings(github)?;
    }

    if let Some(gitlab) = get(map, "gitlab") {
        parsed.gitlab = gitlab_settings(gitlab)?;
    }

    // A list of providers with a repeat renders that file twice; that is Node's to answer.
    if parsed.providers.as_ref().is_some_and(|providers| {
        providers
            .iter()
            .enumerate()
            .any(|(index, provider)| providers.iter().position(|other| other == provider) != Some(index))
    }) {
        return None;
    }

    Some(parsed)
}

/// A value Node prints as [`super::yaml::entry`] does.
fn printable_value(value: &Yaml) -> Option<&Yaml> {
    printable(value).then_some(value)
}

fn github_settings(github: &Yaml) -> Option<GithubSettings> {
    let map = only(github, &["env", "permissions", "services", "steps"])?;
    let mut parsed = GithubSettings::default();

    if let Some(env) = get(map, "env") {
        string_map(env)?;
        parsed.env = Some(printable_value(env)?.clone());
    }

    if let Some(permissions) = get(map, "permissions") {
        parsed.permissions = string_map(permissions)?;
    }

    if let Some(services) = get(map, "services") {
        entries(services)?;
        parsed.services = Some(printable_value(services)?.clone());
    }

    if let Some(steps) = get(map, "steps") {
        let positions = only(steps, &["after", "afterSetup"])?;

        parsed.after = field(positions, "after", github_steps)?.unwrap_or_default();
        parsed.after_setup = field(positions, "afterSetup", github_steps)?.unwrap_or_default();
    }

    Some(parsed)
}

fn github_steps(steps: &Yaml) -> Option<Vec<RunStep>> {
    let Yaml::List(items) = steps else {
        return None;
    };

    items.iter().map(github_step).collect()
}

fn github_step(step: &Yaml) -> Option<RunStep> {
    let map = only(
        step,
        &[
            "comment",
            "continue-on-error",
            "env",
            "if",
            "name",
            "run",
            "shell",
            "timeout-minutes",
            "uses",
            "with",
            "working-directory",
        ],
    )?;
    let mut parsed = RunStep {
        comment: field(map, "comment", string)?,
        continue_on_error: field(map, "continue-on-error", boolean)?,
        if_: field(map, "if", string)?,
        name: string(get(map, "name")?)?,
        run: field(map, "run", string)?,
        shell: field(map, "shell", string)?,
        uses: field(map, "uses", string)?.map(Uses::Raw),
        working_directory: field(map, "working-directory", string)?,
        ..RunStep::default()
    };

    if let Some(env) = get(map, "env") {
        string_map(env)?;
        parsed.env = Some(env.clone());
    }

    if let Some(inputs) = get(map, "with") {
        if !entries(inputs)?.iter().all(|(_, value)| matches!(value, Yaml::Bool(_) | Yaml::Number(_) | Yaml::Str(_))) {
            return None;
        }

        parsed.with = Some(printable_value(inputs)?.clone());
    }

    // `timeout-minutes` is printed with JavaScript's number formatting, which `yaml` reproduces.
    parsed.timeout_minutes = match get(map, "timeout-minutes") {
        None => None,
        Some(Yaml::Number(minutes)) if minutes.is_finite() => Some(*minutes),
        Some(_) => return None,
    };

    Some(parsed)
}

fn gitlab_settings(gitlab: &Yaml) -> Option<GitlabSettings> {
    let map = only(gitlab, &["afterScript", "beforeScript", "image", "services", "stage", "tags", "variables"])?;
    let mut parsed = GitlabSettings {
        before_script: field(map, "beforeScript", strings)?.unwrap_or_default(),
        image: field(map, "image", string)?,
        stage: field(map, "stage", string)?,
        variables: field(map, "variables", string_map)?.unwrap_or_default(),
        ..GitlabSettings::default()
    };

    if let Some(after_script) = get(map, "afterScript") {
        strings(after_script)?;
        parsed.after_script = Some(after_script.clone());
    }

    if let Some(tags) = get(map, "tags") {
        strings(tags)?;
        parsed.tags = Some(tags.clone());
    }

    if let Some(services) = get(map, "services") {
        let Yaml::List(items) = services else {
            return None;
        };

        // A service is an image name or a map.
        if !items.iter().all(|item| matches!(item, Yaml::Str(_) | Yaml::Map(_))) {
            return None;
        }

        parsed.services = Some(printable_value(services)?.clone());
    }

    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn read_source(name: &str, file: &str, source: &str) -> Option<Config> {
        let dir = std::env::temp_dir().join(format!("vis-ci-config-{}-{name}", std::process::id()));

        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(file), source).unwrap();

        let config = read(&dir);

        let _ = fs::remove_dir_all(&dir);

        config
    }

    #[test]
    fn no_config_is_the_default() {
        let dir = std::env::temp_dir().join(format!("vis-ci-config-{}-none", std::process::id()));

        fs::create_dir_all(&dir).unwrap();

        let config = read(&dir).expect("default");

        assert!(config.settings.targets.is_none());
        assert!(config.task_depends_on.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_the_source_order_of_maps() {
        let config = read_source(
            "order",
            "vis.config.ts",
            "export default { ci: { workflow: { github: { env: { ZED: 'z', ALPHA: 'a', MID: 'm' }, permissions: { 'id-token': 'write', contents: 'write' } } } } };\n",
        )
        .expect("literal");
        let Some(Yaml::Map(env)) = config.settings.github.env else {
            panic!("env");
        };

        assert_eq!(env.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["ZED", "ALPHA", "MID"]);
        assert_eq!(config.settings.github.permissions[0].0, "id-token");
    }

    #[test]
    fn reads_the_settings_and_the_task_defaults() {
        let config = read_source(
            "settings",
            "vis.config.ts",
            "export default { defaultBase: 'trunk', taskRunner: { cacheDirectory: '.cache/vis' }, toolchain: { tools: { node: '24' } }, tasks: { build: { dependsOn: ['^build', { target: 'codegen' }], cache: true } }, ci: { workflow: { targets: ['build', { name: 'test', env: { A: '1' } }], partitions: { test: 3 }, timeoutMinutes: 30, providers: ['github'] } } };\n",
        )
        .expect("literal");

        assert_eq!(config.default_base.as_deref(), Some("trunk"));
        assert_eq!(config.cache_directory.as_deref(), Some(".cache/vis"));
        assert_eq!(config.toolchain_pins.get("node").map(String::as_str), Some("24"));
        assert_eq!(config.task_depends_on["build"], ["build", "codegen"]);
        assert_eq!(config.settings.partitions, [("test".to_owned(), 3)]);
        assert_eq!(config.settings.timeout_minutes, Some(30));
        assert_eq!(config.settings.targets.as_ref().map(Vec::len), Some(2));
    }

    #[test]
    fn leaves_what_it_cannot_reproduce_to_node() {
        for (name, file, source) in [
            ("json", "vis.config.json", "{}"),
            ("dynamic", "vis.config.ts", "export default { ci: { workflow: { runsOn: process.env.RUNNER } } };\n"),
            ("other-key", "vis.config.ts", "export default { fileGroups: {} };\n"),
            ("unknown-workflow-key", "vis.config.ts", "export default { ci: { workflow: { cache: true } } };\n"),
            ("wrong-type", "vis.config.ts", "export default { ci: { workflow: { affected: 'yes' } } };\n"),
            ("null", "vis.config.ts", "export default { ci: { workflow: { runsOn: null } } };\n"),
            ("index-key", "vis.config.ts", "export default { ci: { workflow: { github: { env: { '1': 'a' } } } } };\n"),
            ("lone-surrogate", "vis.config.ts", "export default { ci: { workflow: { runsOn: '\\ud800' } } };\n"),
            (
                "lone-surrogate-key",
                "vis.config.ts",
                "export default { ci: { workflow: { github: { env: { '\\udc00': 'x' } } } } };\n",
            ),
            ("duplicate", "vis.config.ts", "export default { ci: { workflow: { runsOn: 'a', runsOn: 'b' } } };\n"),
            ("fraction", "vis.config.ts", "export default { ci: { workflow: { timeoutMinutes: 1.5 } } };\n"),
            ("task-command", "vis.config.ts", "export default { tasks: { check: { command: 'x' } } };\n"),
            ("task-inherit", "vis.config.ts", "export default { tasks: { build: { dependsOn: ['@inherit'] } } };\n"),
            ("task-pattern", "vis.config.ts", "export default { tasks: { build: { dependsOn: ['src/*.ts'] } } };\n"),
            (
                "both-run-and-uses-shape",
                "vis.config.ts",
                "export default { ci: { workflow: { github: { steps: { before: [] } } } } };\n",
            ),
        ] {
            assert!(read_source(name, file, source).is_none(), "{name}");
        }
    }
}
