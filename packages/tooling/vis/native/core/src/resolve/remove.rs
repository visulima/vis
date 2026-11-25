use super::{
    push_each, push_flags, yarn_foreach_prefix, yarn_workspace_prefix, Manager, ResolveError, ResolvedCommand,
};

/// Options for `resolve_remove`.
#[derive(Clone, Debug, Default)]
pub struct RemoveOptions {
    pub packages: Vec<String>,
    pub save_dev: bool,
    pub global: bool,
    pub recursive: bool,
    pub workspace_root: bool,
    pub filter: Vec<String>,
}

/// Resolve `vis remove <packages>`.
pub fn resolve_remove(pm: &str, version: &str, opts: RemoveOptions) -> Result<ResolvedCommand, ResolveError> {
    let manager = Manager::new(pm, version)?;

    let mut args = Vec::new();
    let warnings = Vec::new();

    if opts.global && manager != Manager::Bun {
        let mut global = vec!["uninstall".to_owned(), "--global".to_owned()];
        global.extend(opts.packages);

        return Ok(ResolvedCommand { args: global, bin: "npm".into(), warnings });
    }

    match manager {
        Manager::Pnpm => {
            push_each(&mut args, "--filter", &opts.filter);

            if opts.workspace_root {
                args.push("-w".into());
            }

            args.push("remove".into());

            push_flags(&mut args, &[(opts.save_dev, "-D"), (opts.recursive, "--recursive")]);

            args.extend(opts.packages);
        }
        Manager::Npm => {
            args.push("uninstall".into());

            if opts.save_dev {
                args.push("--save-dev".into());
            }

            push_each(&mut args, "--workspace", &opts.filter);

            if opts.recursive {
                args.push("--workspaces".into());
            }

            if opts.workspace_root {
                // npm's `-w` is `--workspace` and consumes the next argument, so it cannot select the
                // root. Pin the root explicitly instead.
                args.push(
                    if opts.filter.is_empty() { "--workspaces=false" } else { "--include-workspace-root" }.into(),
                );
            }

            args.extend(opts.packages);
        }
        Manager::YarnClassic => {
            yarn_workspace_prefix(&opts.filter, &mut args)?;
            args.push("remove".into());
            args.extend(opts.packages);
        }
        Manager::YarnBerry => {
            if opts.recursive || opts.filter.len() > 1 {
                yarn_foreach_prefix(&opts.filter, &mut args);
            } else {
                yarn_workspace_prefix(&opts.filter, &mut args)?;
            }

            args.push("remove".into());
            args.extend(opts.packages);
        }
        Manager::Bun => {
            args.push("remove".into());

            if opts.global {
                args.push("--global".into());
            }

            args.extend(opts.packages);
        }
    }

    Ok(ResolvedCommand { args, bin: manager.bin().to_owned(), warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolve::argv;

    #[test]
    fn remove_pnpm_with_dev_and_global_maps_to_npm() {
        let opts = RemoveOptions { packages: vec!["lodash".to_owned()], global: true, ..Default::default() };
        let resolved = resolve_remove("pnpm", "9.0.0", opts).unwrap();

        // Global removal goes to npm uninstall --global.
        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args, ["uninstall", "--global", "lodash"]);

        let local = RemoveOptions { packages: vec!["lodash".to_owned()], save_dev: true, ..Default::default() };
        let resolved = resolve_remove("pnpm", "9.0.0", local).unwrap();

        assert_eq!(resolved.args, ["remove", "-D", "lodash"]);
    }

    #[test]
    fn remove_yarn_classic_rejects_multiple_filters() {
        let opts = RemoveOptions { packages: argv(&["react"]), filter: argv(&["app", "web"]), ..Default::default() };

        assert!(resolve_remove("yarn", "1.22.0", opts).is_err());
    }

    #[test]
    fn remove_yarn_berry_applies_the_filter_without_recursive() {
        let one = RemoveOptions { packages: argv(&["react"]), filter: argv(&["app"]), ..Default::default() };
        let many = RemoveOptions { packages: argv(&["react"]), filter: argv(&["app", "web"]), ..Default::default() };
        let recursive = RemoveOptions { packages: argv(&["react"]), recursive: true, ..Default::default() };

        assert_eq!(resolve_remove("yarn", "4.5.0", one).unwrap().args, ["workspace", "app", "remove", "react"]);
        assert_eq!(
            resolve_remove("yarn", "4.5.0", many).unwrap().args,
            ["workspaces", "foreach", "--all", "--include", "app", "--include", "web", "remove", "react"]
        );
        assert_eq!(
            resolve_remove("yarn", "4.5.0", recursive).unwrap().args,
            ["workspaces", "foreach", "--all", "remove", "react"]
        );
    }

    #[test]
    fn remove_npm_workspace_root_does_not_swallow_the_package_name() {
        let root = RemoveOptions { packages: argv(&["lodash"]), workspace_root: true, ..Default::default() };
        let with_filter = RemoveOptions {
            packages: argv(&["lodash"]),
            workspace_root: true,
            filter: argv(&["app"]),
            ..Default::default()
        };

        // npm's `-w` is `--workspace <name>`: it would take `lodash` as the workspace.
        assert_eq!(resolve_remove("npm", "10.0.0", root).unwrap().args, ["uninstall", "--workspaces=false", "lodash"]);
        assert_eq!(
            resolve_remove("npm", "10.0.0", with_filter).unwrap().args,
            ["uninstall", "--workspace", "app", "--include-workspace-root", "lodash"]
        );
    }
}
