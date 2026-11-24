//! Native commands that must end exactly where the Node CLI ends: a shape the native path cannot
//! reproduce is handed to Node before anything is printed, and the shapes it keeps print what Node prints.
//!
//! Every case runs the real binary in a scratch project with a from-scratch environment: a stub `node`
//! that prints `NODE:<argv>` (the delegation target), stub package managers that print `PNPM:<argv>`, and
//! nothing else on `PATH`.

#![cfg(unix)]

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// A scratch directory with a `project` to run in and a `bin` of stubs; removed on drop.
struct Scratch {
    base: PathBuf,
    project: PathBuf,
}

impl Scratch {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!("vis-parity-{}-{tag}", std::process::id()));
        let project = base.join("project");

        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(base.join("bin")).unwrap();

        let scratch = Self { base, project };

        scratch.stub("node", "echo \"NODE:$*\"");

        scratch
    }

    fn bin(&self) -> PathBuf {
        self.base.join("bin")
    }

    fn stub(&self, name: &str, body: &str) {
        let path = self.bin().join(name);

        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.project.join(relative);

        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_in(&self.project, args, &[])
    }

    fn run_with(&self, args: &[&str], env: &[(&str, &str)]) -> Output {
        self.run_in(&self.project, args, env)
    }

    /// Runs `vis <args>` in `directory` with only `PATH` (the stubs), the launcher's two variables and `env`.
    fn run_in(&self, directory: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();

        self.run_raw(directory, &args, env)
    }

    fn run_raw(&self, directory: &Path, args: &[OsString], env: &[(&str, &str)]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_vis"))
            .args(args)
            .current_dir(directory)
            .env_clear()
            .env("PATH", self.bin())
            .env("VIS_NODE", self.bin().join("node"))
            .env("VIS_FALLBACK_ENTRY", self.base.join("dist").join("bin.js"))
            .envs(env.iter().copied())
            .output()
            .expect("run binary")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The run was handed to Node: the stub printed the entry and the full invocation.
fn assert_delegated(output: &Output, invocation: &str) {
    let text = stdout(output);

    assert!(text.contains("NODE:"), "not delegated: {text} {}", stderr(output));
    assert!(text.trim_end().ends_with(invocation), "stdout: {text}");
}

/// A project that is a pnpm workspace root, with stub `pnpm` printing its argv.
fn pnpm_root(tag: &str) -> Scratch {
    let scratch = Scratch::new(tag);

    scratch.write("package.json", "{\"name\":\"root\"}");
    scratch.write("pnpm-lock.yaml", "lockfileVersion: 9\n");
    scratch.write("pnpm-workspace.yaml", "packages:\n  - \"packages/*\"\n");
    scratch.write("packages/app/package.json", "{\"name\":\"app\"}");
    scratch.stub("pnpm", "echo \"PNPM:$*\"");

    scratch
}

// ---- `vis pm` -----------------------------------------------------------------------------

#[test]
fn pm_runs_a_plain_subcommand_natively_at_the_root() {
    let scratch = pnpm_root("pm-plain");
    let output = scratch.run(&["pm", "cache", "dir"]);

    assert_eq!(stdout(&output), "PNPM:store path\n");
}

#[test]
fn pm_hands_the_cross_manager_dispatch_table_to_node() {
    for subcommand in [
        "audit", "config", "dist-tag", "login", "logout", "owner", "ping", "pkg", "plugin", "prune", "publish",
        "rebuild", "search", "token", "whoami",
    ] {
        let scratch = pnpm_root("pm-table");
        let output = scratch.run(&["pm", subcommand, "--flag"]);

        assert_delegated(&output, &format!("pm {subcommand} --flag"));
    }
}

#[test]
fn pm_below_the_workspace_root_is_left_to_node() {
    let scratch = pnpm_root("pm-below");
    let output = scratch.run_in(&scratch.project.join("packages").join("app"), &["pm", "pack"], &[]);

    assert_delegated(&output, "pm pack");
}

#[test]
fn pm_with_an_installer_chosen_by_the_environment_is_left_to_node() {
    let scratch = pnpm_root("pm-installer");
    let output = scratch.run_with(&["pm", "cache", "dir"], &[("VIS_INSTALLER", "npm")]);

    assert_delegated(&output, "pm cache dir");

    let scratch = pnpm_root("pm-aube");

    scratch.stub("aube", "exit 0");

    assert_delegated(&scratch.run(&["pm", "cache", "dir"]), "pm cache dir");
}

#[test]
fn pm_with_a_package_manager_pin_and_corepack_is_left_to_node() {
    let scratch = pnpm_root("pm-corepack");

    scratch.write("package.json", "{\"name\":\"root\",\"packageManager\":\"pnpm@9.0.0\"}");
    assert_eq!(stdout(&scratch.run(&["pm", "cache", "dir"])), "PNPM:store path\n", "no corepack, nothing to wrap");

    scratch.stub("corepack", "exit 0");
    assert_delegated(&scratch.run(&["pm", "cache", "dir"]), "pm cache dir");
}

#[test]
fn pm_with_a_config_backend_pin_is_left_to_node() {
    let scratch = pnpm_root("pm-config");

    scratch.write("vis.config.ts", "export default { install: { backend: \"npm\" } };\n");

    assert_delegated(&scratch.run(&["pm", "cache", "dir"]), "pm cache dir");
}

#[test]
fn pm_with_a_global_option_is_left_to_node() {
    let scratch = pnpm_root("pm-global");

    assert_delegated(&scratch.run(&["pm", "cache", "dir", "--cwd", "."]), "pm cache dir --cwd .");
}

// ---- `vis exec` ---------------------------------------------------------------------------

#[test]
fn exec_runs_through_the_package_manager_when_no_local_bin_exists() {
    let scratch = pnpm_root("exec-plain");

    assert_eq!(stdout(&scratch.run(&["exec", "eslint", "."])), "PNPM:exec eslint .\n");
}

#[test]
fn exec_with_a_local_bin_is_left_to_node() {
    let scratch = pnpm_root("exec-local");

    scratch.write("node_modules/.bin/eslint", "#!/bin/sh\n");

    assert_delegated(&scratch.run(&["exec", "eslint", "."]), "exec eslint .");

    // Node looks in the `.bin` of every ancestor, nearest first.
    let below = scratch.project.join("packages").join("app");

    assert_delegated(&scratch.run_in(&below, &["exec", "eslint"], &[]), "exec eslint");
}

#[test]
fn exec_with_a_local_bin_still_uses_the_manager_for_shapes_node_sends_there() {
    let scratch = pnpm_root("exec-local-recursive");

    scratch.write("node_modules/.bin/eslint", "#!/bin/sh\n");

    assert_eq!(stdout(&scratch.run(&["exec", "-r", "eslint"])), "PNPM:exec --recursive eslint\n");
}

#[test]
fn exec_with_a_runtime_node_rejects_is_left_to_node() {
    let flag = pnpm_root("exec-runtime-flag");

    assert_delegated(&flag.run(&["exec", "--runtime=deno", "eslint"]), "exec --runtime=deno eslint");

    let env = pnpm_root("exec-runtime-env");

    assert_delegated(&env.run_with(&["exec", "eslint"], &[("VIS_RUNTIME", "deno")]), "exec eslint");
}

#[test]
fn exec_skips_an_empty_runtime_flag_like_node() {
    // `--runtime=` is no request; the environment decides, and bun runs `bun x`.
    let scratch = pnpm_root("exec-runtime-empty");

    scratch.stub("bun", "echo \"BUN:$*\"");
    scratch.stub("bunx", "echo \"BUNX:$*\"");

    let output = scratch.run_with(&["exec", "--runtime=", "eslint"], &[("VIS_RUNTIME", "bun")]);

    assert_eq!(stdout(&output), "BUNX:eslint\n", "{}", stderr(&output));
}

// ---- `vis x` runtime -----------------------------------------------------------------

#[test]
fn x_takes_the_runtime_from_the_nearest_directory_with_a_lockfile() {
    let scratch = Scratch::new("x-nearest");

    scratch.stub("bun", "echo \"BUN:$*\"");
    scratch.write("bun.lock", "{}\n");
    scratch.write("examples/app/package-lock.json", "{}\n");
    scratch.write("examples/app/app.ts", "export {};\n");

    let app = scratch.project.join("examples").join("app");
    let output = scratch.run_in(&app, &["x", "app.ts"], &[]);

    assert!(stdout(&output).starts_with("NODE:--import "), "stdout: {}", stdout(&output));
    assert!(stdout(&output).contains("app.ts"));

    // Within one directory the bun lockfiles win.
    scratch.write("examples/app/bun.lockb", "");

    assert!(stdout(&scratch.run_in(&app, &["x", "app.ts"], &[])).starts_with("BUN:run "));
}

#[test]
fn x_reports_an_unknown_runtime_with_node_s_text() {
    let scratch = Scratch::new("x-unknown");
    let flag = scratch.run(&["x", "--runtime=deno", "app.ts"]);

    assert_eq!(flag.status.code(), Some(1));
    assert_eq!(stderr(&flag), "--runtime requested unknown runtime \"deno\". Supported: bun, node.\n");
    assert_eq!(stdout(&flag), "");

    let env = scratch.run_with(&["x", "app.ts"], &[("VIS_RUNTIME", "deno")]);

    assert_eq!(env.status.code(), Some(1));
    assert_eq!(stderr(&env), "VIS_RUNTIME requested unknown runtime \"deno\". Supported: bun, node.\n");
}

#[test]
fn x_skips_an_empty_runtime_flag_and_reads_the_environment() {
    let scratch = Scratch::new("x-empty");

    scratch.stub("bun", "echo \"BUN:$*\"");

    let output = scratch.run_with(&["x", "--runtime=", "app.ts"], &[("VIS_RUNTIME", "bun")]);

    assert!(stdout(&output).starts_with("BUN:run "), "stdout: {}", stdout(&output));

    // An empty flag and an empty variable are both no request: the lockfile walk decides.
    let output = scratch.run_with(&["x", "--runtime=", "app.ts"], &[("VIS_RUNTIME", "")]);

    assert!(stdout(&output).starts_with("NODE:--import "), "stdout: {}", stdout(&output));
}

// ---- the raw argv reaches Node --------------------------------------------------------

/// A stub `node` printing each argument after the entry, NUL-terminated, as raw bytes.
fn raw_node(scratch: &Scratch) {
    scratch.stub("node", "shift\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done");
}

fn non_utf8() -> OsString {
    OsString::from_vec(vec![b'x', 0xff, b'.', b't', b's'])
}

#[test]
fn x_delegates_non_utf8_argv_unchanged() {
    let scratch = Scratch::new("raw-x");

    raw_node(&scratch);

    let output = scratch.run_raw(&scratch.project, &["x".into(), "--node".into(), non_utf8()], &[]);

    assert_eq!(output.stdout, b"x\0--node\0x\xff.ts\0".to_vec());
}

#[test]
fn pm_family_delegates_non_utf8_argv_unchanged() {
    let scratch = pnpm_root("raw-family");

    raw_node(&scratch);
    scratch.write("vis.config.ts", "export default { lint: { enabled: true } };\n");

    // With a config in play, `--cwd` changes which workspace Node uses, so the call goes to Node with its bytes.
    let output = scratch.run_raw(&scratch.project, &["remove".into(), "--cwd".into(), non_utf8()], &[]);

    assert_eq!(output.stdout, b"remove\0--cwd\0x\xff.ts\0".to_vec());
}

#[test]
fn pm_delegates_non_utf8_argv_unchanged() {
    let scratch = pnpm_root("raw-pm");

    raw_node(&scratch);

    let output = scratch.run_raw(&scratch.project, &["pm".into(), "publish".into(), non_utf8()], &[]);

    assert_eq!(output.stdout, b"pm\0publish\0x\xff.ts\0".to_vec());
}

#[test]
fn exec_delegates_non_utf8_argv_unchanged() {
    let scratch = pnpm_root("raw-exec");

    raw_node(&scratch);
    scratch.write("node_modules/.bin/eslint", "");

    let output = scratch.run_raw(&scratch.project, &["exec".into(), "eslint".into(), non_utf8()], &[]);

    assert_eq!(output.stdout, b"exec\0eslint\0x\xff.ts\0".to_vec());
}

#[test]
fn advisories_delegates_non_utf8_argv_unchanged() {
    let scratch = Scratch::new("raw-advisories");

    raw_node(&scratch);

    // Not a CI context, so the status is Node's; the cache directory keeps its bytes.
    let args = [
        "advisories".into(),
        "bloom".into(),
        "status".into(),
        "--format".into(),
        "json".into(),
        "--cache-dir".into(),
        non_utf8(),
    ];
    let output = scratch.run_raw(&scratch.project, &args, &[]);

    assert_eq!(output.stdout, b"advisories\0bloom\0status\0--format\0json\0--cache-dir\0x\xff.ts\0".to_vec());
}

#[test]
fn hook_run_delegates_non_utf8_argv_unchanged() {
    let scratch = Scratch::new("raw-hook");

    raw_node(&scratch);

    // No hooks configuration here, so the runner hands the invocation over.
    let output = scratch.run_raw(&scratch.project, &["hook".into(), "run".into(), non_utf8()], &[]);

    assert_eq!(output.stdout, b"hook\0run\0x\xff.ts\0".to_vec());
}

// ---- `vis __pm-shim` ------------------------------------------------------------

#[test]
fn shim_guard_reads_only_the_pins_node_reads() {
    // None of these name npm, pnpm or yarn the way Node's `pinnedPm` does, so `npm` is dispatched.
    let cases: [(&str, &[(&str, &str)]); 4] = [
        ("bun-pin", &[("package.json", "{\"packageManager\":\"bun@1.1.0\"}")]),
        ("workspace-file", &[("pnpm-workspace.yaml", "packages: []\n")]),
        ("yarnrc", &[(".yarnrc.yml", "nodeLinker: node-modules\n"), ("package-lock.json", "{}\n")]),
        ("bun-lock", &[("bun.lock", "{}\n")]),
    ];

    for (tag, files) in cases {
        let scratch = Scratch::new(&format!("shim-{tag}"));

        scratch.stub("npm", "echo \"NPM:$*\"");

        for (name, content) in files {
            scratch.write(name, content);
        }

        let output = scratch.run(&["__pm-shim", "npm", "install"]);

        assert_eq!(stdout(&output), "NPM:install\n", "{tag}: {}", stderr(&output));
    }
}

#[test]
fn shim_guard_still_refuses_what_node_refuses() {
    let scratch = Scratch::new("shim-refuse");

    scratch.stub("npm", "echo \"NPM:$*\"");
    scratch.write("package.json", "{\"packageManager\":\"pnpm@9.0.0\"}");

    let output = scratch.run(&["__pm-shim", "npm", "install"]);

    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("this project uses pnpm, but `npm` was run."));

    // A package.json without a usable pin falls through to the lockfiles of the same directory.
    let scratch = Scratch::new("shim-refuse-lock");

    scratch.write("package.json", "{ not json");
    scratch.write("yarn.lock", "");

    assert_eq!(scratch.run(&["__pm-shim", "npm", "install"]).status.code(), Some(1));
}

#[test]
fn shim_exits_one_when_the_real_manager_dies_by_signal() {
    let scratch = Scratch::new("shim-signal");

    scratch.stub("npm", "kill -9 $$");

    assert_eq!(scratch.run(&["__pm-shim", "npm", "install"]).status.code(), Some(1));
}

#[test]
fn shim_reports_a_real_manager_that_cannot_start() {
    let scratch = Scratch::new("shim-spawn");

    // Found on PATH (a file) but not executable: the spawn fails, which is an error (exit 1), as in Node.
    std::fs::write(scratch.bin().join("npm"), "#!/bin/sh\n").unwrap();

    let output = scratch.run(&["__pm-shim", "npm", "install"]);

    assert!(stderr(&output).starts_with("vis shim: could not start npm: "), "stderr: {}", stderr(&output));
    assert_eq!(output.status.code(), Some(1));
}

// ---- a child killed by a signal ends the command with 1, as in Node ---------------------

#[test]
fn a_manager_killed_by_a_signal_ends_pm_exec_and_the_family_with_one() {
    let scratch = pnpm_root("signal");

    scratch.stub("pnpm", "kill -9 $$");

    for args in [&["pm", "cache", "dir"][..], &["exec", "eslint"], &["remove", "lodash"]] {
        assert_eq!(scratch.run(args).status.code(), Some(1), "vis {args:?}");
    }

    scratch.stub("bun", "kill -9 $$");
    scratch.write("bun.lock", "{}\n");
    scratch.write("app.ts", "");

    assert_eq!(scratch.run(&["x", "app.ts"]).status.code(), Some(1));
}

// ---- a stderr nobody reads is no panic ----------------------------------------------------

/// Runs `vis <args>` with stderr on a pipe whose reader has already exited (the write fails with
/// EPIPE) and returns the exit code the binary ended with, which a panic would turn into 101.
fn exit_code_with_unreadable_stderr(args: &str) -> i32 {
    let status_file =
        std::env::temp_dir().join(format!("vis-parity-stderr-{}-{}", std::process::id(), args.replace(' ', "_")));
    let script = format!("{{ sleep 0.3; \"$0\" {args} 2>&1 >/dev/null; echo $? >\"$1\"; }} | true");

    Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_vis"))
        .arg(&status_file)
        .env_clear()
        .output()
        .expect("run binary");

    let code = std::fs::read_to_string(&status_file).expect("exit code written").trim().parse().expect("exit code");

    let _ = std::fs::remove_file(&status_file);

    code
}

#[test]
fn rejecting_an_unknown_command_with_an_unreadable_stderr_does_not_panic() {
    assert_eq!(exit_code_with_unreadable_stderr("frobnicate"), 1);
}

#[test]
fn a_missing_help_target_with_an_unreadable_stderr_does_not_panic() {
    assert_eq!(exit_code_with_unreadable_stderr("help frobnicate"), 0);
}
