//! `vis security list --json` — the native port of `src/commands/security/list.ts` for its JSON form: the
//! build-script triage of the installed packages against `security.policies.installScripts.allow`, the bin
//! name conflicts, and the drift between `vis.config` and the package manager's own settings.
//!
//! The command only reads, and prints one JSON document. The binary answers only the context it can prove, like
//! `clean` and `sort-package-json`: CI, no terminal, a pnpm workspace whose root is the working directory, and
//! either no `vis.config.*` or one that is a plain literal in that directory. The `security` block is read as
//! data (see [`config`]); everything it cannot read exactly goes to Node before anything is printed:
//!
//! - the text form, every other flag, `--cwd` and `--config`, and every other `security` subcommand (`sync`,
//!   `run` and `tripwire` write files, the rest use the network);
//! - a config Node must evaluate, one that sets a key only Node handles (`extends`, `runtime`, ...), and an
//!   `allow` or `allowBins` map whose shape or key order JavaScript would treat differently;
//! - a `package.json` under `node_modules` that is not strict JSON, a tree too deep to walk, and a `localeCompare`
//!   order of two or more bin conflicts this crate does not reproduce (see [`scan`]);
//! - a `pnpm-workspace.yaml` outside the grammar of [`yaml`], when the config makes the drift check read it.

mod scan;
mod yaml;

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::exit;

use oxc_ast::ast::Expression;
use serde_json::Value;
use vis_core::detect::detect_package_manager;

use crate::js::{is_index_like, is_truthy};
use crate::node_context::{any_ancestor_has, ci_root_context, DENO_FILES};
use crate::output::write_stdout;
use crate::sort_package_json::json::{stringify, Json};
use crate::vis_config::{self, ConfigState};

use scan::{status, Found, Status};

/// What the report reads from `vis.config`: the `security` settings `list.ts` and the drift check use.
#[derive(Default)]
struct Config {
    /// `installScripts.allow` as `Object.entries` lists it, each value reduced to its truthiness.
    allow: Vec<(String, bool)>,
    /// The `allowBins` keys whose value is `true`.
    allow_bins: HashSet<String>,
    pin_versions: bool,
    drift: DriftInput,
}

/// The settings `checkPmNativeConfigDrift` compares with the package manager's.
#[derive(Default)]
struct DriftInput {
    /// The truthy `installScripts.allow` keys, when `allow` is an object.
    allow: Option<Vec<String>>,
    minutes: Option<i64>,
    exclude: Option<Vec<String>>,
}

/// Answer `vis security list --json` natively, or delegate to Node. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(output) = args_are_native(args).then(report).flatten() else {
        crate::delegate(raw_args);
    };

    write_stdout("security", "the output", &output);

    exit(0)
}

fn args_are_native(args: &[String]) -> bool {
    args == ["security", "list", "--json"]
}

/// The JSON text of the whole run, or `None` when something on the way is outside what this module reproduces.
fn report() -> Option<String> {
    let cwd = context()?;
    let detected = detect_package_manager(cwd.to_str()?, None);

    if detected.name != "pnpm" {
        return None;
    }

    let config = config(&cwd)?;

    // Read before the walk of `node_modules`: a yaml outside the supported grammar is a hand-off, and the
    // walk (the pnpm store included) would only be repeated by Node.
    let snapshot = snapshot(&config.drift, &cwd)?;
    let found: Found = scan::walk(&cwd)?;
    let triage: Status = status(&found.packages, &config.allow, config.pin_versions);
    let conflicts = found.conflicts(&config.allow_bins)?;
    let drift = drift(&config.drift, &snapshot);

    let text = |value: &str| Json::Str(value.to_owned());
    let strings = |items: &[String]| Json::Array(items.iter().map(|item| text(item)).collect());
    let packages = |items: &[scan::BuildEntry]| {
        Json::Array(
            items
                .iter()
                .map(|entry| {
                    let mut fields =
                        vec![("hooks".to_owned(), strings(&entry.hooks)), ("name".to_owned(), text(&entry.name))];

                    if let Some(version) = &entry.version {
                        fields.push(("version".to_owned(), text(version)));
                    }

                    Json::Object(fields)
                })
                .collect(),
        )
    };

    let report = Json::Object(vec![
        (
            "binConflicts".to_owned(),
            Json::Array(
                conflicts
                    .iter()
                    .map(|conflict| {
                        Json::Object(vec![
                            ("bin".to_owned(), text(&conflict.bin)),
                            (
                                "packages".to_owned(),
                                Json::Array(
                                    conflict
                                        .packages
                                        .iter()
                                        .map(|(name, path)| {
                                            Json::Object(vec![
                                                ("name".to_owned(), text(name)),
                                                ("relativePath".to_owned(), text(path)),
                                            ])
                                        })
                                        .collect(),
                                ),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("drift".to_owned(), drift),
        ("excess".to_owned(), strings(&triage.excess)),
        ("installed".to_owned(), packages(&triage.installed)),
        ("packageManager".to_owned(), text("pnpm")),
        ("pinVersions".to_owned(), Json::Bool(config.pin_versions)),
        ("unapproved".to_owned(), packages(&triage.unapproved)),
        (
            "versionDrift".to_owned(),
            Json::Array(
                triage
                    .version_drift
                    .iter()
                    .map(|(from, to)| Json::Object(vec![("from".to_owned(), text(from)), ("to".to_owned(), text(to))]))
                    .collect(),
            ),
        ),
    ]);

    Some(format!("{}\n", stringify(&report, "  ")))
}

/// The working directory when Node would reach the same answer from the workspace root: a unix CI run with no
/// terminal, the root of a pnpm workspace, and none of the variables that change what Node prints.
fn context() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;

    (ci_root_context(&cwd) && !any_ancestor_has(&cwd, &DENO_FILES)).then_some(cwd)
}

/// The keys `object` holds, in source order, when it is a literal object.
fn keys(expression: &Expression<'_>) -> Option<Vec<String>> {
    let Expression::ObjectExpression(object) = expression else {
        return None;
    };

    Some(vis_config::object_properties(object)?.into_iter().map(|(key, _)| key).collect())
}

/// The value of `key` in a literal object expression.
fn property<'a, 'b>(expression: &'b Expression<'a>, key: &str) -> Option<&'b Expression<'a>> {
    let Expression::ObjectExpression(object) = expression else {
        return None;
    };

    vis_config::object_properties(object)?.into_iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

/// The `security` settings of the config that applies to `cwd`, or `None` to delegate.
fn config(cwd: &Path) -> Option<Config> {
    let state = vis_config::read(cwd);

    let ConfigState::Static(root) = &state else {
        return matches!(state, ConfigState::Absent).then(Config::default);
    };

    // Node loads the config of the workspace root, in a script form; a `.json` file or a config in a parent
    // directory is a case this module leaves to it.
    let file = vis_config::config_file_in(cwd)?;

    if file.extension().is_some_and(|extension| extension == "json") {
        return None;
    }

    // `security` is the one key Node-only for the package-manager commands that this command reads itself.
    let mut rest = root.clone();

    rest.as_object_mut()?.remove("security");

    if vis_config::requires_node(&ConfigState::Static(rest)) {
        return None;
    }

    let Some(security) = root.get("security") else {
        return Some(Config::default());
    };
    let security = security.as_object()?;
    let mut config =
        Config { pin_versions: security.get("pinVersions") == Some(&Value::Bool(true)), ..Config::default() };

    // `allowBins[bin] === true`. A string, number, boolean or `null` never yields `true` for any key, so it
    // blesses nothing; an array does (`[true]["0"] === true`), and Node's lookup is not reproduced for it.
    match security.get("allowBins") {
        Some(Value::Array(_)) => return None,
        Some(Value::Object(allow_bins)) => {
            if allow_bins.contains_key("__proto__") {
                return None;
            }

            config.allow_bins = allow_bins
                .iter()
                .filter(|(_, value)| **value == Value::Bool(true))
                .map(|(key, _)| key.clone())
                .collect();
        }
        _ => {}
    }

    let policies = match security.get("policies") {
        None | Some(Value::Null) => return Some(config),
        Some(Value::Object(policies)) => policies,
        Some(_) => return None,
    };

    if let Some(first_seen) = policies.get("firstSeen") {
        match first_seen {
            Value::Null => {}
            Value::Object(first_seen) => {
                config.drift.minutes = match first_seen.get("minutes") {
                    None => None,
                    Some(Value::Number(number)) => Some(
                        number
                            .as_f64()
                            .filter(|number| number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0)?
                            as i64,
                    ),
                    Some(_) => return None,
                };
                config.drift.exclude = match first_seen.get("exclude") {
                    None | Some(Value::Null | Value::Bool(false)) => None,
                    Some(Value::Array(items)) => {
                        Some(items.iter().map(|item| item.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()?)
                    }
                    Some(_) => return None,
                };
            }
            _ => return None,
        }
    }

    let allow = match policies.get("installScripts") {
        None | Some(Value::Null) => return Some(config),
        Some(Value::Object(install_scripts)) => match install_scripts.get("allow") {
            None | Some(Value::Null) => return Some(config),
            Some(Value::Object(allow)) => allow,
            Some(_) => return None,
        },
        Some(_) => return None,
    };

    // The order `Object.entries` lists the keys in is the order of the source, which `Value` does not keep.
    let ordered = vis_config::convert_default_export(&file, |root| {
        let allow = property(property(property(property(root, "security")?, "policies")?, "installScripts")?, "allow")?;

        keys(allow)
    })?;

    if ordered.len() != allow.len() || ordered.iter().any(|key| !allow.contains_key(key) || is_index_like(key)) {
        return None;
    }

    config.allow = ordered.iter().map(|key| (key.clone(), is_truthy(&allow[key]))).collect();
    config.drift.allow =
        Some(config.allow.iter().filter(|(_, allowed)| *allowed).map(|(key, _)| key.clone()).collect());

    Some(config)
}

/// What `pnpm-workspace.yaml` holds for the drift check, or `None` when it is outside the grammar of [`yaml`].
/// The file is read only when the config has a setting to compare with it.
fn snapshot(input: &DriftInput, cwd: &Path) -> Option<yaml::Snapshot> {
    if input.allow.is_none() && input.minutes.is_none() && input.exclude.is_none() {
        return Some(yaml::Snapshot::default());
    }

    match fs::read(cwd.join("pnpm-workspace.yaml")) {
        Ok(bytes) => yaml::snapshot(std::str::from_utf8(&bytes).ok()?),
        Err(_) => Some(yaml::Snapshot::default()),
    }
}

/// `checkPmNativeConfigDrift(config, "pnpm", cwd)` as the JSON object `list.ts` prints, given the yaml's
/// [`snapshot`].
fn drift(input: &DriftInput, snapshot: &yaml::Snapshot) -> Json {
    let text = |value: &str| Json::Str(value.to_owned());
    let strings = |items: &[String]| Json::Array(items.iter().map(|item| text(item)).collect());
    let difference = |ours: &[String], theirs: &[String]| -> Vec<String> {
        ours.iter().filter(|item| !theirs.contains(item)).cloned().collect()
    };
    let sets = |vis: &[String], pm: &[String]| -> Option<Json> {
        let (only_in_vis, only_in_pm) = (difference(vis, pm), difference(pm, vis));

        (!only_in_vis.is_empty() || !only_in_pm.is_empty()).then(|| {
            Json::Object(vec![
                ("onlyInPm".to_owned(), strings(&only_in_pm)),
                ("onlyInVis".to_owned(), strings(&only_in_vis)),
            ])
        })
    };

    let mut fields = Vec::new();

    if let Some(allow) = &input.allow {
        if let Some(report) = sets(allow, snapshot.allow_builds.as_deref().unwrap_or_default()) {
            fields.push(("allowBuilds".to_owned(), report));
        }
    }

    if let Some(minutes) = input.minutes {
        if snapshot.min_release_age != Some(minutes) {
            let mut report = Vec::new();

            if let Some(pm) = snapshot.min_release_age {
                report.push(("pm".to_owned(), Json::Int(pm)));
            }

            report.push(("vis".to_owned(), Json::Int(minutes)));
            fields.push(("minReleaseAge".to_owned(), Json::Object(report)));
        }
    }

    if let Some(exclude) = &input.exclude {
        let mut vis = Vec::new();

        for item in exclude {
            if !vis.contains(item) {
                vis.push(item.clone());
            }
        }

        if let Some(report) = sets(&vis, snapshot.min_release_age_excludes.as_deref().unwrap_or_default()) {
            fields.push(("minReleaseAgeExcludes".to_owned(), report));
        }
    }

    let mut report =
        vec![("hasDrift".to_owned(), Json::Bool(!fields.is_empty())), ("packageManager".to_owned(), text("pnpm"))];

    report.extend(fields);

    Json::Object(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_json_form_of_the_list_is_native() {
        let args = |words: &[&str]| words.iter().map(|word| (*word).to_owned()).collect::<Vec<_>>();

        assert!(args_are_native(&args(&["security", "list", "--json"])));
        assert!(!args_are_native(&args(&["security", "list"])));
        assert!(!args_are_native(&args(&["security", "list", "--json", "--cwd", "x"])));
        assert!(!args_are_native(&args(&["security", "sync"])));
    }

    #[test]
    fn drift_is_reported_in_node_s_key_order() {
        let dir = std::env::temp_dir().join(format!("vis-security-drift-{}", std::process::id()));

        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("pnpm-workspace.yaml"),
            "onlyBuiltDependencies:\n  - b\n  - c\nminimumReleaseAge: 10\nminimumReleaseAgeExclude:\n  - x\n",
        )
        .unwrap();

        let input = DriftInput {
            allow: Some(vec!["a".to_owned(), "b".to_owned()]),
            minutes: Some(20),
            exclude: Some(vec!["y".to_owned(), "y".to_owned()]),
        };
        let text = stringify(&drift(&input, &snapshot(&input, &dir).unwrap()), "");
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(
            text,
            r#"{"hasDrift":true,"packageManager":"pnpm","allowBuilds":{"onlyInPm":["c"],"onlyInVis":["a"]},"minReleaseAge":{"pm":10,"vis":20},"minReleaseAgeExcludes":{"onlyInPm":["x"],"onlyInVis":["y"]}}"#
        );
    }

    #[test]
    fn a_yaml_outside_the_grammar_is_declined_only_when_the_config_compares_with_it() {
        let dir = std::env::temp_dir().join(format!("vis-security-grammar-{}", std::process::id()));

        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("pnpm-workspace.yaml"), "minimumReleaseAge: 10 # minutes\n").unwrap();

        let compares = DriftInput { minutes: Some(10), ..DriftInput::default() };
        let declined = snapshot(&compares, &dir).is_none();
        let ignored = snapshot(&DriftInput::default(), &dir).is_some();
        let _ = fs::remove_dir_all(&dir);

        assert!(declined, "an inline comment is outside the grammar");
        assert!(ignored, "the file is not read when nothing compares with it");
    }

    #[test]
    fn no_setting_means_no_drift() {
        let dir = std::env::temp_dir().join(format!("vis-security-nodrift-{}", std::process::id()));

        fs::create_dir_all(&dir).unwrap();

        let text = stringify(&drift(&DriftInput::default(), &snapshot(&DriftInput::default(), &dir).unwrap()), "");
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(text, r#"{"hasDrift":false,"packageManager":"pnpm"}"#);
    }
}
