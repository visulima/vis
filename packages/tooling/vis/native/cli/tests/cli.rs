//! Integration tests for the `vis` CLI front-end binary.
//!
//! These drive the compiled binary (`CARGO_BIN_EXE_vis`, injected by Cargo) and
//! assert the hermetic, cross-platform legs of the dispatch shell: native output
//! and the two delegation failure modes. The happy-path delegation (argv
//! passthrough + exit-code forwarding through a real Node) is covered by the
//! vitest integration test, which has Node available.

use std::process::Command;

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_vis"))
}

#[test]
fn native_info_prints_diagnostics_and_injected_version() {
    let output = binary().arg("__native-info").env("VIS_VERSION", "9.9.9-test").output().expect("run binary");

    assert!(output.status.success(), "expected exit 0, got {:?}", output.status);

    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(stdout.contains("vis native front-end"), "stdout was: {stdout}");
    assert!(stdout.contains("9.9.9-test"), "injected VIS_VERSION missing: {stdout}");
}

#[test]
fn version_prints_bare_injected_semver() {
    let output = binary().arg("--version").env("VIS_VERSION", "1.2.3-alpha.7").output().expect("run binary");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "1.2.3-alpha.7\n");
}

#[test]
fn pm_shim_rejects_unknown_shim() {
    let output = binary().args(["__pm-shim", "bogus", "install"]).output().expect("run binary");

    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("is not a known package-manager shim"));
}

#[test]
fn pm_shim_refuses_top_level_mismatch() {
    // A throwaway project pinned to pnpm via its lockfile; invoking the `npm`
    // shim there must be refused. Cleared PM env vars so the run is not "nested".
    let directory = std::env::temp_dir().join(format!("vis-pmshim-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("mkdir");
    std::fs::write(directory.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").expect("write lock");

    let output = binary()
        .args(["__pm-shim", "npm", "install"])
        .current_dir(&directory)
        .env_remove("npm_config_user_agent")
        .env_remove("npm_execpath")
        .output()
        .expect("run binary");

    std::fs::remove_dir_all(&directory).ok();

    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("this project uses pnpm"));
}

#[cfg(unix)]
#[test]
fn exec_resolves_and_runs_via_detected_pm() {
    use std::os::unix::fs::PermissionsExt;

    // A throwaway project pinned to pnpm (lockfile) + a stub `pnpm` on PATH that
    // echoes its argv, so we can assert the resolved invocation end to end.
    let base = std::env::temp_dir().join(format!("vis-exec-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(project.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();

    let stub = bindir.join("pnpm");
    std::fs::write(&stub, "#!/bin/sh\necho \"PNPM:$*\"\n").unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

    let path = format!("{}:{}", bindir.display(), std::env::var("PATH").unwrap_or_default());

    // Tool flags after the command are forwarded to the tool (verified to match
    // the fixed Node handler). resolve_exec maps pnpm -> `exec <command> <args>`.
    let output = binary()
        .args(["exec", "eslint", "--fix"])
        .current_dir(&project)
        .env("PATH", path)
        .env_remove("npm_config_user_agent")
        .env_remove("VIS_RUNTIME")
        .output()
        .expect("run binary");

    std::fs::remove_dir_all(&base).ok();

    assert!(output.status.success(), "exec failed: {:?}", output);
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "PNPM:exec eslint --fix");
}

#[cfg(unix)]
#[test]
fn pm_passthrough_resolves_and_forwards_flags() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-pm-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(project.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();

    let stub = bindir.join("pnpm");
    std::fs::write(&stub, "#!/bin/sh\necho \"PNPM:$*\"\n").unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

    let path = format!("{}:{}", bindir.display(), std::env::var("PATH").unwrap_or_default());

    let run = |sub: &[&str]| {
        String::from_utf8_lossy(
            &binary()
                .arg("pm")
                .args(sub)
                .current_dir(&project)
                .env("PATH", &path)
                .env_remove("npm_config_user_agent")
                .env_remove("VIS_RUNTIME")
                .output()
                .expect("run binary")
                .stdout,
        )
        .trim()
        .to_owned()
    };

    // `cache dir` -> pnpm store path; flags after the subcommand forwarded.
    let cache = run(&["cache", "dir"]);
    let publish = run(&["publish", "--dry-run"]);

    std::fs::remove_dir_all(&base).ok();

    assert_eq!(cache, "PNPM:store path");
    assert_eq!(publish, "PNPM:publish --dry-run");
}

#[cfg(unix)]
#[test]
fn x_spawns_node_with_the_preload_import() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-x-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(project.join("app.ts"), "export {};\n").unwrap();

    // Stub "node" that echoes its argv so we can assert the constructed command.
    let stub_node = bindir.join("node");
    std::fs::write(&stub_node, "#!/bin/sh\necho \"NODE:$*\"\n").unwrap();
    std::fs::set_permissions(&stub_node, std::fs::Permissions::from_mode(0o755)).unwrap();

    let fallback = base.join("dist").join("bin.js");
    std::fs::create_dir_all(fallback.parent().unwrap()).unwrap();

    let output = binary()
        .args(["x", "app.ts", "--flag"])
        .current_dir(&project)
        .env("VIS_NODE", &stub_node)
        .env("VIS_FALLBACK_ENTRY", &fallback)
        .env_remove("VIS_RUNTIME")
        .env_remove("VIS_UNFLAG")
        .env_remove("VIS_AUGMENT_SUBPROCESS")
        .env_remove("npm_config_user_agent")
        .output()
        .expect("run binary");

    let preload = base.join("dist").join("runtime").join("preload.js");
    let stdout = String::from_utf8_lossy(&output.stdout);

    std::fs::remove_dir_all(&base).ok();

    assert!(output.status.success(), "x failed: {:?}", output);
    // node --import <dist/runtime/preload.js> <abs app.ts> --flag
    assert!(stdout.contains(&format!("--import {}", preload.display())), "stdout: {stdout}");
    assert!(stdout.contains(&project.join("app.ts").display().to_string()), "stdout: {stdout}");
    assert!(stdout.contains("--flag"), "stdout: {stdout}");
}

#[cfg(unix)]
#[test]
fn pm_family_remove_resolves_and_forwards() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-rm-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(project.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();

    let stub = bindir.join("pnpm");
    std::fs::write(&stub, "#!/bin/sh\necho \"PNPM:$*\"\n").unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

    let path = format!("{}:{}", bindir.display(), std::env::var("PATH").unwrap_or_default());

    let output = binary()
        .args(["remove", "-D", "lodash", "--unknown-flag"])
        .current_dir(&project)
        .env("PATH", path)
        .env_remove("npm_config_user_agent")
        .output()
        .expect("run binary");

    std::fs::remove_dir_all(&base).ok();

    assert!(output.status.success(), "remove failed: {:?}", output);
    // -D maps to pnpm `remove -D`; lodash + the unknown flag are forwarded.
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "PNPM:remove -D lodash --unknown-flag");
}

#[cfg(unix)]
#[test]
fn x_uses_bun_when_a_bun_lockfile_is_present() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-xbun-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(project.join("app.ts"), "export {};\n").unwrap();
    // A bun lockfile selects bun via the LOCKFILE-ONLY walk (not the PM detector).
    std::fs::write(project.join("bun.lock"), "{}\n").unwrap();

    let stub_bun = bindir.join("bun");
    std::fs::write(&stub_bun, "#!/bin/sh\necho \"BUN:$*\"\n").unwrap();
    std::fs::set_permissions(&stub_bun, std::fs::Permissions::from_mode(0o755)).unwrap();

    let path = format!("{}:{}", bindir.display(), std::env::var("PATH").unwrap_or_default());

    let output = binary()
        .args(["x", "app.ts", "--flag"])
        .current_dir(&project)
        .env("PATH", path)
        .env_remove("VIS_RUNTIME")
        .env_remove("VIS_UNFLAG")
        .env_remove("VIS_AUGMENT_SUBPROCESS")
        .output()
        .expect("run binary");

    std::fs::remove_dir_all(&base).ok();

    assert!(output.status.success(), "x bun failed: {:?}", output);
    let stdout = String::from_utf8_lossy(&output.stdout);
    // bun run <abs app.ts> --flag
    assert!(stdout.contains("BUN:run"), "stdout: {stdout}");
    assert!(stdout.contains("app.ts"), "stdout: {stdout}");
    assert!(stdout.contains("--flag"), "stdout: {stdout}");
}

#[test]
fn x_rejects_an_unsupported_explicit_runtime() {
    let output =
        binary().args(["x", "--runtime=python", "app.ts"]).env_remove("VIS_RUNTIME").output().expect("run binary");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("unsupported runtime 'python'"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[test]
fn x_delegates_when_pnp_is_at_a_parent_directory() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-xpnp-{}", std::process::id()));
    let project = base.join("project");
    let sub = project.join("sub");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(sub.join("app.ts"), "export {};\n").unwrap();
    // Yarn PnP marker sits at the project root, invocation runs from a subdir.
    std::fs::write(project.join(".pnp.cjs"), "// pnp\n").unwrap();

    let stub_node = bindir.join("node");
    std::fs::write(&stub_node, "#!/bin/sh\necho \"NODE:$*\"\n").unwrap();
    std::fs::set_permissions(&stub_node, std::fs::Permissions::from_mode(0o755)).unwrap();
    let fallback = base.join("dist").join("bin.js");
    std::fs::create_dir_all(fallback.parent().unwrap()).unwrap();

    let output = binary()
        .args(["x", "app.ts"])
        .current_dir(&sub)
        .env("VIS_NODE", &stub_node)
        .env("VIS_FALLBACK_ENTRY", &fallback)
        .env_remove("VIS_RUNTIME")
        .env_remove("VIS_UNFLAG")
        .env_remove("VIS_AUGMENT_SUBPROCESS")
        .output()
        .expect("run binary");

    let stdout = String::from_utf8_lossy(&output.stdout);

    std::fs::remove_dir_all(&base).ok();

    // Delegated to Node (not spawned directly): `node <fallback> x app.ts`.
    assert!(output.status.success(), "x pnp failed: {:?}", output);
    assert!(stdout.contains("NODE:"), "stdout: {stdout}");
    assert!(stdout.contains("x app.ts"), "stdout: {stdout}");
}

#[cfg(unix)]
#[test]
fn outdated_suppresses_exit_one_but_remove_does_not() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-exit1-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(project.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();

    // Stub pnpm that always exits 1 (mimics `outdated` finding results).
    let stub = bindir.join("pnpm");
    std::fs::write(&stub, "#!/bin/sh\necho \"PNPM:$*\"\nexit 1\n").unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

    let path = format!("{}:{}", bindir.display(), std::env::var("PATH").unwrap_or_default());
    let run = |verb: &str| {
        binary()
            .arg(verb)
            .current_dir(&project)
            .env("PATH", &path)
            .env_remove("npm_config_user_agent")
            .output()
            .expect("run binary")
            .status
            .code()
    };

    let outdated = run("outdated");
    let remove = run("remove");

    std::fs::remove_dir_all(&base).ok();

    // `outdated` maps exit 1 -> 0 (results found is not an error); `remove` does not.
    assert_eq!(outdated, Some(0), "outdated should suppress exit 1");
    assert_eq!(remove, Some(1), "remove should forward exit 1");
}

#[cfg(unix)]
#[test]
fn pm_family_delegates_when_vis_config_is_present() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-cfg-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(project.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();
    // A vis.config pins the backend the native detector can't read -> delegate.
    std::fs::write(project.join("vis.config.ts"), "export default { install: { backend: \"aube\" } };\n").unwrap();

    let stub_node = bindir.join("node");
    std::fs::write(&stub_node, "#!/bin/sh\necho \"NODE:$*\"\n").unwrap();
    std::fs::set_permissions(&stub_node, std::fs::Permissions::from_mode(0o755)).unwrap();
    let fallback = base.join("dist").join("bin.js");
    std::fs::create_dir_all(fallback.parent().unwrap()).unwrap();

    let output = binary()
        .args(["remove", "lodash"])
        .current_dir(&project)
        .env("VIS_NODE", &stub_node)
        .env("VIS_FALLBACK_ENTRY", &fallback)
        .env_remove("npm_config_user_agent")
        .output()
        .expect("run binary");

    let stdout = String::from_utf8_lossy(&output.stdout);

    std::fs::remove_dir_all(&base).ok();

    // Delegated to Node (honors the config-pinned backend), not run via pnpm.
    assert!(output.status.success(), "config delegate failed: {:?}", output);
    assert!(stdout.contains("NODE:"), "stdout: {stdout}");
    assert!(stdout.contains("remove lodash"), "stdout: {stdout}");
}

/// A vis.config that is plain data and pins no package-manager choice keeps the pm
/// command native: the Node stub must not run.
#[cfg(unix)]
#[test]
fn pm_family_stays_native_for_a_plain_vis_config() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-cfg-plain-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(project.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();
    std::fs::write(project.join("vis.config.ts"), "export default { lint: { enabled: true } };\n").unwrap();

    let stub_node = bindir.join("node");
    std::fs::write(&stub_node, "#!/bin/sh\necho \"NODE:$*\"\n").unwrap();
    std::fs::set_permissions(&stub_node, std::fs::Permissions::from_mode(0o755)).unwrap();

    let output = binary()
        .args(["remove", "lodash"])
        .current_dir(&project)
        .env("VIS_NODE", &stub_node)
        .env("VIS_FALLBACK_ENTRY", base.join("dist").join("bin.js"))
        // Only the stub directory on PATH: an `aube` installed on the machine would select the installer.
        .env("PATH", &bindir)
        .env_remove("VIS_INSTALLER")
        .env_remove("npm_config_user_agent")
        .output()
        .expect("run binary");

    let _ = std::fs::remove_dir_all(&base);

    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(!stdout.contains("NODE:"), "delegated to Node: {stdout}");
}

/// A global option that changes which config or workspace Node uses must reach Node, even
/// when the config is plain data.
#[cfg(unix)]
#[test]
fn pm_family_delegates_for_a_global_option_with_a_plain_vis_config() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-cfg-global-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(project.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();
    std::fs::write(project.join("vis.config.ts"), "export default { lint: { enabled: true } };\n").unwrap();

    let stub_node = bindir.join("node");
    std::fs::write(&stub_node, "#!/bin/sh\necho \"NODE:$*\"\n").unwrap();
    std::fs::set_permissions(&stub_node, std::fs::Permissions::from_mode(0o755)).unwrap();

    let output = binary()
        .args(["remove", "--config=./alternate.ts", "lodash"])
        .current_dir(&project)
        .env("VIS_NODE", &stub_node)
        .env("VIS_FALLBACK_ENTRY", base.join("dist").join("bin.js"))
        .env("PATH", &bindir)
        .env_remove("VIS_INSTALLER")
        .env_remove("npm_config_user_agent")
        .output()
        .expect("run binary");

    let _ = std::fs::remove_dir_all(&base);

    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(stdout.contains("NODE:"), "stayed native: {stdout}");
}

/// An ancestor `packageManager` pin makes Node run through Corepack, so a plain config stays with Node.
#[cfg(unix)]
#[test]
fn pm_family_delegates_for_an_ancestor_package_manager_pin() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("vis-cfg-pin-{}", std::process::id()));
    let project = base.join("project");
    let bindir = base.join("bin");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(base.join("package.json"), r#"{"packageManager":"pnpm@9.0.0"}"#).unwrap();
    std::fs::write(project.join("pnpm-lock.yaml"), "lockfileVersion: 9\n").unwrap();
    std::fs::write(project.join("vis.config.ts"), "export default { lint: { enabled: true } };\n").unwrap();

    let stub_node = bindir.join("node");
    std::fs::write(&stub_node, "#!/bin/sh\necho \"NODE:$*\"\n").unwrap();
    std::fs::set_permissions(&stub_node, std::fs::Permissions::from_mode(0o755)).unwrap();

    let output = binary()
        .args(["remove", "lodash"])
        .current_dir(&project)
        .env("VIS_NODE", &stub_node)
        .env("VIS_FALLBACK_ENTRY", base.join("dist").join("bin.js"))
        .env("PATH", &bindir)
        .env_remove("VIS_INSTALLER")
        .env_remove("VIS_RUNTIME")
        .output()
        .expect("run binary");

    let _ = std::fs::remove_dir_all(&base);

    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(stdout.contains("NODE:"), "stayed native: {stdout}");
}

#[test]
fn delegate_without_fallback_entry_exits_ex_software() {
    let output = binary().arg("run").env_remove("VIS_FALLBACK_ENTRY").output().expect("run binary");

    assert_eq!(output.status.code(), Some(70));

    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(stderr.contains("VIS_FALLBACK_ENTRY"), "stderr was: {stderr}");
}

#[test]
fn delegate_with_unlaunchable_node_exits_ex_software() {
    let output = binary()
        .arg("run")
        .env("VIS_FALLBACK_ENTRY", "/some/entry.js")
        .env("VIS_NODE", "/nonexistent/definitely/not/node")
        .output()
        .expect("run binary");

    assert_eq!(output.status.code(), Some(70));

    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(stderr.contains("failed to launch Node CLI"), "stderr was: {stderr}");
}

#[test]
fn no_color_flag_beats_force_color_in_help() {
    let output = binary()
        .args(["--help", "--no-color"])
        .env("FORCE_COLOR", "1")
        .env("COLUMNS", "100")
        .output()
        .expect("run binary");

    assert!(output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains('\u{1b}'), "colour codes leaked into --no-color output");
}

#[test]
fn help_for_an_unknown_command_reports_on_stderr_and_exits_zero() {
    let output = binary().args(["help", "frobnicate"]).env("VIS_VERSION", "1.2.3").output().expect("run binary");

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "vis v1.2.3\n");
    assert_eq!(String::from_utf8_lossy(&output.stderr), "Command \"frobnicate\" not found\n");
}

#[test]
fn help_group_filter_lists_only_that_group() {
    let output = binary().args(["help", "--group", "Git Hooks"]).env("COLUMNS", "100").output().expect("run binary");
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(output.status.success());
    assert!(stdout.contains("Available Git Hooks Commands"), "{stdout}");
    assert!(stdout.contains("hook install"));
    assert!(!stdout.contains("cache list"));
}

#[test]
fn tool_flag_commands_keep_their_help_flag_for_the_tool() {
    // `exec --help` belongs to the tool being run, so it must not render vis help.
    let output = binary()
        .args(["exec", "--help"])
        .env("VIS_NODE", "/nonexistent-node")
        .env_remove("VIS_FALLBACK_ENTRY")
        .output()
        .expect("run binary");

    assert!(!String::from_utf8_lossy(&output.stdout).contains("Command Positional Arguments"));
}

#[test]
fn command_help_is_answered_natively_without_a_node_fallback() {
    // `hook run --help` used to be handed to Node; the manifest renders it now, so it
    // works even when no fallback entry exists.
    let output = binary()
        .args(["hook", "run", "--help"])
        .env_remove("VIS_FALLBACK_ENTRY")
        .env("COLUMNS", "100")
        .output()
        .expect("run binary");
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("Run a specific hook stage against tracked files"), "{stdout}");
}

#[test]
fn complete_lists_every_command_for_the_first_word() {
    let output = binary().args(["complete", "--", ""]).output().expect("run binary");
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(output.status.success());

    for expected in ["run", "install", "cache", "release", "completion", "help"] {
        assert!(stdout.lines().any(|line| line.split('\t').next() == Some(expected)), "missing {expected}: {stdout}");
    }

    assert_eq!(stdout.lines().last(), Some(":4"));
}

#[test]
fn complete_narrows_by_prefix_and_reaches_subcommands() {
    let output = binary().args(["complete", "--", "cache", "pr"]).output().expect("run binary");

    assert_eq!(
        String::from_utf8_lossy(&output.stdout).lines().next().and_then(|line| line.split('\t').next()),
        Some("prune")
    );
}

#[test]
fn unknown_command_exits_one_and_names_the_closest_command() {
    let output = binary().arg("instal").env_remove("VIS_FALLBACK_ENTRY").output().expect("run binary");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());

    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(stderr.contains("Unknown command \"instal\". Did you mean \"install\"?"), "{stderr}");
}

#[test]
fn unknown_command_with_no_close_match_still_errors() {
    let output = binary().arg("frobnicate").env_remove("VIS_FALLBACK_ENTRY").output().expect("run binary");

    assert_eq!(output.status.code(), Some(1));

    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(stderr.contains("Unknown command \"frobnicate\"."), "{stderr}");
    assert!(!stderr.contains("Did you mean"), "{stderr}");
}

#[test]
fn command_groups_and_bare_migrate_still_reach_node() {
    // `vis migrate` (bare) opens an interactive flow in the Node CLI, and a parent such
    // as `cache` is a Node matter too: none of them may be turned into an error here.
    for args in [&["migrate"][..], &["cache"], &["cache", "--help"], &["docker"]] {
        let output = binary().args(args).env_remove("VIS_FALLBACK_ENTRY").output().expect("run binary");

        assert_eq!(
            output.status.code(),
            Some(70),
            "{args:?} must be delegated, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn dlx_help_after_a_global_flag_lists_the_full_global_options() {
    // Only `dlx` as the first argument takes the lean entry; `-v dlx` runs the full CLI.
    let lean = binary().args(["dlx", "--help"]).env("COLUMNS", "100").output().expect("run binary");
    let full = binary().args(["-v", "dlx", "--help"]).env("COLUMNS", "100").output().expect("run binary");

    assert!(!String::from_utf8_lossy(&lean.stdout).contains("--ca-cert"));
    assert!(String::from_utf8_lossy(&full.stdout).contains("--ca-cert"));
}

#[test]
fn known_commands_still_delegate_to_node() {
    let output = binary().arg("run").env_remove("VIS_FALLBACK_ENTRY").output().expect("run binary");

    assert_eq!(
        output.status.code(),
        Some(70),
        "a real command must reach the Node fallback, not the unknown-command error"
    );
}

#[cfg(unix)]
#[test]
fn a_binary_installed_in_a_package_overrides_inherited_delegation_variables() {
    let package = std::env::temp_dir().join(format!("vis-cli-owned-env-{}", std::process::id()));

    let _ = std::fs::remove_dir_all(&package);
    std::fs::create_dir_all(package.join("bin")).unwrap();
    std::fs::create_dir_all(package.join("dist")).unwrap();
    std::fs::write(package.join("dist/bin.js"), "").unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"@visulima/vis","version":"4.5.6"}"#).unwrap();
    // A hard link has no writable descriptor another test's fork could inherit
    // (which makes exec fail with "Text file busy"); fall back to a copy across devices.
    if std::fs::hard_link(env!("CARGO_BIN_EXE_vis"), package.join("bin/vis")).is_err() {
        std::fs::copy(env!("CARGO_BIN_EXE_vis"), package.join("bin/vis")).unwrap();
    }

    let output = Command::new(package.join("bin/vis"))
        .arg("__native-info")
        .env("VIS_FALLBACK_ENTRY", "/stale/parent/entry.js")
        .env("VIS_VERSION", "0.0.1-stale")
        .env("VIS_LAUNCHER", "node")
        .output()
        .expect("run binary");
    let overridden = Command::new(package.join("bin/vis"))
        .arg("__native-info")
        .env("VIS_FALLBACK_ENTRY_OVERRIDE", "/stub/entry.js")
        .output()
        .expect("run binary");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let entry = std::fs::canonicalize(package.join("dist/bin.js")).unwrap();

    let _ = std::fs::remove_dir_all(&package);

    assert!(output.status.success(), "status: {:?}", output.status);
    assert!(overridden.status.success(), "status: {:?}", overridden.status);
    assert!(stdout.contains(&entry.display().to_string()), "stdout was: {stdout}");
    assert!(stdout.contains("4.5.6"), "stdout was: {stdout}");
    assert!(!stdout.contains("stale"), "stdout was: {stdout}");
    assert!(
        String::from_utf8_lossy(&overridden.stdout).contains("/stub/entry.js"),
        "override ignored: {:?}",
        overridden.stdout
    );
}

/// Delegation must replace the native process rather than wait beside a child:
/// a parent that signals only the `vis` PID (a timeout, a kill) then reaches the
/// Node CLI itself. The stub "Node" prints its own PID, which must be the PID the
/// caller spawned.
#[cfg(unix)]
#[test]
fn delegation_replaces_the_native_process_so_the_child_has_its_pid() {
    use std::io::Read;
    use std::process::Stdio;

    let dir = std::env::temp_dir().join(format!("vis-cli-exec-in-place-{}", std::process::id()));

    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let entry = dir.join("entry.sh");

    std::fs::write(&entry, "echo $$\n").unwrap();

    let mut child = binary()
        .arg("run")
        .env("VIS_NODE", "/bin/sh")
        .env("VIS_FALLBACK_ENTRY", &entry)
        // Set both: when Cargo puts the binary under a built package, the located entry replaces VIS_FALLBACK_ENTRY.
        .env("VIS_FALLBACK_ENTRY_OVERRIDE", &entry)
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn binary");
    let pid = child.id();
    let mut stdout = String::new();

    child.stdout.take().unwrap().read_to_string(&mut stdout).unwrap();

    let status = child.wait().expect("wait for binary");

    let _ = std::fs::remove_dir_all(&dir);

    assert!(status.success(), "status: {status:?}");
    assert_eq!(stdout.trim(), pid.to_string(), "the delegated child must run as the spawned PID");
}
