use super::{validate_pm, yarn_foreach_prefix, ResolvedCommand};

/// Options for `resolve_exec`.
#[derive(Clone, Debug, Default)]
pub struct ExecOptions {
    pub command: String,
    pub args: Vec<String>,
    pub shell_mode: bool,
    pub recursive: bool,
    pub workspace_root: bool,
    pub parallel: bool,
    pub reverse: bool,
    pub filter: Vec<String>,
}

/// Refuse the selection flags of `vis exec` for a manager that runs one binary once in the current directory
/// (`bunx`, the `npx` stand-in for yarn classic): each would be dropped and the command would still exit 0.
fn refuse_exec_flags(pm: &str, runner: &str, opts: &ExecOptions, shell_mode: bool) -> Result<(), String> {
    let flags: Vec<&str> = [
        (opts.recursive, "--recursive"),
        (!opts.filter.is_empty(), "--filter"),
        (opts.workspace_root, "--workspace-root"),
        (opts.parallel, "--parallel"),
        (opts.reverse, "--reverse"),
        (shell_mode && opts.shell_mode, "--shell-mode"),
    ]
    .into_iter()
    .filter_map(|(set, flag)| set.then_some(flag))
    .collect();

    if flags.is_empty() {
        return Ok(());
    }

    Err(format!(
        "{pm} cannot honour {} for `vis exec`: it runs {runner} once in the current directory.",
        flags.join(", ")
    ))
}

/// `--reverse` only reorders a recursive run, and only pnpm (and aube) can; elsewhere it would be dropped.
fn reject_reverse(pm: &str, opts: &ExecOptions) -> Result<(), String> {
    if opts.reverse {
        return Err(format!("{pm} has no --reverse for `vis exec`; only pnpm can run workspaces in reverse order."));
    }

    Ok(())
}

/// Resolve `vis exec <command>` to the PM-specific invocation.
pub fn resolve_exec(pm: &str, version: &str, opts: ExecOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();
    let mut bin = pm.to_owned();

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }

            args.push("exec".into());

            if opts.recursive {
                args.push("--recursive".into());
            }

            if opts.workspace_root {
                args.push("-w".into());
            }

            if opts.parallel {
                args.push("--parallel".into());
            }

            if opts.reverse {
                args.push("--reverse".into());
            }

            if opts.shell_mode {
                args.push("-c".into());
            }

            args.push(opts.command);
            args.extend(opts.args);
        }
        "npm" => {
            reject_reverse(pm, &opts)?;
            args.push("exec".into());

            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }

            if opts.recursive {
                args.push("--workspaces".into());
            }

            if opts.workspace_root {
                args.push("--include-workspace-root".into());
            }

            // npm's `-c` is `--call <String>` and takes the next token, so the command has to ride in
            // the same argument; `npm exec` refuses extra arguments next to `--call`, which stays loud.
            if opts.shell_mode {
                args.push(format!("--call={}", opts.command));

                if !opts.args.is_empty() {
                    args.push("--".into());
                }
            } else {
                args.push("--".into());
                args.push(opts.command);
            }

            args.extend(opts.args);
        }
        "yarn" => {
            reject_reverse(pm, &opts)?;

            if version.starts_with("1.") {
                refuse_exec_flags("yarn v1", "`npx <command>`", &opts, false)?;
                warnings.push("yarn v1 does not support exec. Falling back to npx.".into());
                bin = "npx".into();

                if opts.shell_mode {
                    args.push("-c".into());
                }

                args.push(opts.command);
                args.extend(opts.args);
            } else {
                if opts.recursive || !opts.filter.is_empty() {
                    yarn_foreach_prefix(&opts.filter, &mut args);

                    if opts.parallel {
                        args.push("--parallel".into());
                    }
                }

                args.push("exec".into());
                args.push(opts.command);
                args.extend(opts.args);
            }
        }
        "bun" => {
            refuse_exec_flags("bun", "`bunx <command>`", &opts, true)?;

            bin = "bunx".into();
            args.push(opts.command);
            args.extend(opts.args);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { bin, args, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolve::argv;

    fn exec(command: &str) -> ExecOptions {
        ExecOptions { command: command.to_owned(), ..Default::default() }
    }

    #[test]
    fn unsupported_pm_errors() {
        assert!(resolve_exec("cargo", "1.0.0", exec("x")).is_err());
    }

    #[test]
    fn pnpm_exec_basic() {
        let resolved = resolve_exec("pnpm", "9.0.0", exec("eslint")).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["exec", "eslint"]);
    }

    #[test]
    fn pnpm_exec_with_filter_and_recursive() {
        let opts = ExecOptions {
            command: "eslint".to_owned(),
            args: vec![".".to_owned()],
            filter: vec!["@scope/pkg".to_owned()],
            recursive: true,
            ..Default::default()
        };

        let resolved = resolve_exec("pnpm", "9.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["--filter", "@scope/pkg", "exec", "--recursive", "eslint", "."]);
    }

    #[test]
    fn npm_exec_inserts_separator() {
        let resolved = resolve_exec("npm", "10.0.0", exec("tsc")).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args, ["exec", "--", "tsc"]);
    }

    #[test]
    fn yarn_v1_falls_back_to_npx() {
        let resolved = resolve_exec("yarn", "1.22.0", exec("eslint")).unwrap();

        assert_eq!(resolved.bin, "npx");
        assert_eq!(resolved.args, ["eslint"]);
        assert!(!resolved.warnings.is_empty());
    }

    #[test]
    fn bun_uses_bunx() {
        let resolved = resolve_exec("bun", "1.1.0", exec("eslint")).unwrap();

        assert_eq!(resolved.bin, "bunx");
        assert_eq!(resolved.args, ["eslint"]);
    }

    #[test]
    fn exec_npm_shell_mode_passes_the_command_as_a_call_value() {
        let opts = ExecOptions {
            command: "eslint . && tsc".to_owned(),
            shell_mode: true,
            recursive: true,
            ..Default::default()
        };

        assert_eq!(
            resolve_exec("npm", "10.0.0", opts).unwrap().args,
            ["exec", "--workspaces", "--call=eslint . && tsc"]
        );
    }

    #[test]
    fn exec_reverse_is_passed_to_pnpm_and_refused_where_it_has_no_effect() {
        let opts =
            || ExecOptions { command: "eslint".to_owned(), recursive: true, reverse: true, ..Default::default() };

        assert_eq!(
            resolve_exec("pnpm", "10.0.0", opts()).unwrap().args,
            ["exec", "--recursive", "--reverse", "eslint"]
        );

        for (pm, version) in [("npm", "10.0.0"), ("yarn", "4.5.0"), ("yarn", "1.22.0")] {
            let error = resolve_exec(pm, version, opts()).unwrap_err();

            assert!(error.contains("--reverse"), "{pm} {version}: {error}");
        }
    }

    #[test]
    fn exec_on_yarn_classic_refuses_the_flags_npx_cannot_honour() {
        let flagged = |tweak: fn(&mut ExecOptions)| {
            let mut opts = exec("eslint");

            tweak(&mut opts);

            resolve_exec("yarn", "1.22.0", opts)
        };

        assert!(flagged(|opts| opts.recursive = true).unwrap_err().contains("--recursive"));
        assert!(flagged(|opts| opts.filter = argv(&["app"])).unwrap_err().contains("--filter"));
        assert!(flagged(|opts| opts.workspace_root = true).unwrap_err().contains("--workspace-root"));
        assert!(flagged(|opts| opts.parallel = true).unwrap_err().contains("--parallel"));
        assert_eq!(flagged(|opts| opts.shell_mode = true).unwrap().args, ["-c", "eslint"]);
    }

    #[test]
    fn exec_on_bun_refuses_the_flags_bunx_cannot_honour() {
        let flagged = |tweak: fn(&mut ExecOptions)| {
            let mut opts = exec("eslint");

            tweak(&mut opts);

            resolve_exec("bun", "1.1.0", opts)
        };

        assert!(flagged(|opts| opts.recursive = true).unwrap_err().contains("--recursive"));
        assert!(flagged(|opts| opts.filter = argv(&["app"])).unwrap_err().contains("--filter"));
        assert!(flagged(|opts| opts.workspace_root = true).unwrap_err().contains("--workspace-root"));
        assert!(flagged(|opts| opts.parallel = true).unwrap_err().contains("--parallel"));
        assert!(flagged(|opts| opts.reverse = true).unwrap_err().contains("--reverse"));
        assert!(flagged(|opts| opts.shell_mode = true).unwrap_err().contains("--shell-mode"));
        assert!(flagged(|_| {}).is_ok());
    }
}
