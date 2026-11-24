//! Native `vis sync ci-workflow`: writes (or with `--check` verifies) `.github/workflows/vis-ci.yml` and
//! `.gitlab/vis-ci.gitlab-ci.yml` for a JS-only pnpm workspace.
//!
//! Mirrors `runCiWorkflow` in `packages/tooling/vis/src/commands/sync/handler.ts` and the generator in
//! `src/util/ci-workflow/`. The answer is byte for byte Node's, or the run goes to Node:
//!
//! - the config must be a literal at the workspace root with only keys this path reads (see [`config`]);
//! - the providers must come from `--provider`, `ci.workflow.providers` or the CI files already in the
//!   repository; the git remote lookup, the prompt and every error message are Node's;
//! - the workspace is the one `targets` reads natively (script targets, no inference, no non-JS projects);
//! - every input Node rejects with an error is rejected by returning `None`, so Node prints its message;
//! - `--check` is answered when each file either matches the rendered text byte for byte or is missing.
//!   A file that differs is compared by Node, which parses both texts as YAML and so can call a
//!   reformatted file up to date.
//!
//! `--deps-only` / `--skip-deps` are flags of the generated commands, which `vis run` and `vis ci`
//! (not native yet) interpret; nothing here runs them.

mod config;
mod ecosystems;
mod github;
mod gitlab;
mod plan;
mod tables;
mod yaml;

use std::collections::BTreeSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::Path;

use crate::advisories::{
    any_ancestor_has, in_ci, monorepo_root, native_root_is_cwd, output_settings_are_default, DENO_FILES,
};
use crate::targets::{self, Targets};

use plan::{build_plan, Provider, Workspace};
use tables::Tables;

/// What the command printed, line by line in the order Node logs it (a terminal or a merged redirect shows
/// that order), and how it ended.
struct Outcome {
    code: i32,
    lines: Vec<Line>,
}

struct Line {
    stderr: bool,
    text: String,
}

impl Outcome {
    fn out(&mut self, text: String) {
        self.lines.push(Line { stderr: false, text });
    }

    fn err(&mut self, text: String) {
        self.lines.push(Line { stderr: true, text });
    }
}

#[derive(Debug, PartialEq)]
struct Options {
    check: bool,
    /// `--provider` values, split on commas and deduplicated, in order.
    providers: Option<Vec<Provider>>,
}

/// Parses `sync ci-workflow` arguments the way cerebro does for this command. `args[0]` is `sync`.
/// Returns `None` for any shape this module does not answer.
fn parse(args: &[String]) -> Option<Options> {
    if args.get(1).map(String::as_str) != Some("ci-workflow") {
        return None;
    }

    let mut check = false;
    let mut values: Option<Vec<Provider>> = None;
    let mut tokens = args.iter().skip(2);

    while let Some(token) = tokens.next() {
        let value = match token.as_str() {
            "--check" if !check => {
                check = true;

                continue;
            }
            "--provider" => tokens.next()?.as_str(),
            other => other.strip_prefix("--provider=")?,
        };

        if value.starts_with('-') {
            return None;
        }

        for piece in value.split(',') {
            let name = piece.trim();

            if name.is_empty() {
                continue;
            }

            let provider = Provider::parse(name)?;
            let list = values.get_or_insert_with(Vec::new);

            if !list.contains(&provider) {
                list.push(provider);
            }
        }

        // `--provider=` with nothing in it leaves a list Node reports as "No CI provider selected".
        values.as_ref()?;
    }

    Some(Options { check, providers: values })
}

/// Whether the context is one where Node prints nothing beyond the plain log lines: the working
/// directory is the workspace root, CI, no terminal, a colour environment the binary can decide (the lines carry
/// no colour codes in any of them), and no logger or runtime setting that changes the lines. Returns the root.
fn native_root(args: &[String]) -> Option<std::path::PathBuf> {
    if cfg!(windows) {
        return None;
    }

    let cwd = env::current_dir().ok()?;
    let env_root = env::var_os("VIS_MONOREPO_ROOT");

    if !native_root_is_cwd(&cwd, env_root.as_deref()) || monorepo_root(&cwd).as_deref() != Some(cwd.as_path()) {
        return None;
    }

    if crate::term::piped_colour_level(args).is_none()
        || !in_ci()
        || io::stdout().is_terminal()
        || io::stderr().is_terminal()
        || any_ancestor_has(&cwd, &DENO_FILES)
    {
        return None;
    }

    // pail's level comes from NODE_ENV, `DEBUG` and `PAIL_LOG_LEVEL`, and cerebro's output level from `CEREBRO_*`.
    if !output_settings_are_default() {
        return None;
    }

    Some(cwd)
}

/// The package manager `detectPackageManager` names for `root`: the first lockfile found in its table order.
fn package_manager(root: &Path) -> Option<&'static str> {
    const LOCKFILES: [(&str, &[&str]); 5] = [
        ("aube", &["aube-lock.yaml"]),
        ("bun", &["bun.lock", "bun.lockb"]),
        ("npm", &["npm-shrinkwrap.json", "package-lock.json"]),
        ("pnpm", &["pnpm-lock.yaml"]),
        ("yarn", &["yarn.lock"]),
    ];

    LOCKFILES.iter().find(|(_, files)| files.iter().any(|file| root.join(file).exists())).map(|(manager, _)| *manager)
}

/// The workspace root plus every project root, each with the names of the files directly in it,
/// sorted by path. A directory that cannot be read has no files, as in Node.
fn directories(root: &Path, project_roots: &[String]) -> Option<Vec<(String, Vec<String>)>> {
    let mut paths: BTreeSet<String> = BTreeSet::new();

    paths.insert(".".to_owned());
    paths.extend(project_roots.iter().cloned());

    paths
        .into_iter()
        .map(|path| {
            let mut files = Vec::new();

            if let Ok(listing) = fs::read_dir(root.join(&path)) {
                for entry in listing.flatten() {
                    files.push(entry.file_name().to_str()?.to_owned());
                }
            }

            Some((path, files))
        })
        .collect()
}

/// Which providers to generate for, and why: `--provider`, then `ci.workflow.providers`, then the CI
/// files already in the repository. `None` when none of them answers (the remote lookup, the prompt and
/// the error are Node's).
fn resolve_providers(
    root: &Path,
    flag: Option<Vec<Provider>>,
    configured: Option<&[String]>,
) -> Option<(Vec<Provider>, String)> {
    let configured: Option<Vec<Provider>> = match configured {
        None => None,
        Some(names) => Some(names.iter().map(|name| Provider::parse(name)).collect::<Option<_>>()?),
    };

    if let Some(providers) = flag {
        return Some((providers, "--provider".to_owned()));
    }

    if let Some(providers) = configured {
        return (!providers.is_empty()).then(|| (providers, "ci.workflow.providers".to_owned()));
    }

    let mut found: Vec<(&str, Provider)> = Vec::new();

    if root.join(".github/workflows").exists() {
        found.push((".github/workflows", Provider::Github));
    }

    if root.join(".gitlab-ci.yml").exists() || root.join(".gitlab/vis-ci.gitlab-ci.yml").exists() {
        found.push((".gitlab-ci.yml", Provider::Gitlab));
    }

    if found.is_empty() {
        return None;
    }

    let files: Vec<&str> = found.iter().map(|(file, _)| *file).collect();

    Some((found.iter().map(|(_, provider)| *provider).collect(), format!("found {}", files.join(" and "))))
}

fn workspace(root: &Path, config: &config::Config) -> Option<Workspace> {
    let Targets::Native(projects) = targets::script_targets_vetted(root) else {
        return None;
    };

    // The root project, and names Node would sort or quote differently, are Node's.
    if projects.iter().any(|project| {
        project.directory == "." || !project.directory.is_ascii() || project.targets.keys().any(|name| !name.is_ascii())
    }) {
        return None;
    }

    let roots: Vec<String> = projects.iter().map(|project| project.directory.clone()).collect();
    let listing = directories(root, &roots)?;
    let ecosystems = ecosystems::detect(&listing);

    // The manifests of the other ecosystems make their directory a project that `targets` hands to Node,
    // so only these three can be found here. A non-ASCII manifest name sorts differently in JavaScript.
    if ecosystems.iter().any(|detected| {
        !matches!(
            detected.name,
            ecosystems::Ecosystem::Dotnet | ecosystems::Ecosystem::Python | ecosystems::Ecosystem::Ruby
        ) || detected.manifests.iter().any(|manifest| !manifest.is_ascii())
    }) {
        return None;
    }

    let root_files = listing
        .iter()
        .find(|(path, _)| path == ".")
        .map(|(_, files)| files.iter().cloned().collect())
        .unwrap_or_default();

    Some(Workspace {
        cache_directory: config.cache_directory.clone(),
        default_base: config.default_base.clone(),
        ecosystems,
        package_manager: package_manager(root)?.to_owned(),
        root_files,
        target_names: projects.iter().flat_map(|project| project.targets.keys().cloned()).collect(),
        task_depends_on: config.task_depends_on.clone(),
        toolchain_pins: config.toolchain_pins.clone(),
    })
}

fn answer(args: &[String]) -> Option<Outcome> {
    let options = parse(args)?;
    let root = native_root(args)?;
    let config = config::read(&root)?;
    let (providers, reason) = resolve_providers(&root, options.providers, config.settings.providers.as_deref())?;
    let (build_first_ordered, plan) = build_plan(workspace(&root, &config)?, &providers, &config.settings)?;
    let tables = Tables::load();
    let files: Vec<(&str, String)> = plan
        .providers
        .iter()
        .map(|provider| match provider {
            Provider::Github => Some((".github/workflows/vis-ci.yml", github::render(&plan, &tables)?)),
            Provider::Gitlab => Some((gitlab::GITLAB_CI_WORKFLOW_PATH, gitlab::render(&plan, &tables)?)),
        })
        .collect::<Option<_>>()?;

    let mut outcome = Outcome { code: 0, lines: Vec::new() };
    let provider_names: Vec<&str> = providers.iter().map(|provider| provider.name()).collect();

    outcome.out(format!("▸ CI providers: {} ({reason})\n", provider_names.join(", ")));

    if !plan.ecosystems.is_empty() {
        let names: Vec<&str> = plan.ecosystems.iter().map(|detected| detected.name.name()).collect();

        outcome.out(format!("▸ Toolchains: {}\n", names.join(", ")));
    }

    let missing = if providers.contains(&Provider::Gitlab) { gitlab::missing_toolchains(&plan) } else { Vec::new() };

    if !missing.is_empty() {
        outcome.err(format!(
            "GitLab jobs run in a node image without {}. Pin go, python, ruby or rust in toolchain.tools so vis installs them, or give .vis-ci-base an image that has them.\n",
            missing.join(", ")
        ));
    }

    if !build_first_ordered.is_empty() {
        outcome.out(format!(
            "▸ Running build before {} (ci.workflow.buildFirst; set it to false if dependsOn already says what needs build).\n",
            build_first_ordered.join(", ")
        ));
    }

    let mut stale = false;

    for (path, content) in &files {
        let target = root.join(path);

        if options.check {
            match fs::read(&target) {
                Ok(existing) if existing == content.as_bytes() => {}
                Ok(_) => return None,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    outcome.err(format!("{path} is out of date. Run `vis sync ci-workflow` to update it.\n"));
                    stale = true;
                }
                Err(_) => return None,
            }

            continue;
        }

        fs::create_dir_all(target.parent()?).ok()?;
        fs::write(&target, content).ok()?;
        outcome.out(format!("Wrote {path}\n"));
    }

    if stale {
        outcome.code = 1;

        return Some(outcome);
    }

    let groups: Vec<String> = plan
        .layers
        .iter()
        .map(|layer| layer.iter().map(|target| target.name.as_str()).collect::<Vec<_>>().join(" + "))
        .collect();

    outcome.out(format!(
        "CI workflow {}: {}\n",
        if options.check { "is up to date" } else { "generated" },
        groups.join(" → ")
    ));

    Some(outcome)
}

/// Answers `vis sync ci-workflow` natively or hands the whole invocation to Node. `args` is the lossy
/// view used for parsing; `raw_args` is the untouched argv handed to Node. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(outcome) = answer(args) else {
        crate::delegate(raw_args);
    };

    let written = outcome.lines.iter().try_for_each(|line| {
        if line.stderr {
            io::stderr().write_all(line.text.as_bytes())
        } else {
            io::stdout().write_all(line.text.as_bytes()).and_then(|()| io::stdout().flush())
        }
    });

    std::process::exit(if written.is_err() { 1 } else { outcome.code });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn parses_the_plain_shapes() {
        assert_eq!(parse(&argv(&["sync", "ci-workflow"])), Some(Options { check: false, providers: None }));
        assert_eq!(parse(&argv(&["sync", "ci-workflow", "--check"])), Some(Options { check: true, providers: None }));
        assert_eq!(
            parse(&argv(&["sync", "ci-workflow", "--provider=gitlab, github,gitlab", "--check"])),
            Some(Options { check: true, providers: Some(vec![Provider::Gitlab, Provider::Github]) })
        );
        assert_eq!(
            parse(&argv(&["sync", "ci-workflow", "--provider", "github", "--provider=gitlab"])),
            Some(Options { check: false, providers: Some(vec![Provider::Github, Provider::Gitlab]) })
        );
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["sync", "codeowners"][..],
            &["sync"],
            &["sync", "--check", "ci-workflow"],
            &["sync", "ci-workflow", "--check", "--check"],
            &["sync", "ci-workflow", "--check=false"],
            &["sync", "ci-workflow", "--provider"],
            &["sync", "ci-workflow", "--provider="],
            &["sync", "ci-workflow", "--provider=,"],
            &["sync", "ci-workflow", "--provider=circle"],
            &["sync", "ci-workflow", "--provider", "--check"],
            &["sync", "ci-workflow", "--format=json"],
            &["sync", "ci-workflow", "extra"],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }
}
