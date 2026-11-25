use super::{validate_pm, yarn_foreach_prefix, yarn_workspace_prefix, ResolvedCommand};

/// Options for `resolve_add`.
#[derive(Clone, Debug, Default)]
pub struct AddOptions {
    pub packages: Vec<String>,
    pub save_dev: bool,
    pub exact: bool,
    pub peer: bool,
    pub optional: bool,
    pub global: bool,
    pub workspace: bool,
    pub workspace_root: bool,
    pub filter: Vec<String>,
}

/// Resolve `vis add`.
pub fn resolve_add(pm: &str, version: &str, opts: AddOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;
    let mut args = Vec::new();
    let warnings = Vec::new();

    // Global packages use npm exclusively (except bun, which ships a
    // native global-install path).
    if opts.global && pm != "bun" {
        args.push("install".into());
        args.push("--global".into());
        if opts.save_dev {
            args.push("--save-dev".into());
        }
        if opts.exact {
            args.push("--save-exact".into());
        }
        args.extend(opts.packages);
        return Ok(ResolvedCommand { bin: "npm".into(), args, warnings });
    }

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }
            if opts.workspace_root {
                args.push("-w".into());
            }
            args.push("add".into());
            if opts.save_dev {
                args.push("-D".into());
            }
            if opts.exact {
                args.push("-E".into());
            }
            if opts.peer {
                args.push("--save-peer".into());
            }
            if opts.optional {
                args.push("-O".into());
            }
            if opts.workspace {
                args.push("--workspace".into());
            }
            args.extend(opts.packages);
        }
        "npm" => {
            args.push("install".into());
            if opts.save_dev {
                args.push("--save-dev".into());
            }
            if opts.exact {
                args.push("--save-exact".into());
            }
            if opts.peer {
                args.push("--save-peer".into());
            }
            if opts.optional {
                args.push("--save-optional".into());
            }
            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }
            if opts.workspace_root {
                // npm's `-w` is `--workspace` and consumes the next argument, so it
                // cannot select the root. Pin the root explicitly instead.
                args.push(
                    if opts.filter.is_empty() { "--workspaces=false" } else { "--include-workspace-root" }.into(),
                );
            }
            args.extend(opts.packages);
        }
        "yarn" => {
            if version.starts_with("1.") {
                yarn_workspace_prefix(&opts.filter, &mut args)?;
                args.push("add".into());
                if opts.save_dev {
                    args.push("--dev".into());
                }
                if opts.exact {
                    args.push("--exact".into());
                }
                if opts.peer {
                    args.push("--peer".into());
                }
                if opts.optional {
                    args.push("--optional".into());
                }
                if opts.workspace_root {
                    args.push("-W".into());
                }
                args.extend(opts.packages);
            } else {
                if opts.filter.len() > 1 {
                    yarn_foreach_prefix(&opts.filter, &mut args);
                } else {
                    yarn_workspace_prefix(&opts.filter, &mut args)?;
                }
                args.push("add".into());
                if opts.save_dev {
                    args.push("--dev".into());
                }
                if opts.exact {
                    args.push("--exact".into());
                }
                if opts.peer {
                    args.push("--peer".into());
                }
                if opts.optional {
                    args.push("--optional".into());
                }
                args.extend(opts.packages);
            }
        }
        "bun" => {
            args.push("add".into());
            if opts.save_dev {
                args.push("--dev".into());
            }
            if opts.exact {
                args.push("--exact".into());
            }
            if opts.peer {
                args.push("--peer".into());
            }
            if opts.optional {
                args.push("--optional".into());
            }
            if opts.global {
                args.push("--global".into());
            }
            args.extend(opts.packages);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { bin: pm.to_owned(), args, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolve::argv;

    #[test]
    fn add_pnpm_dev_dependency_with_filter_before_add() {
        let opts =
            AddOptions { packages: argv(&["react"]), save_dev: true, filter: argv(&["app"]), ..Default::default() };
        let resolved = resolve_add("pnpm", "10.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["--filter", "app", "add", "-D", "react"]);
    }

    #[test]
    fn add_npm_workspace_root_keeps_package_as_argument() {
        let opts = AddOptions { packages: argv(&["react"]), workspace_root: true, ..Default::default() };
        let resolved = resolve_add("npm", "11.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args, ["install", "--workspaces=false", "react"]);
    }

    #[test]
    fn add_npm_workspace_root_with_filter_includes_the_root() {
        let opts = AddOptions {
            packages: argv(&["react"]),
            workspace_root: true,
            filter: argv(&["app"]),
            ..Default::default()
        };
        let resolved = resolve_add("npm", "11.0.0", opts).unwrap();

        assert_eq!(resolved.args, ["install", "--workspace", "app", "--include-workspace-root", "react"]);
    }

    #[test]
    fn add_yarn_berry_routes_filter_to_the_workspace() {
        let opts =
            AddOptions { packages: argv(&["react"]), save_dev: true, filter: argv(&["app"]), ..Default::default() };
        let resolved = resolve_add("yarn", "4.5.0", opts).unwrap();

        assert_eq!(resolved.bin, "yarn");
        assert_eq!(resolved.args, ["workspace", "app", "add", "--dev", "react"]);
    }

    #[test]
    fn add_yarn_berry_fans_multiple_filters_out_with_foreach() {
        let opts = AddOptions { packages: argv(&["react"]), filter: argv(&["app", "web"]), ..Default::default() };
        let resolved = resolve_add("yarn", "4.5.0", opts).unwrap();

        assert_eq!(
            resolved.args,
            ["workspaces", "foreach", "--all", "--include", "app", "--include", "web", "add", "react"]
        );
    }

    #[test]
    fn add_yarn_classic_rejects_multiple_filters() {
        let opts = AddOptions { packages: argv(&["react"]), filter: argv(&["app", "web"]), ..Default::default() };

        assert!(resolve_add("yarn", "1.22.0", opts).is_err());
    }

    #[test]
    fn add_global_uses_npm_except_on_bun() {
        let global = |pm: &str, version: &str| {
            let opts = AddOptions { packages: argv(&["typescript"]), global: true, ..Default::default() };

            resolve_add(pm, version, opts).unwrap()
        };

        let pnpm = global("pnpm", "10.0.0");

        assert_eq!(pnpm.bin, "npm");
        assert!(pnpm.args.contains(&"--global".to_owned()));
        assert_eq!(global("bun", "1.0.0").bin, "bun");
    }
}
