use super::{validate_pm, ResolvedCommand};

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
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }
            if opts.workspace_root {
                args.push("-w".into());
            }
            args.push("install".into());
            if opts.frozen_lockfile {
                args.push("--frozen-lockfile".into());
            }
            if opts.prod {
                args.push("--prod".into());
            }
            if opts.dev {
                args.push("--dev".into());
            }
            if opts.no_optional {
                args.push("--no-optional".into());
            }
            if opts.force {
                args.push("--force".into());
            }
            if opts.ignore_scripts {
                args.push("--ignore-scripts".into());
            }
            if opts.lockfile_only {
                args.push("--lockfile-only".into());
            }
            if opts.offline {
                args.push("--offline".into());
            }
            if opts.silent {
                args.push("--silent".into());
            }
        }
        "npm" => {
            if opts.frozen_lockfile && opts.lockfile_only {
                warnings.push("npm ci and --package-lock-only are contradictory. Using ci.".into());
            }
            args.push(if opts.frozen_lockfile { "ci".into() } else { "install".into() });
            if opts.prod {
                args.push("--omit=dev".into());
            }
            if opts.no_optional {
                args.push("--omit=optional".into());
            }
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
            if opts.ignore_scripts {
                args.push("--ignore-scripts".into());
            }
            if opts.force {
                args.push("--force".into());
            }
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
                if opts.frozen_lockfile {
                    args.push("--frozen-lockfile".into());
                }
                if opts.prod {
                    args.push("--production".into());
                }
                if opts.ignore_scripts {
                    args.push("--ignore-scripts".into());
                }
                if opts.force {
                    args.push("--force".into());
                }
                if opts.offline {
                    args.push("--offline".into());
                }
                if opts.silent {
                    args.push("--silent".into());
                }
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
            if opts.frozen_lockfile {
                args.push("--frozen-lockfile".into());
            }
            if opts.prod {
                args.push("--production".into());
            }
            if opts.force {
                args.push("--force".into());
            }
            if opts.ignore_scripts {
                args.push("--ignore-scripts".into());
            }
            if opts.no_optional {
                args.push("--no-optional".into());
            }
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
