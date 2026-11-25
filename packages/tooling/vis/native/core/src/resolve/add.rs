use super::{
    push_each, push_flags, yarn_foreach_prefix, yarn_workspace_prefix, Manager, ResolveError, ResolvedCommand,
};

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
pub fn resolve_add(pm: &str, version: &str, opts: AddOptions) -> Result<ResolvedCommand, ResolveError> {
    let manager = Manager::new(pm, version)?;
    let mut args = Vec::new();
    let warnings = Vec::new();

    // Global packages use npm exclusively (except bun, which ships a
    // native global-install path).
    if opts.global && manager != Manager::Bun {
        args.push("install".into());
        args.push("--global".into());
        push_flags(&mut args, &[(opts.save_dev, "--save-dev"), (opts.exact, "--save-exact")]);
        args.extend(opts.packages);
        return Ok(ResolvedCommand { bin: "npm".into(), args, warnings });
    }

    match manager {
        Manager::Pnpm => {
            push_each(&mut args, "--filter", &opts.filter);
            if opts.workspace_root {
                args.push("-w".into());
            }
            args.push("add".into());
            push_flags(
                &mut args,
                &[
                    (opts.save_dev, "-D"),
                    (opts.exact, "-E"),
                    (opts.peer, "--save-peer"),
                    (opts.optional, "-O"),
                    (opts.workspace, "--workspace"),
                ],
            );
            args.extend(opts.packages);
        }
        Manager::Npm => {
            args.push("install".into());
            push_flags(
                &mut args,
                &[
                    (opts.save_dev, "--save-dev"),
                    (opts.exact, "--save-exact"),
                    (opts.peer, "--save-peer"),
                    (opts.optional, "--save-optional"),
                ],
            );
            push_each(&mut args, "--workspace", &opts.filter);
            if opts.workspace_root {
                // npm's `-w` is `--workspace` and consumes the next argument, so it
                // cannot select the root. Pin the root explicitly instead.
                args.push(
                    if opts.filter.is_empty() { "--workspaces=false" } else { "--include-workspace-root" }.into(),
                );
            }
            args.extend(opts.packages);
        }
        Manager::YarnClassic => {
            yarn_workspace_prefix(&opts.filter, &mut args)?;
            args.push("add".into());
            push_flags(
                &mut args,
                &[
                    (opts.save_dev, "--dev"),
                    (opts.exact, "--exact"),
                    (opts.peer, "--peer"),
                    (opts.optional, "--optional"),
                    (opts.workspace_root, "-W"),
                ],
            );
            args.extend(opts.packages);
        }
        Manager::YarnBerry => {
            if opts.filter.len() > 1 {
                yarn_foreach_prefix(&opts.filter, &mut args);
            } else {
                yarn_workspace_prefix(&opts.filter, &mut args)?;
            }
            args.push("add".into());
            push_flags(
                &mut args,
                &[
                    (opts.save_dev, "--dev"),
                    (opts.exact, "--exact"),
                    (opts.peer, "--peer"),
                    (opts.optional, "--optional"),
                ],
            );
            args.extend(opts.packages);
        }
        Manager::Bun => {
            args.push("add".into());
            push_flags(
                &mut args,
                &[
                    (opts.save_dev, "--dev"),
                    (opts.exact, "--exact"),
                    (opts.peer, "--peer"),
                    (opts.optional, "--optional"),
                    (opts.global, "--global"),
                ],
            );
            args.extend(opts.packages);
        }
    }

    Ok(ResolvedCommand { bin: manager.bin().to_owned(), args, warnings })
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
