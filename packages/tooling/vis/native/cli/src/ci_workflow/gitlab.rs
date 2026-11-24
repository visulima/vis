//! GitLab CI renderer for `vis sync ci-workflow` (`src/util/ci-workflow/gitlab.ts`).
//!
//! GitLab has no concurrent steps inside a job, so every target is its own job (with `parallel: N`
//! for shards) and jobs of one group run on separate machines at the same time.

use super::ecosystems::Ecosystem;
use super::plan::{vis_drift_check_command, vis_target_command, Plan, GENERATED_NOTE};
use super::tables::Tables;
use super::yaml::{self, Yaml};
use crate::js::json_string;

pub const GITLAB_CI_WORKFLOW_PATH: &str = ".gitlab/vis-ci.gitlab-ci.yml";

/// GitLab rejects a pipeline with a job above these (https://docs.gitlab.com/ci/yaml/).
const MAX_PARALLEL_JOBS: u64 = 200;
const MAX_NEEDS: usize = 50;

fn job_name(target: &str) -> String {
    format!("vis:{target}")
}

/// A YAML single-quoted scalar, which GitLab `rules:if` expressions are usually written in.
fn single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Characters `/[$()+.?[\\\]^{|}/]/gu` escapes.
fn is_regex_special(character: char) -> bool {
    matches!(character, '$' | '(' | ')' | '+' | '.' | '?' | '[' | '\\' | ']' | '^' | '{' | '|' | '}' | '/')
}

/// GitLab `rules:if` for a GitHub-style branch filter: an exact comparison, or a regex when the
/// pattern uses `*` (`*` stays within a path segment, `**` crosses them).
fn branch_rule(branch: &str) -> String {
    if !branch.contains('*') {
        return format!("$CI_COMMIT_BRANCH == {}", json_string(branch));
    }

    let pattern: Vec<String> = branch
        .split("**")
        .map(|part| {
            part.split('*')
                .map(|literal| {
                    literal
                        .chars()
                        .flat_map(
                            |character| {
                                if is_regex_special(character) {
                                    vec!['\\', character]
                                } else {
                                    vec![character]
                                }
                            },
                        )
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("[^\\/]*")
        })
        .collect();

    format!("$CI_COMMIT_BRANCH =~ /^{}$/", pattern.join(".*"))
}

/// GitLab only caches paths inside the project directory. Only a path `@visulima/path`'s `normalize`
/// leaves alone is answered here (plain relative segments), so the result is the path itself; anything
/// else, and every path outside the project, is Node's.
fn cache_path(cache_directory: Option<&str>) -> Option<String> {
    let Some(directory) = cache_directory else {
        return Some(".vis-cache".to_owned());
    };
    let plain = !directory.is_empty()
        && directory.is_ascii()
        && !directory.contains(['\\', ':'])
        && directory.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..");

    plain.then(|| directory.to_owned())
}

/// Toolchains vis's own pre-flight installs when they are pinned in `toolchain.tools`.
fn is_preflight_tool(name: Ecosystem) -> bool {
    matches!(name, Ecosystem::Go | Ecosystem::Python | Ecosystem::Ruby | Ecosystem::Rust)
}

/// Package caches moved into the project directory, the only place GitLab caches.
fn ecosystem_cache(name: Ecosystem) -> Option<(&'static str, &'static str)> {
    match name {
        Ecosystem::Go => Some((".go-mod", "GOMODCACHE")),
        Ecosystem::Python => Some((".pip-cache", "PIP_CACHE_DIR")),
        Ecosystem::Rust => Some((".cargo", "CARGO_HOME")),
        _ => None,
    }
}

/// Detected toolchains a GitLab job cannot get: the jobs run in a plain `node` image (unless
/// `ci.workflow.gitlab.image` replaces it), and vis's pre-flight only installs go, python, ruby and
/// rust, and only when they are pinned in `toolchain.tools`.
pub fn missing_toolchains(plan: &Plan) -> Vec<&'static str> {
    if plan.gitlab_image.is_some() {
        return Vec::new();
    }

    plan.ecosystems
        .iter()
        .filter(|detected| !(is_preflight_tool(detected.name) && plan.pin(detected.name.name()).is_some()))
        .map(|detected| detected.name.name())
        .collect()
}

/// Renders `.gitlab/vis-ci.gitlab-ci.yml`, or `None` where Node raises an error.
pub fn render(plan: &Plan, tables: &Tables) -> Option<String> {
    let pm = tables.package_manager(&plan.package_manager);
    let branch_rules: Vec<String> =
        plan.branches.iter().map(|branch| format!("        - if: {}", single_quoted(&branch_rule(branch)))).collect();
    let cache_directory = cache_path(plan.cache_directory.as_deref())?;
    let ecosystem_caches: Vec<(&str, &str)> =
        plan.ecosystems.iter().filter_map(|detected| ecosystem_cache(detected.name)).collect();

    let mut variables = vec![
        "        # Full history, so affected detection can diff against the base.".to_owned(),
        "        GIT_DEPTH: \"0\"".to_owned(),
    ];

    // A configured taskRunner.cacheDirectory wins over the variable, so only set it for the default.
    if plan.cache_directory.is_none() {
        variables.push(
            "        # Outside node_modules, so a clean install (npm ci) keeps the restored task cache.".to_owned(),
        );
        variables.push(format!("        VIS_CACHE_DIRECTORY: \"$CI_PROJECT_DIR/{cache_directory}\""));
    }

    variables.extend(
        ecosystem_caches.iter().map(|(path, variable)| format!("        {variable}: \"$CI_PROJECT_DIR/{path}\"")),
    );

    for (name, value) in &plan.gitlab_variables {
        variables.extend(yaml::entry(name, &Yaml::str(value.clone()), "        "));
    }

    let cache_paths: Vec<String> = std::iter::once(cache_directory.as_str())
        .chain(ecosystem_caches.iter().map(|(path, _)| *path))
        .map(|path| format!("            - {}", json_string(&format!("{path}/"))))
        .collect();
    let mut install: Vec<String> = pm.setup.clone();

    install.push(pm.install.clone());
    install.extend(plan.gitlab_before_script.iter().cloned());

    let before_script: Vec<String> = install.iter().map(|line| format!("        - {}", json_string(line))).collect();
    let mut base_extras: Vec<String> = Vec::new();

    for (name, value) in
        [("tags", &plan.gitlab_tags), ("services", &plan.gitlab_services), ("after_script", &plan.gitlab_after_script)]
    {
        if let Some(value) = value {
            base_extras.extend(yaml::entry(name, value, "    "));
        }
    }

    let missing = missing_toolchains(plan);
    let missing_note = if missing.is_empty() {
        String::new()
    } else {
        format!(
            "#\n# Not on the node image: {}. Pin go, python, ruby or rust in\n# toolchain.tools (vis.config.ts) so vis installs them, or set `image:` on\n# .vis-ci-base in your .gitlab-ci.yml to one that has them.\n",
            missing.join(", ")
        )
    };

    let mut jobs = String::new();

    if plan.check_drift {
        jobs.push_str(&format!(
            "\n\"vis:workflow\":\n    extends: \".vis-ci-base\"\n    needs: []\n    script:\n        - {}\n",
            json_string(&vis_drift_check_command(plan, &pm.exec))
        ));
    }

    let mut previous: Vec<String> = Vec::new();

    for layer in &plan.layers {
        for target in layer {
            if target.shards > MAX_PARALLEL_JOBS || previous.len() > MAX_NEEDS {
                return None;
            }

            let flags = if target.shards == 1 {
                Vec::new()
            } else {
                vec!["--partition=$CI_NODE_INDEX/$CI_NODE_TOTAL".to_owned()]
            };
            let needs: Vec<String> = previous.iter().map(|job| json_string(job)).collect();
            let parallel =
                if target.shards == 1 { String::new() } else { format!("    parallel: {}\n", target.shards) };
            let env = match &target.env {
                None => String::new(),
                Some(env) => format!("{}\n", yaml::entry("variables", &Yaml::strings(env.clone()), "    ").join("\n")),
            };

            jobs.push_str(&format!(
                "\n{}:\n    extends: \".vis-ci-base\"\n    needs: [{}]\n{parallel}{env}    script:\n        - {}\n",
                json_string(&job_name(&target.name)),
                needs.join(", "),
                json_string(&vis_target_command(plan, &pm.exec, &target.name, &flags))
            ));
        }

        previous = layer.iter().map(|target| job_name(&target.name)).collect();
    }

    let extras: String = base_extras.iter().map(|line| format!("{line}\n")).collect();

    Some(format!(
        "# {note}
#
# Include it from .gitlab-ci.yml:
#   include:
#     - local: \"{path}\"
#
# Every target is its own job, so jobs in a group run on separate machines at
# the same time; a partitioned target fans out with `parallel: N`.
{missing_note}.vis-ci-base:
    stage: {stage}
    image: {image}
    timeout: \"{timeout}m\"
    variables:
{variables}
    cache:
        # Per job: jobs of one group finish in any order, and a shared key keeps only the last upload.
        key: \"vis-$CI_JOB_NAME_SLUG-$CI_COMMIT_REF_SLUG\"
        paths:
{cache_paths}
    rules:
        - if: '$CI_PIPELINE_SOURCE == \"merge_request_event\"'
{branch_rules}
    before_script:
{before_script}
{extras}{jobs}",
        note = GENERATED_NOTE,
        path = GITLAB_CI_WORKFLOW_PATH,
        stage = json_string(plan.gitlab_stage.as_deref().unwrap_or("test")),
        image = json_string(&plan.gitlab_image.clone().unwrap_or_else(|| format!("node:{}", plan.node_version))),
        timeout = plan.timeout_minutes,
        variables = variables.join("\n"),
        cache_paths = cache_paths.join("\n"),
        branch_rules = branch_rules.join("\n"),
        before_script = before_script.join("\n"),
    ))
}

#[cfg(test)]
mod tests {
    use super::super::github::tests::snapshot_plan;
    use super::*;

    #[test]
    fn renders_the_golden_gitlab_file() {
        let expected = include_str!("../../../../__tests__/util/__snapshots__/vis-ci.gitlab-ci.yml");

        assert_eq!(render(&snapshot_plan(3), &Tables::load()).as_deref(), Some(expected));
    }

    #[test]
    fn branch_filters_become_exact_comparisons_or_regexes() {
        assert_eq!(branch_rule("main"), "$CI_COMMIT_BRANCH == \"main\"");
        assert_eq!(branch_rule("release/*"), "$CI_COMMIT_BRANCH =~ /^release\\/[^\\/]*$/");
        assert_eq!(branch_rule("v1.x/**"), "$CI_COMMIT_BRANCH =~ /^v1\\.x\\/.*$/");
    }

    #[test]
    fn only_plain_relative_cache_paths_are_answered() {
        assert_eq!(cache_path(None).as_deref(), Some(".vis-cache"));
        assert_eq!(cache_path(Some("node_modules/.cache/vis")).as_deref(), Some("node_modules/.cache/vis"));

        for path in ["", "/abs", "../up", "a/../b", "./x", "a/", "a//b", "a\\b", "C:/x"] {
            assert_eq!(cache_path(Some(path)), None, "{path}");
        }
    }
}
