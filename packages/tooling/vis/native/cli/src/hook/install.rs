//! `vis hook install` — the native fast path for a repository with one checkout and nothing else claiming its hooks.
//!
//! The Node handler (`src/commands/hook/{handler,install}.ts`) writes the generated `_` dispatcher (a `.gitignore`, the
//! `h` script and one stub per standard stage), points `core.hooksPath` at it and creates an empty `pre-commit` when
//! there is none. In a CI context it prints two plain lines. This module writes the same files, with the same modes, and
//! prints the same lines.
//!
//! Every read and every decision comes before the first write, and the run goes to Node, before anything is printed,
//! whenever one of these holds:
//!
//! - the arguments are not `hook install` with at most one plain `--hooks-dir` without `..` in it (`--force` is Node's),
//!   or the context is not the one the other read-only hook commands answer;
//! - another tool may claim the hooks: a husky directory or a prek config (Node asks a question), a `.vis-hooks`
//!   directory (Node moves it), or a `core.hooksPath` that is set by the repository and is not `<dir>/_` itself (Node
//!   yields, warns, fails or keeps a value anchored at another prefix);
//! - the working directory is not the top level of the repository, or the repository has another checkout (Node
//!   writes a dispatcher into each one), or `config.json` is not one [`super::config`] accepts (the dispatcher bakes in
//!   `skipInCI`);
//! - this build has no binding package for its platform (the `h` script names it), or the output would not be plain ASCII.
//!
//! A write that fails after the first one (a read-only `_`, a file where a directory belongs) is handed to Node too,
//! with the files already written in place. That is sound because the dispatcher is rewritten whole and `core.hooksPath`
//! is only set afterwards: Node's run over the partial tree ends in the tree it would have written itself, and reports
//! the failure in its own words.
//!
//! The `h` script names the binding package of the platform. Node asks the running Node for it (`nativeTarget` in
//! `src/util/native-target.ts`); the binary knows its own target at build time, which is the same unless a
//! binary of another C library is started through `VIS_NATIVE_BIN`.

use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};

use serde_json::Value;

use super::checkout::{checkout_roots, git, repository_hooks_path, Git};
use super::common::{parse, STAGES};
use super::config;
use crate::node_context::context_is_native;
use crate::output::write_stdout;

/// Where husky keeps its hooks (`HUSKY_DIRECTORIES`).
const HUSKY_DIRECTORIES: [&str; 2] = [".husky", ".config/husky"];

/// The configs of the prek / pre-commit framework (`PREK_CONFIG_FILES`).
const PREK_CONFIG_FILES: [&str; 3] = [".pre-commit-config.yaml", ".pre-commit-config.yml", "prek.toml"];

/// The pre-1.0 hooks directory, which Node moves into place.
const LEGACY_HOOKS_DIRECTORY: &str = ".vis-hooks";

/// A stage stub: it sources `h` from the directory it sits in.
const STAGE_STUB: &str = "#!/usr/bin/env sh\ncase $0 in */*) . \"${0%/*}/h\";; *) . ./h;; esac";

/// The dispatcher, `hookScript` in `install.ts`, with the five values it bakes in as `@…@` markers.
const DISPATCHER: &str = r##"#!/usr/bin/env sh
{ [ "$VIS_GIT_HOOKS" = "2" ]; } && set -x
n=${0##*/}
s=${0%/*}
case $s in */*) s=${s%/*};; *) s=.;; esac
s=$s/$n

[ ! -f "$s" ] && exit 0

{ [ "${VIS_GIT_HOOKS-}" = "0" ]; } && exit 0
@CI_GUARD@
d=$0
i=@DEPTH@
while [ "$i" -gt 0 ]; do case $d in */*) d=${d%/*};; *) d=.;; esac; i=$((i - 1)); done
case $d in /*) ;; .) d=$PWD;; *) d=$PWD/${d#./};; esac
export PATH="$d/node_modules/.bin:$PATH"

std=0
while IFS= read -r l || [ -n "$l" ]; do
    case $l in
        ""|"#"*) ;;
        "exec vis hook run $n \"\$@\"") std=$((std + 1));;
        *) std=-1000;;
    esac
done < "$s"

b=
if [ "$std" = 1 ]; then
    p=$d/node_modules/@visulima/vis
    for b in "${VIS_NATIVE_BIN-}" "$p/vis-native-cli"@BINDING@; do [ -x "$b" ] && break; b=; done
    [ -f "$p/dist/bin.js" ] || b=
fi

if [ -n "$b" ]; then
    VIS_NODE=node VIS_FALLBACK_ENTRY="$p/dist/bin.js" "$b" hook run "$n" "$@"
    c=$?
    # The native runner only exits 0 or 1; 126 / 127 mean the binary itself could not start
    # (built for another platform, corrupt), so the stock script still gets its turn.
    case $c in 126|127) b=;; esac
fi

if [ -z "$b" ]; then
    sh -e "$s" "$@"
    c=$?
fi

[ $c != 0 ] && echo "vis - $n script failed (code $c)"
[ $c = 127 ] && echo "vis - command not found in PATH=$PATH"
exit $c"##;

/// The binding package of a platform, as `nativeTarget` gives it for the Node of that platform. `os` and `arch` are
/// Rust's names (`std::env::consts`); `None` for a platform with no published binary.
fn binding_target(os: &str, arch: &str, musl: bool) -> Option<&'static str> {
    match (os, arch, musl) {
        ("macos", "aarch64", _) => Some("darwin-arm64"),
        ("macos", "x86_64", _) => Some("darwin-x64"),
        ("linux", "aarch64", false) => Some("linux-arm64-gnu"),
        ("linux", "aarch64", true) => Some("linux-arm64-musl"),
        ("linux", "x86_64", false) => Some("linux-x64-gnu"),
        ("linux", "x86_64", true) => Some("linux-x64-musl"),
        _ => None,
    }
}

/// `hookScript(directory, { skipInCI, target })`.
fn dispatcher(directory: &str, skip_in_ci: bool, target: &str) -> String {
    let segments = directory.split('/').filter(|segment| !segment.is_empty() && *segment != ".").count();
    let guard =
        if skip_in_ci { "{ [ -n \"${CI-}\" ] && [ \"${VIS_GIT_HOOKS-}\" != \"1\" ]; } && exit 0\n" } else { "" };

    DISPATCHER
        .replace("@CI_GUARD@\n", &format!("{guard}\n"))
        .replace("@DEPTH@", &(segments + 2).to_string())
        .replace("@BINDING@", &format!(" \"$p\"/../vis-binding-{target}/vis-native-cli"))
}

/// Whether husky or prek is set up in `root`: Node asks whether to migrate it, which needs a terminal.
fn other_tool_present(root: &Path) -> bool {
    HUSKY_DIRECTORIES.iter().any(|directory| root.join(directory).is_dir())
        || PREK_CONFIG_FILES.iter().any(|file| root.join(file).exists())
}

/// `loadHookConfig(cwd, directory)?.skipInCI ?? false`, or `None` when the file is one this module does not read like
/// Node does (Node catches every error and answers `false`, which is not worth guessing at).
fn skip_in_ci(root: &Path, directory: &str) -> Option<bool> {
    match fs::read(root.join(directory).join("config.json")) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Some(false),
        Err(_) => None,
        Ok(bytes) => {
            let value = serde_json::from_str::<Value>(&String::from_utf8(bytes).ok()?).ok()?;

            Some(config::parse(&value)?.skip_in_ci)
        }
    }
}

/// `writeFileSync(path, contents, { mode })`: the file is opened for writing and truncated, created with `mode` (less the
/// umask) when it is new, and keeps its mode when it is not.
fn write_file(path: &Path, contents: &str, mode: u32) -> io::Result<()> {
    OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(path)?.write_all(contents.as_bytes())
}

/// `writeDispatcher`: the `_` directory with `.gitignore`, `h` and one stub per stage.
fn write_dispatcher(internal: &Path, script: &str) -> io::Result<()> {
    fs::create_dir_all(internal)?;
    write_file(&internal.join(".gitignore"), "*", 0o666)?;
    write_file(&internal.join("h"), script, 0o755)?;

    for stage in STAGES {
        write_file(&internal.join(stage), STAGE_STUB, 0o755)?;
    }

    Ok(())
}

/// Whether `path` is a symbolic link that leads nowhere, which `writeFileSync` would write through.
fn is_dangling(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok() && fs::metadata(path).is_err()
}

/// The text Node prints, after the files are written; `None` when Node has to answer.
fn install(args: &[String]) -> Option<String> {
    let directory = parse(args, "install")?;

    // Node refuses any `..` in the directory, inside a segment included (`a..b`), which `parse` lets through.
    if directory.contains("..") || !context_is_native() {
        return None;
    }

    let cwd = env::current_dir().ok()?;
    let intro = format!("Installing git hooks in {directory}/...\n");

    if other_tool_present(&cwd) || fs::symlink_metadata(cwd.join(LEGACY_HOOKS_DIRECTORY)).is_ok() {
        return None;
    }

    if env::var_os("VIS_GIT_HOOKS").is_some_and(|value| value == "0") {
        return Some(format!("{intro}skip install (git hooks disabled via VIS_GIT_HOOKS=0)\n"));
    }

    match git(&cwd, &["rev-parse", "--show-prefix"])? {
        Git::Unavailable => return None,
        Git::Failed => return Some(format!("{intro}.git directory not found (not a git repository)\n")),
        Git::Text(prefix) if !prefix.is_empty() => return None,
        Git::Text(_) => {}
    }

    let top_level = match git(&cwd, &["rev-parse", "--show-toplevel"])? {
        Git::Text(path) if !path.is_empty() => PathBuf::from(path),
        _ => cwd.clone(),
    };
    let target = format!("{directory}/_");

    // `arbitrateHooksPath`: only a value that is unset here, or already names this dispatcher, is ours to keep.
    let existing = repository_hooks_path(&cwd)?;

    if !existing.is_empty() && existing != target {
        return None;
    }

    // `dispatcherDirectories`: one checkout, the one this runs in.
    if checkout_roots(&top_level)? != [top_level.clone()] {
        return None;
    }

    let platform = binding_target(env::consts::OS, env::consts::ARCH, cfg!(target_env = "musl"))?;
    let script = dispatcher(&directory, skip_in_ci(&cwd, &directory)?, platform);
    let pre_commit = cwd.join(&directory).join("pre-commit");

    if is_dangling(&pre_commit) {
        return None;
    }

    // Nothing is decided after this point; a failed write is Node's to report (see the module documentation).
    write_dispatcher(&top_level.join(&target), &script).ok()?;

    if repository_hooks_path(&cwd)? != target {
        let status = Command::new("git")
            .args(["config", "core.hooksPath", &target])
            .current_dir(&cwd)
            .stderr(Stdio::null())
            .status()
            .ok()?;

        if !status.success() {
            return None;
        }
    }

    if !pre_commit.exists() {
        write_file(&pre_commit, "#!/usr/bin/env sh\n", 0o755).ok()?;
    }

    Some(format!("{intro}Git hooks installed successfully.\n"))
}

/// Answers `vis hook install` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(text) = install(args) else { crate::process::delegate(raw_args) };

    write_stdout("hook", "the hook installation", &text);

    exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_published_platform_has_its_binding_package() {
        for (os, arch, musl, slug) in [
            ("macos", "aarch64", false, "darwin-arm64"),
            ("macos", "x86_64", false, "darwin-x64"),
            ("linux", "aarch64", false, "linux-arm64-gnu"),
            ("linux", "aarch64", true, "linux-arm64-musl"),
            ("linux", "x86_64", false, "linux-x64-gnu"),
            ("linux", "x86_64", true, "linux-x64-musl"),
        ] {
            assert_eq!(binding_target(os, arch, musl), Some(slug), "{os} {arch} {musl}");
        }

        assert_eq!(binding_target("linux", "riscv64", false), None);
        assert_eq!(binding_target("freebsd", "x86_64", false), None);
        assert_eq!(binding_target("windows", "x86_64", false), None, "Windows is Node's");
    }

    #[test]
    fn the_dispatcher_counts_the_directory_segments_and_names_the_binding() {
        let plain = dispatcher(".vis/hooks", false, "darwin-arm64");

        assert!(plain.contains("\ni=4\n"), "two segments and the two of `_/h`");
        assert!(plain.contains(" \"$p\"/../vis-binding-darwin-arm64/vis-native-cli; do"));
        assert!(plain.contains("exit 0\n\nd=$0\n"), "no guard leaves one blank line");
        assert!(plain.ends_with("exit $c"), "no trailing newline");
        assert!(!plain.contains("@CI_GUARD@") && !plain.contains("@DEPTH@") && !plain.contains("@BINDING@"));

        assert!(dispatcher(".githooks", false, "x").contains("\ni=3\n"));
        assert!(dispatcher("./a//b/.c", false, "x").contains("\ni=5\n"), "empty and `.` segments do not count");
    }

    #[test]
    fn the_ci_guard_sits_after_the_disable_switch() {
        let guarded = dispatcher(".vis/hooks", true, "x");

        assert!(guarded
            .contains("exit 0\n{ [ -n \"${CI-}\" ] && [ \"${VIS_GIT_HOOKS-}\" != \"1\" ]; } && exit 0\n\nd=$0\n"));
    }
}
