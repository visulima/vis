//! GitHub Actions renderer for `vis sync ci-workflow` (`src/util/ci-workflow/github.ts`).
//!
//! Steps run concurrently inside one job via `parallel:`, but they are written into the workflow up
//! front: install once, build the dependencies of every target once (`--deps-only`), then run each
//! target group as a `parallel:` group (`--skip-deps`).

use super::ecosystems::{Detected, Ecosystem};
use super::plan::{vis_dependencies_command, vis_drift_check_command, vis_target_command, Plan, GENERATED_NOTE};
use super::tables::{Action, Tables};
use super::yaml::{self, Yaml};

/// GitHub runs at most 10 background steps of a job at once; more would queue.
const MAX_PARALLEL_STEPS: usize = 10;

#[derive(Clone, Debug, PartialEq)]
pub enum Uses {
    Pinned(Action),
    Raw(String),
}

/// A generated step or one from `ci.workflow.github.steps`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunStep {
    pub comment: Option<String>,
    pub continue_on_error: Option<bool>,
    pub env: Option<Yaml>,
    pub if_: Option<String>,
    pub name: String,
    pub run: Option<String>,
    pub shell: Option<String>,
    pub timeout_minutes: Option<f64>,
    pub uses: Option<Uses>,
    pub with: Option<Yaml>,
    pub working_directory: Option<String>,
}

enum Step {
    Parallel(Vec<RunStep>),
    Run(Box<RunStep>),
}

fn run(step: RunStep) -> Step {
    Step::Run(Box::new(step))
}

fn named(name: &str) -> RunStep {
    RunStep { name: name.to_owned(), ..RunStep::default() }
}

fn pinned(action: &Action) -> Option<Uses> {
    Some(Uses::Pinned(action.clone()))
}

/// Renders one step as a list item at `indent`, keys in the order GitHub's docs use.
fn render_step(step: &Step, indent: &str) -> String {
    let step = match step {
        Step::Parallel(children) => {
            let rendered: String =
                children.iter().map(|child| render_step(&run(child.clone()), &format!("{indent}      "))).collect();

            return format!("{indent}- parallel:\n{rendered}");
        }
        Step::Run(step) => step,
    };
    let key = format!("{indent}  ");
    let mut lines: Vec<String> =
        step.comment.iter().flat_map(|comment| comment.split('\n').map(|line| format!("{indent}# {line}"))).collect();

    lines.push(format!("{indent}- name: {}", yaml::string(&step.name)));

    if let Some(condition) = &step.if_ {
        lines.extend(yaml::entry("if", &Yaml::str(condition.clone()), &key));
    }

    match &step.uses {
        Some(Uses::Raw(uses)) => lines.extend(yaml::entry("uses", &Yaml::str(uses.clone()), &key)),
        Some(Uses::Pinned(action)) => lines.push(format!(
            "{key}uses: {} # {}",
            yaml::string(&format!("{}@{}", action.name, action.sha)),
            action.version
        )),
        None => {}
    }

    let working_directory = step.working_directory.clone().map(Yaml::Str);
    let shell = step.shell.clone().map(Yaml::Str);
    let run = step.run.clone().map(Yaml::Str);
    let continue_on_error = step.continue_on_error.map(Yaml::Bool);
    let timeout_minutes = step.timeout_minutes.map(Yaml::Number);

    for (entry, value) in [
        ("with", &step.with),
        ("env", &step.env),
        ("working-directory", &working_directory),
        ("shell", &shell),
        ("run", &run),
        ("continue-on-error", &continue_on_error),
        ("timeout-minutes", &timeout_minutes),
    ] {
        if let Some(value) = value {
            lines.extend(yaml::entry(entry, value, &key));
        }
    }

    format!("{}\n", lines.join("\n"))
}

/// The workspace-relative directory of a manifest path (`.` for the root).
fn directory_of(manifest: &str) -> &str {
    manifest.rfind('/').map_or(".", |index| &manifest[..index])
}

fn with(pairs: Vec<(&str, Yaml)>) -> Option<Yaml> {
    Some(Yaml::Map(pairs.into_iter().map(|(key, value)| (key.to_owned(), value)).collect()))
}

/// The setup step for one non-JS toolchain. Versions come from `toolchain.tools` first, then the
/// ecosystem's own version file, then a current default; each action's own cache is used where it has one.
fn ecosystem_step(plan: &Plan, tables: &Tables, detected: &Detected) -> Option<RunStep> {
    let has = |file: &str| plan.root_files.contains(file);
    let manifests = &detected.manifests;
    let step = |name: &str, action: &str, inputs: Option<Yaml>| RunStep {
        uses: pinned(tables.action(action)),
        with: inputs,
        ..named(name)
    };

    match detected.name {
        Ecosystem::Dotnet => {
            // A global.json in the workspace root wins; otherwise the first one found in a project root.
            let global_json = if has("global.json") {
                Some("global.json")
            } else {
                manifests.iter().find(|manifest| manifest.ends_with("/global.json")).map(String::as_str)
            };

            Some(step(
                "Setup .NET",
                "setupDotnet",
                match global_json {
                    None => with(vec![("dotnet-version", Yaml::str("8.0.x"))]),
                    Some(file) => with(vec![("global-json-file", Yaml::str(file))]),
                },
            ))
        }
        Ecosystem::Python => {
            let dependency_files: Vec<&String> = manifests
                .iter()
                .filter(|manifest| manifest.ends_with("pyproject.toml") || manifest.ends_with("requirements.txt"))
                .collect();
            let mut inputs = vec![match plan.pin("python") {
                Some(pin) => ("python-version", Yaml::str(pin)),
                None if has(".python-version") => ("python-version-file", Yaml::str(".python-version")),
                None => ("python-version", Yaml::str("3.x")),
            }];

            // pip caching needs a dependency file to key on; a setup.py-only project has none.
            if !dependency_files.is_empty() {
                let joined: Vec<&str> = dependency_files.iter().map(|file| file.as_str()).collect();

                inputs.push(("cache", Yaml::str("pip")));
                inputs.push(("cache-dependency-path", Yaml::str(format!("{}\n", joined.join("\n")))));
            }

            Some(step("Setup Python", "setupPython", with(inputs)))
        }
        Ecosystem::Ruby => {
            let gemfile = manifests.iter().find(|manifest| manifest.ends_with("Gemfile"));
            let mut inputs = Vec::new();

            // Without a version, setup-ruby reads .ruby-version / .tool-versions.
            match plan.pin("ruby") {
                Some(pin) => inputs.push(("ruby-version", Yaml::str(pin))),
                None if has(".ruby-version") || has(".tool-versions") => {}
                None => inputs.push(("ruby-version", Yaml::str("3.4"))),
            }

            if let Some(gemfile) = gemfile {
                inputs.push(("bundler-cache", Yaml::Bool(true)));
                inputs.push(("working-directory", Yaml::str(directory_of(gemfile))));
            }

            Some(step("Setup Ruby", "setupRuby", with(inputs)))
        }
        // The other toolchains come with a manifest that makes its directory a project of its own
        // (Cargo.toml, go.mod, pom.xml, ...), which `workspace` leaves to Node, so they never get here.
        _ => None,
    }
}

fn setup_steps(plan: &Plan, tables: &Tables) -> Vec<RunStep> {
    let mut steps = Vec::new();
    let setup_node = |cache: Option<&str>| {
        let mut inputs = vec![("node-version", Yaml::str(plan.node_version.clone()))];

        if let Some(cache) = cache {
            inputs.push(("cache", Yaml::str(cache)));
        }

        RunStep { uses: pinned(tables.action("setupNode")), with: with(inputs), ..named("Setup Node.js") }
    };
    let pm = tables.package_manager(&plan.package_manager);
    let node_cache = pm.github_node_cache.as_deref();

    // An action installs the manager before setup-node (which caches through it); shell setup
    // (corepack, npm -g) needs the Node.js that setup-node installs, so it comes after.
    match &pm.github_action {
        None => {
            steps.push(setup_node(node_cache));

            if !pm.setup.is_empty() {
                steps.push(RunStep {
                    run: Some(format!("{}\n", pm.setup.join("\n"))),
                    ..named(&format!("Setup {}", plan.package_manager))
                });
            }
        }
        Some(action) => {
            steps.push(RunStep {
                uses: pinned(tables.action(action)),
                ..named(&format!("Setup {}", plan.package_manager))
            });
            steps.push(setup_node(node_cache));
        }
    }

    steps.push(RunStep { run: Some(pm.install.clone()), ..named("Install dependencies") });

    let mut seen: Vec<String> = Vec::new();

    for ecosystem in &plan.ecosystems {
        if let Some(step) = ecosystem_step(plan, tables, ecosystem) {
            if !seen.contains(&step.name) {
                seen.push(step.name.clone());
                steps.push(step);
            }
        }
    }

    steps.push(RunStep {
        comment: Some("The vis task cache, so unchanged tasks are restored instead of re-run.".to_owned()),
        uses: pinned(tables.action("cache")),
        with: with(vec![
            ("key", Yaml::str("vis-${{ runner.os }}-${{ github.sha }}")),
            ("path", Yaml::str(plan.cache_directory.clone().unwrap_or_else(|| "node_modules/.cache/vis".to_owned()))),
            ("restore-keys", Yaml::str("vis-${{ runner.os }}-\n")),
        ]),
        ..named("Restore vis cache")
    });

    steps.extend(plan.github_after_setup.iter().cloned());

    if plan.check_drift {
        steps.push(RunStep {
            comment: Some(
                "Fails when vis.config.ts or the workspace changed without regenerating this file.".to_owned(),
            ),
            run: Some(vis_drift_check_command(plan, &pm.exec)),
            ..named("Check the workflow is up to date")
        });
    }

    steps
}

/// The target groups as steps. `None` when a group needs more concurrent steps than GitHub runs.
fn target_steps(plan: &Plan, exec: &str) -> Option<Vec<Step>> {
    let mut out = Vec::new();

    for layer in &plan.layers {
        let mut steps = Vec::new();

        for target in layer {
            // One target's shards alone fill the group; counting them one by one would take as long as the count.
            if target.shards > MAX_PARALLEL_STEPS as u64 {
                return None;
            }

            // No --skip-toolchain: the deps step already installed any pinned tool, so each step
            // only activates it (a pinned Node.js must be on PATH in this process too).
            let flags = vec!["--skip-deps".to_owned()];
            let env = target.env.clone().map(Yaml::strings);

            if target.shards == 1 {
                steps.push(RunStep {
                    env,
                    run: Some(vis_target_command(plan, exec, &target.name, &flags)),
                    ..named(&target.name)
                });

                continue;
            }

            for index in 0..target.shards {
                let partition = format!("{}/{}", index + 1, target.shards);
                let mut with_partition = flags.clone();

                with_partition.push(format!("--partition={partition}"));
                steps.push(RunStep {
                    env: env.clone(),
                    run: Some(vis_target_command(plan, exec, &target.name, &with_partition)),
                    ..named(&format!("{} ({partition})", target.name))
                });
            }
        }

        if steps.len() > MAX_PARALLEL_STEPS {
            return None;
        }

        if steps.len() == 1 {
            out.push(run(steps.remove(0)));
        } else {
            out.push(Step::Parallel(steps));
        }
    }

    Some(out)
}

/// Renders `.github/workflows/vis-ci.yml`, or `None` where Node raises an error.
pub fn render(plan: &Plan, tables: &Tables) -> Option<String> {
    let exec = tables.package_manager(&plan.package_manager).exec.clone();
    let names: Vec<&str> = plan.layers.iter().flatten().map(|target| target.name.as_str()).collect();
    let build_dependencies = vis_dependencies_command(plan, &exec, &names);
    let mut steps = vec![run(RunStep {
        comment: Some("Full history, so affected detection can diff against the base.".to_owned()),
        uses: pinned(tables.action("checkout")),
        with: with(vec![("fetch-depth", Yaml::Number(0.0)), ("persist-credentials", Yaml::Bool(false))]),
        ..named("Checkout")
    })];

    steps.extend(setup_steps(plan, tables).into_iter().map(run));
    steps.push(run(RunStep {
        comment: Some("Builds what the targets below depend on once, so the parallel steps\nnever build or restore the same outputs at the same time.".to_owned()),
        run: Some(format!("{build_dependencies}\n")),
        ..named("Build dependencies")
    }));
    steps.extend(target_steps(plan, &exec)?);
    steps.extend(plan.github_after.iter().cloned().map(run));

    let mut job_extras: Vec<String> = Vec::new();

    if let Some(env) = &plan.github_env {
        job_extras.extend(yaml::entry("env", env, "        "));
    }

    if let Some(services) = &plan.github_services {
        job_extras.extend(yaml::entry("services", services, "        "));
    }

    // `{ contents: "read", ...permissions }`: a user `contents` keeps the first position.
    let mut permissions = vec![("contents".to_owned(), Yaml::str("read"))];

    for (name, value) in &plan.github_permissions {
        match permissions.iter_mut().find(|(existing, _)| existing == name) {
            Some(slot) => slot.1 = Yaml::str(value.clone()),
            None => permissions.push((name.clone(), Yaml::str(value.clone()))),
        }
    }

    let branches: Vec<String> =
        plan.branches.iter().map(|branch| format!("            - {}", yaml::string(branch))).collect();
    let extras: String = job_extras.iter().map(|line| format!("{line}\n")).collect();
    let rendered_steps: Vec<String> = steps.iter().map(|step| render_step(step, "            ")).collect();

    Some(format!(
        "# {note}
name: \"vis ci\"

on: # yamllint disable-line rule:truthy
    pull_request:
    # Runs the checks for a merge queue too; an event no queue sends never fires.
    merge_group:
    push:
        branches:
{branches}

{permissions}

concurrency:
    group: \"vis-ci-${{{{ github.event_name == 'pull_request' && github.ref || github.sha }}}}\"
    # Supersede outdated pull request runs. Every other event gets a group per commit, because a
    # shared group keeps only one pending run and would drop the middle one of three quick pushes.
    cancel-in-progress: ${{{{ github.event_name == 'pull_request' }}}}

jobs:
    ci:
        name: \"vis ci\"
        runs-on: {runs_on}
        timeout-minutes: {timeout}
{extras}        steps:
{steps}",
        note = GENERATED_NOTE,
        branches = branches.join("\n"),
        permissions = yaml::entry("permissions", &Yaml::Map(permissions), "").join("\n"),
        runs_on = yaml::string(&plan.runs_on),
        timeout = plan.timeout_minutes,
        steps = rendered_steps.join("\n"),
    ))
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::plan::{Provider, Target};
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    /// The plan `__tests__/util/ci-workflow.test.ts` renders its snapshots from.
    pub fn snapshot_plan(test_shards: u64) -> Plan {
        let target = |name: &str, shards: u64| Target { env: None, name: name.to_owned(), shards };

        Plan {
            affected: true,
            branches: vec!["main".to_owned()],
            cache_directory: None,
            check_drift: true,
            ecosystems: Vec::new(),
            github_after: Vec::new(),
            github_after_setup: Vec::new(),
            github_env: None,
            github_permissions: Vec::new(),
            github_services: None,
            gitlab_after_script: None,
            gitlab_before_script: Vec::new(),
            gitlab_image: None,
            gitlab_services: None,
            gitlab_stage: None,
            gitlab_tags: None,
            gitlab_variables: Vec::new(),
            layers: vec![vec![target("lint", 1), target("build", 1)], vec![target("test", test_shards)]],
            node_version: "22".to_owned(),
            package_manager: "pnpm".to_owned(),
            providers: vec![Provider::Github, Provider::Gitlab],
            root_files: BTreeSet::new(),
            runs_on: "ubuntu-latest".to_owned(),
            timeout_minutes: 60,
            toolchain_pins: BTreeMap::new(),
        }
    }

    #[test]
    fn renders_the_golden_workflow() {
        let expected = include_str!("../../../../__tests__/util/__snapshots__/vis-ci.github.yml");

        assert_eq!(render(&snapshot_plan(2), &Tables::load()).as_deref(), Some(expected));
    }

    #[test]
    fn a_group_above_the_parallel_limit_is_left_to_node() {
        assert_eq!(render(&snapshot_plan(11), &Tables::load()), None);
    }
}
