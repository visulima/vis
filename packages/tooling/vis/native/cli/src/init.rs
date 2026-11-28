//! `vis init` — the native port of `src/commands/init/handler.ts` for the shapes that ask nothing: no terminal on stdin
//! (Node then runs `runStaticInit`, not the wizard), a CI run off a terminal at the root of a pnpm workspace.
//!
//! The handler writes `vis.config.ts` with the secure defaults (and, on request, the editor and agent files and the pnpm
//! settings), adds the run-state entries to `.gitignore` and prints what it did. This module writes the same files with
//! the bytes `@visulima/fs`'s `writeFileSync` leaves (a new inode with the default mode, see [`stage`]) and prints the
//! same pail blocks.
//!
//! The answered flags are `--schema`, `--agent`, `--force`, `--no-interactive`, `--sync-native` and `--editor vscode`, each at
//! most once and spelled exactly. Everything is read and decided before the first write, and the run goes to Node,
//! before anything is printed, whenever one of these holds:
//!
//! - any other argument (`--yes` is not an `init` option, Node rejects it; `--interactive`, another editor, a positional);
//! - stdin is a terminal, or the context is not the one the other config-reading commands answer ([`ci_root_context`], no
//!   Deno file, a pail layout the environment decides, a config that [`sync_input`] accepts);
//! - the package manager is not pnpm (the other branches of `native-config-sync.ts` are not ported), or `pnpm-workspace.yaml`
//!   is a file the text edits of [`pnpm::init_plan`] do not reproduce;
//! - an existing config is not a plain file, `.vscode/settings.json` or `.vscode/extensions.json` exist (Node merges
//!   them), `.ai` or `.vscode` is not a directory, `package.json` or `.gitignore` is not UTF-8 text Node reads the same
//!   way, or a message would not be plain ASCII;
//! - a file cannot be staged, or the first one cannot be replaced: no target is renamed before every temporary file
//!   exists, so the files are still untouched. A rename that fails after the first one is reported as a write error.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{ErrorKind, IsTerminal};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use vis_core::detect::detect_package_manager;

use crate::js::trim;
use crate::node_context::{any_ancestor_has, ci_root_context, DENO_FILES};
use crate::output::Output;
use crate::pail::{Layout, Level};
use crate::security_list::sync_input;
use crate::security_sync::pnpm::init_plan;
use crate::security_sync::stage::{self, File};

/// `CONFIG_FILES` in `src/config/config.ts`, in the order Node looks for them.
const CONFIG_FILES: [&str; 6] =
    ["vis.config.ts", "vis.config.mts", "vis.config.cts", "vis.config.js", "vis.config.mjs", "vis.config.cjs"];

/// `DEFAULT_MIN_RELEASE_AGE_MINUTES`.
const MINIMUM_RELEASE_AGE_MINUTES: i64 = 2880;

/// `generateConfigContent` for the static run: no allowed builds, no Socket or deps.dev, no staged commands, the default age.
const CONFIG: &str = r##"import { defineConfig } from "@visulima/vis/config";

export default defineConfig({
    // Workspace-wide task defaults. Keys are target names, matched
    // exactly against your package.json scripts. Everything here is
    // optional — vis runs your scripts without any of it.
    //
    // tasks: {
    //     build: {
    //         // Build the packages this one depends on first.
    //         dependsOn: ["^build"],
    //         outputs: ["{projectRoot}/dist/**"],
    //     },
    //     test: {
    //         dependsOn: ["build"],
    //     },
    // },
    //
    // Docs: https://visulima.com/docs/packages/vis/configuration

    security: {
        policies: {
            installScripts: {
                allow: {},
            },
            firstSeen: {
                minutes: 2880,
            },
        },
    },
});
"##;

/// `VIS_IGNORE_ENTRIES` in `src/io/gitignore.ts`.
const IGNORE_ENTRIES: [&str; 3] = [".vis/last-summary.json", ".vis/last-failures/", ".vis/runs/"];

/// The comment line `ensureVisGitignore` puts above the entries it adds.
const IGNORE_HEADER: &str =
    "# vis run state (.vis/templates and .vis/hooks are tracked \u{2014} do not ignore .vis/ wholesale)";

const VSCODE_SETTINGS: &str =
    "{\n    \"editor.defaultFormatter\": \"oxc.oxc-vscode\",\n    \"editor.formatOnSave\": true\n}\n";
const VSCODE_EXTENSIONS: &str = "{\n    \"recommendations\": [\n        \"oxc.oxc-vscode\"\n    ]\n}\n";

/// The flags of one run.
#[derive(Default)]
struct Shape {
    agent: bool,
    editor: bool,
    force: bool,
    schema: bool,
    sync_native: bool,
}

/// What stops a native answer: the reason for the hand-off.
type Declined = &'static str;

/// Answers `vis init` natively or hands the whole invocation to Node. Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Ok(output) => output.emit("init"),
        Err(reason) => crate::process::delegate_because(reason, raw_args),
    }
}

/// The flags of `args` when they are all ones this module answers, each spelled exactly and given once.
fn parse(args: &[String]) -> Option<Shape> {
    let flags = args.strip_prefix(&["init".to_owned()])?;
    let mut shape = Shape::default();
    let mut no_interactive = false;
    let mut index = 0;

    while index < flags.len() {
        let slot = match flags[index].as_str() {
            "--agent" => &mut shape.agent,
            "--force" => &mut shape.force,
            "--schema" => &mut shape.schema,
            "--sync-native" => &mut shape.sync_native,
            "--no-interactive" => &mut no_interactive,
            "--editor" if flags.get(index + 1).map(String::as_str) == Some("vscode") => {
                index += 1;
                &mut shape.editor
            }
            "--editor=vscode" => &mut shape.editor,
            _ => return None,
        };

        if std::mem::replace(slot, true) {
            return None;
        }

        index += 1;
    }

    Some(shape)
}

/// The working directory when Node would reach the same answer from the workspace root.
fn context() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;

    (ci_root_context(&cwd) && !any_ancestor_has(&cwd, &DENO_FILES)).then_some(cwd)
}

/// What the run prints, in order, and what it writes.
struct Plan {
    messages: Vec<(Level, String)>,
    directories: Vec<PathBuf>,
    files: Vec<File>,
}

impl Plan {
    fn say(&mut self, level: Level, message: impl Into<String>) {
        self.messages.push((level, message.into()));
    }
}

/// `isAccessibleSync(path)`: whether the path (a link followed) exists. `None` for any other failure.
fn accessible(path: &Path) -> Option<bool> {
    match fs::metadata(path) {
        Ok(_) => Some(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Some(false),
        Err(_) => None,
    }
}

/// `ensureDirSync(path)` leaves a real directory alone, creates a missing one and throws for anything else, a link to a
/// directory included. `Some(true)` when the directory has to be created.
fn needs_directory(path: &Path) -> Option<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.is_dir().then_some(false),
        Err(error) if error.kind() == ErrorKind::NotFound => Some(true),
        Err(_) => None,
    }
}

/// The text of a file, `Some(None)` when it does not exist; `None` for anything but UTF-8 text in a regular file.
fn read_text(path: &Path) -> Option<Option<String>> {
    match fs::metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Some(None),
        Err(_) => return None,
        Ok(metadata) if !metadata.is_file() => return None,
        Ok(_) => {}
    }

    String::from_utf8(fs::read(path).ok()?).ok().map(Some)
}

/// `readRootPackageJson`: the root `package.json` as an object, empty when there is none. `None` when it is a file Node
/// might read differently (not UTF-8, a byte order mark, comments) or one that is not an object.
fn root_package_json(cwd: &Path) -> Option<Map<String, Value>> {
    match read_text(&cwd.join("package.json"))? {
        None => Some(Map::new()),
        Some(text) => match serde_json::from_str::<Value>(&text).ok()? {
            Value::Object(object) => Some(object),
            _ => None,
        },
    }
}

/// `declaredVersion(packageJson, "oxfmt") !== undefined`.
fn declares_oxfmt(package: &Map<String, Value>) -> bool {
    ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].iter().any(|field| {
        package
            .get(*field)
            .and_then(Value::as_object)
            .is_some_and(|block| block.get("oxfmt").is_some_and(Value::is_string))
    })
}

/// `existingProjectInstructions`: the run commands the root `package.json` defines.
fn agent_instructions(package: &Map<String, Value>) -> String {
    let scripts = package.get("scripts").and_then(Value::as_object);
    let lines: Vec<String> = ["build", "test", "lint"]
        .iter()
        .filter(|name| scripts.is_some_and(|scripts| scripts.get(**name).is_some_and(Value::is_string)))
        .map(|name| {
            let mut title = name.to_string();

            title[..1].make_ascii_uppercase();

            format!("- {title}: `pnpm run {name}`")
        })
        .collect();
    let list = if lines.is_empty() { String::new() } else { format!("\n{}", lines.join("\n")) };

    format!("# Project Instructions\n\n## Development\n\n- Package manager: pnpm{list}\n")
}

/// The first config file `findVisConfigFile` lists in the directory, which reads the directory's own entries: a name that
/// differs in case on a case-insensitive file system is not one. `Some(None)` when there is none; `None` when it is not a
/// plain file, or one the Node loader fails on, which it reports on stderr when it starts: a `.cts` or `.cjs` file is
/// CommonJS and a `.js` file is when the root `package.json` says `"type": "commonjs"`, and the config is an ES module.
/// A `.js` file with no `type` loads, because Node detects ES module syntax from 22.7 on and `engines.node` starts at 22.14.
fn existing_config(cwd: &Path) -> Option<Option<PathBuf>> {
    let entries: Vec<String> =
        fs::read_dir(cwd).ok()?.filter_map(|entry| entry.ok()?.file_name().into_string().ok()).collect();

    let Some(name) = CONFIG_FILES.iter().find(|name| entries.iter().any(|entry| entry == *name)) else {
        return Some(None);
    };
    let path = cwd.join(name);

    let loads = match *name {
        "vis.config.cts" | "vis.config.cjs" => false,
        "vis.config.js" => root_package_json(cwd)?.get("type").is_none_or(|kind| kind == "module"),
        _ => true,
    };

    (loads && fs::symlink_metadata(&path).ok()?.is_file()).then_some(Some(path))
}

/// The lines of `text` as `split(/\r?\n/)` gives them.
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;

    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }

    lines
}

/// `^\*{0,2}\/?\.vis(?:\/\*{0,2})?$`: a broader `.vis` rule the user wrote.
fn is_broad_vis_rule(line: &str) -> bool {
    let rest = line.trim_start_matches('*');

    if line.len() - rest.len() > 2 {
        return false;
    }

    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let Some(rest) = rest.strip_prefix(".vis") else {
        return false;
    };

    rest.is_empty()
        || rest.strip_prefix('/').is_some_and(|stars| stars.len() <= 2 && stars.bytes().all(|byte| byte == b'*'))
}

/// `alreadyCovered`.
fn already_covered(lines: &[&str], entry: &str) -> bool {
    let without_slash = entry.strip_suffix('/').unwrap_or(entry);

    lines.iter().any(|line| {
        let trimmed = trim(line);

        !trimmed.is_empty()
            && !trimmed.starts_with('#')
            && (trimmed == entry || trimmed == without_slash || is_broad_vis_rule(trimmed))
    })
}

/// `ensureVisGitignore(cwd)`: the entries it adds and the file to write; `None` when Node has to answer.
fn gitignore(cwd: &Path) -> Option<(Vec<&'static str>, Option<File>)> {
    let path = cwd.join(".gitignore");
    let original = read_text(&path)?.unwrap_or_default();
    let newline = if original.contains("\r\n") { "\r\n" } else { "\n" };
    let lines = split_lines(&original);
    let missing: Vec<&'static str> =
        IGNORE_ENTRIES.into_iter().filter(|entry| !already_covered(&lines, entry)).collect();

    if missing.is_empty() {
        return Some((missing, None));
    }

    let mut kept: Vec<&str> = lines;

    while kept.last().is_some_and(|line| trim(line).is_empty()) {
        kept.pop();
    }

    if !kept.is_empty() {
        kept.push("");
    }

    kept.push(IGNORE_HEADER);
    kept.extend(&missing);

    let contents = format!("{}{newline}", kept.join(newline));

    Some((missing, Some(File { path, contents })))
}

/// The `--schema` blocks: `printSchemaPaths`, which does not depend on the directory, because the workspace root is the
/// working directory.
fn schema_messages(plan: &mut Plan) {
    plan.say(Level::Info, "");
    plan.say(Level::Info, "Paste these into your config files to get editor IntelliSense:");
    plan.say(Level::Info, "");
    plan.say(
        Level::Info,
        "  project.json    \u{2192} \"$schema\": \"./node_modules/@visulima/vis/schemas/project.schema.json\"",
    );
    plan.say(
        Level::Info,
        "  vis.config.ts   \u{2192} see ./node_modules/@visulima/vis/schemas/vis-config.schema.json (vis.config.ts is TypeScript; use the import path directly)",
    );
    plan.say(Level::Info, "");
    plan.say(
        Level::Notice,
        "For nested project.json files, the `..` depth changes \u{2014} run `vis migrate nx` to auto-rewrite all of them.",
    );
}

/// Everything the run does, decided and not yet done.
fn plan(shape: &Shape, cwd: &Path) -> Result<Plan, Declined> {
    let mut plan = Plan { messages: Vec::new(), directories: Vec::new(), files: Vec::new() };

    // Node loads the config at start-up, whichever flags it has, and reports one it cannot load.
    let existing = existing_config(cwd).ok_or("the existing config is not one the Node loader reads quietly")?;

    if shape.schema {
        schema_messages(&mut plan);

        return Ok(plan);
    }

    let cwd_text = cwd.to_str().ok_or("the working directory is not text")?;

    if (shape.agent || shape.sync_native) && detect_package_manager(cwd_text, None).name != "pnpm" {
        return Err("the package manager is not pnpm");
    }

    if shape.editor {
        let package = root_package_json(cwd).ok_or("package.json is not a file Node reads the same way")?;

        if declares_oxfmt(&package) {
            let directory = cwd.join(".vscode");
            let settings = directory.join("settings.json");
            let extensions = directory.join("extensions.json");

            if accessible(&settings) != Some(false) || accessible(&extensions) != Some(false) {
                return Err("a .vscode file exists and Node merges into it");
            }

            if needs_directory(&directory).ok_or(".vscode is not a directory")? {
                plan.directories.push(directory);
            }

            plan.files.push(File { path: settings, contents: VSCODE_SETTINGS.to_owned() });
            plan.say(Level::Success, "Created .vscode/settings.json");
            plan.files.push(File { path: extensions, contents: VSCODE_EXTENSIONS.to_owned() });
            plan.say(Level::Success, "Created .vscode/extensions.json");
        } else {
            plan.say(
                Level::Notice,
                "Skipped .vscode: the project does not use oxfmt, so there is no editor setting to add.",
            );
        }
    }

    if shape.agent {
        let directory = cwd.join(".ai");
        let instructions = directory.join("instructions");

        if needs_directory(&directory).ok_or(".ai is not a directory")? {
            plan.directories.push(directory);
        }

        if !accessible(&instructions).ok_or("the instructions file cannot be inspected")? {
            let package = root_package_json(cwd).ok_or("package.json is not a file Node reads the same way")?;

            plan.files.push(File { path: instructions, contents: agent_instructions(&package) });
            plan.say(Level::Success, "Created .ai/instructions");
        }
    }

    if let Some(path) = existing.as_ref().filter(|_| !shape.force) {
        plan.say(Level::Warning, format!("Config already exists: {}", path.display()));
        plan.say(Level::Notice, "Use --force to overwrite, or edit the existing file.");

        return Ok(plan);
    }

    let config = existing.unwrap_or_else(|| cwd.join("vis.config.ts"));

    plan.say(Level::Success, format!("Created {}", config.display()));
    plan.files.push(File { path: config, contents: CONFIG.to_owned() });
    plan.say(Level::Info, "  Secure defaults are applied automatically by defineConfig().");

    if shape.sync_native {
        let sync = init_plan(cwd, MINIMUM_RELEASE_AGE_MINUTES)
            .ok_or("pnpm-workspace.yaml is not a file the text edits reproduce")?;

        for action in sync.actions {
            plan.say(Level::Success, format!("  {action}"));
        }

        plan.files.extend(sync.files);
    }

    plan.say(Level::Info, "");
    plan.say(Level::Notice, "Run 'vis doctor' for a full health check, or 'vis init' in a terminal for guided setup.");

    let (added, file) = gitignore(cwd).ok_or(".gitignore is not a file Node reads the same way")?;

    plan.files.extend(file);

    if !added.is_empty() {
        plan.say(Level::Success, format!("Added to .gitignore: {}", added.join(", ")));
    }

    Ok(plan)
}

fn answer(args: &[String]) -> Result<Output, Declined> {
    let shape = parse(args).ok_or("not an `init` shape the binary answers")?;
    let layout = Layout::detect(args).ok_or("pail's layout is not decided by the environment")?;

    if std::io::stdin().is_terminal() {
        return Err("stdin is a terminal: Node asks the questions");
    }

    let cwd = context().ok_or("not a CI run at the root of a pnpm workspace")?;

    // Node loads the config at start-up, so it must be one the native path reads exactly.
    sync_input(&cwd).ok_or("the config needs Node")?;

    let plan = plan(&shape, &cwd)?;
    let mut output = Output::default();

    // Decided before the first write: a message pail would lay out differently is Node's.
    for (level, message) in &plan.messages {
        let block = if shape.schema {
            layout.block_fitting_with_dash(*level, message)
        } else {
            layout.block_fitting(*level, message)
        }
        .ok_or("a message is not plain text")?;

        if level.to_stderr() {
            output.stderr.push_str(&block)
        } else {
            output.stdout.push_str(&block)
        }
    }

    for directory in &plan.directories {
        fs::create_dir_all(directory).map_err(|_| "cannot create a directory")?;
    }

    if let Err(failure) = stage::write_all(&plan.files) {
        return match failure {
            stage::Failure::Staging(_) => Err("cannot stage the files"),
            stage::Failure::Renaming { renamed: 0, .. } => Err("cannot replace the first file"),
            stage::Failure::Renaming { error, .. } => {
                crate::error::WrapperError::write("init", "the files", error).exit()
            }
        };
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn the_answered_flags_are_native_once_each_in_any_order() {
        assert!(parse(&args(&["init"])).is_some());

        let all =
            parse(&args(&["init", "--force", "--editor", "vscode", "--agent", "--sync-native", "--no-interactive"]))
                .unwrap();

        assert!(all.force && all.editor && all.agent && all.sync_native && !all.schema);
        assert!(parse(&args(&["init", "--editor=vscode"])).is_some_and(|shape| shape.editor));
        assert!(parse(&args(&["init", "--schema"])).is_some_and(|shape| shape.schema));
    }

    #[test]
    fn every_other_shape_is_node_s() {
        for shape in [
            &["init", "--yes"][..],
            &["init", "--interactive"],
            &["init", "--force", "--force"],
            &["init", "--editor"],
            &["init", "--editor", "zed"],
            &["init", "--editor=zed"],
            &["init", "--editor", "vscode", "--editor=vscode"],
            &["init", "--force=true"],
            &["init", "--no-force"],
            &["init", "--agent=false"],
            &["init", "extra"],
            &["init", "--"],
            &["init", "--cwd", "."],
            &["migrate"],
        ] {
            assert!(parse(&args(shape)).is_none(), "{shape:?}");
        }
    }

    #[test]
    fn the_broad_rules_a_user_may_have_written_cover_the_entries() {
        for rule in [".vis", ".vis/", ".vis/*", ".vis/**", "/.vis", "*.vis", "**/.vis", "**/.vis/**", "*/.vis/*"] {
            assert!(is_broad_vis_rule(rule), "{rule}");
        }

        for rule in [".visx", ".vis/templates", "***/.vis", ".vis/***", "a/.vis", ".vi", "vis", "!.vis", "//.vis"] {
            assert!(!is_broad_vis_rule(rule), "{rule}");
        }
    }

    #[test]
    fn lines_split_like_a_regular_expression_on_an_optional_carriage_return() {
        assert_eq!(split_lines("a\r\nb\nc\rd\r"), vec!["a", "b", "c\rd\r"]);
        assert_eq!(split_lines(""), vec![""]);
        assert_eq!(split_lines("\n"), vec!["", ""]);
    }

    #[test]
    fn the_agent_file_lists_the_scripts_that_are_strings() {
        let package: Map<String, Value> =
            serde_json::from_str(r#"{"scripts":{"build":"tsc","test":1,"lint":"x"}}"#).unwrap();

        assert_eq!(
            agent_instructions(&package),
            "# Project Instructions\n\n## Development\n\n- Package manager: pnpm\n- Build: `pnpm run build`\n- Lint: `pnpm run lint`\n"
        );
        assert_eq!(
            agent_instructions(&Map::new()),
            "# Project Instructions\n\n## Development\n\n- Package manager: pnpm\n"
        );
    }
}
