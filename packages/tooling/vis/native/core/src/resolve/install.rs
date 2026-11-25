use super::{push_each, push_flags, validate_pm, ResolvedCommand};

/// Options for `resolve_install`.
#[derive(Clone, Debug, Default)]
pub struct InstallOptions {
    pub frozen_lockfile: bool,
    pub prod: bool,
    pub dev: bool,
    pub no_optional: bool,
    pub force: bool,
    pub ignore_scripts: bool,
    pub lockfile_only: bool,
    pub offline: bool,
    pub silent: bool,
    pub recursive: bool,
    pub workspace_root: bool,
    pub filter: Vec<String>,
}

/// Resolve `vis install`.
pub fn resolve_install(pm: &str, version: &str, opts: InstallOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;
    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            push_each(&mut args, "--filter", &opts.filter);
            if opts.workspace_root {
                args.push("-w".into());
            }
            args.push("install".into());
            push_flags(
                &mut args,
                &[
                    (opts.frozen_lockfile, "--frozen-lockfile"),
                    (opts.prod, "--prod"),
                    (opts.dev, "--dev"),
                    (opts.no_optional, "--no-optional"),
                    (opts.force, "--force"),
                    (opts.ignore_scripts, "--ignore-scripts"),
                    (opts.lockfile_only, "--lockfile-only"),
                    (opts.offline, "--offline"),
                    (opts.silent, "--silent"),
                ],
            );
        }
        "npm" => {
            if opts.frozen_lockfile && opts.lockfile_only {
                warnings.push("npm ci and --package-lock-only are contradictory. Using ci.".into());
            }
            args.push(if opts.frozen_lockfile { "ci".into() } else { "install".into() });
            push_flags(&mut args, &[(opts.prod, "--omit=dev"), (opts.no_optional, "--omit=optional")]);
            push_each(&mut args, "--workspace", &opts.filter);
            push_flags(
                &mut args,
                &[
                    (opts.recursive, "--workspaces"),
                    (opts.workspace_root, "--include-workspace-root"),
                    (opts.ignore_scripts, "--ignore-scripts"),
                    (opts.force, "--force"),
                ],
            );
            if !opts.frozen_lockfile && opts.lockfile_only {
                args.push("--package-lock-only".into());
            }
            if opts.offline {
                args.push("--offline".into());
            }
            if opts.silent {
                args.push("--loglevel".into());
                args.push("silent".into());
            }
        }
        "yarn" => {
            if version.starts_with("1.") {
                args.push("install".into());
                push_flags(
                    &mut args,
                    &[
                        (opts.frozen_lockfile, "--frozen-lockfile"),
                        (opts.prod, "--production"),
                        (opts.ignore_scripts, "--ignore-scripts"),
                        (opts.force, "--force"),
                        (opts.offline, "--offline"),
                        (opts.silent, "--silent"),
                    ],
                );
            } else {
                args.push("install".into());
                if opts.frozen_lockfile {
                    args.push("--immutable".into());
                }
                if opts.ignore_scripts {
                    args.push("--mode".into());
                    args.push("skip-build".into());
                }
                if opts.lockfile_only {
                    args.push("--mode".into());
                    args.push("update-lockfile".into());
                }
                if opts.prod {
                    warnings.push("yarn berry --prod requires .yarnrc.yml configuration.".into());
                }
                if opts.offline {
                    args.push("--cached".into());
                }
            }
        }
        "bun" => {
            args.push("install".into());
            push_flags(
                &mut args,
                &[
                    (opts.frozen_lockfile, "--frozen-lockfile"),
                    (opts.prod, "--production"),
                    (opts.force, "--force"),
                    (opts.ignore_scripts, "--ignore-scripts"),
                    (opts.no_optional, "--no-optional"),
                ],
            );
        }
        _ => unreachable!(), // validate_pm already checked
    }

    Ok(ResolvedCommand { bin: pm.to_owned(), args, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_rejects_an_unknown_package_manager() {
        let error = resolve_install("deno", "1.0.0", InstallOptions::default()).unwrap_err();

        assert_eq!(error, "Unsupported package manager: 'deno'. Supported: pnpm, npm, yarn, bun");
    }

    #[test]
    fn install_pnpm_frozen_lockfile() {
        let opts = InstallOptions { frozen_lockfile: true, ..Default::default() };
        let resolved = resolve_install("pnpm", "10.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["install", "--frozen-lockfile"]);
    }

    #[test]
    fn install_npm_frozen_lockfile_uses_ci() {
        let opts = InstallOptions { frozen_lockfile: true, ..Default::default() };
        let resolved = resolve_install("npm", "11.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args[0], "ci");
    }
}
