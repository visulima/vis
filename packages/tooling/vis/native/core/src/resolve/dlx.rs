use super::{push_flags, validate_pm, ResolvedCommand};

/// Options for `resolve_dlx`.
#[derive(Clone, Debug, Default)]
pub struct DlxOptions {
    pub package: String,
    pub args: Vec<String>,
    pub additional_packages: Vec<String>,
    pub shell_mode: bool,
    pub silent: bool,
}

/// The executable `npm exec` runs for a package spec: the package name without its scope and
/// version (`@scope/pkg@1.0` -> `pkg`, `create-vite@6.0.0` -> `create-vite`). A spec with a `:`
/// is a git, URL or file location, where an `@` belongs to the location (`git@host`,
/// `user:token@host`) and is not a version separator, so only its last path segment is used.
fn npm_bin_name(spec: &str) -> String {
    let name = if spec.contains(':') {
        spec
    } else {
        let name_start = usize::from(spec.starts_with('@'));
        spec[name_start..].split('@').next().unwrap_or_default()
    };
    name.rsplit('/').next().unwrap_or_default().to_string()
}

/// The command to run for `spec` once `--package` names the packages to install: `--package` turns
/// the positional into a command, so the spec's bin has to be spelled out.
fn bin_of_spec(spec: &str) -> String {
    let bin = npm_bin_name(spec);

    if bin.is_empty() {
        spec.to_owned()
    } else {
        bin
    }
}

/// Resolve `vis dlx`.
pub fn resolve_dlx(pm: &str, version: &str, opts: DlxOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;
    let mut args = Vec::new();
    let mut warnings = Vec::new();
    let mut bin = pm.to_owned();
    // With `-p` extras the positional is a command and only the named packages are installed, so
    // the main package must be named as well. In shell mode the positional is the command line.
    let name_main = !opts.shell_mode && !opts.additional_packages.is_empty();
    let command = if name_main { bin_of_spec(&opts.package) } else { opts.package.clone() };

    match pm {
        "pnpm" => {
            args.push("dlx".into());
            for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                args.push("--package".into());
                args.push(pkg.clone());
            }
            push_flags(&mut args, &[(opts.shell_mode, "-c"), (opts.silent, "--silent")]);
            args.push(command);
            args.extend(opts.args);
        }
        "npm" => {
            args.push("exec".into());
            args.push("--yes".into());
            for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                args.push(format!("--package={pkg}"));
            }
            if opts.silent {
                args.push("--loglevel".into());
                args.push("silent".into());
            }
            // npm's `-c` is `--call <String>` and takes the next token, so the command rides in the same
            // argument. Without `--package`, npm reads the bin out of the package manifest itself; with
            // it, the positional is the command.
            if opts.shell_mode {
                args.push(format!("--call={}", opts.package));

                if !opts.args.is_empty() {
                    args.push("--".into());
                }
            } else {
                args.push("--".into());
                args.push(command);
            }
            args.extend(opts.args);
        }
        "yarn" => {
            if version.starts_with("1.") {
                warnings.push("yarn v1 does not support dlx. Falling back to npx.".into());
                bin = "npx".into();
                args.push("--yes".into());
                for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                    args.push("--package".into());
                    args.push(pkg.clone());
                }
                if opts.silent {
                    args.push("--quiet".into());
                }
                args.push(command);
                args.extend(opts.args);
            } else {
                args.push("dlx".into());
                for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                    args.push("-p".into());
                    args.push(pkg.clone());
                }
                if opts.shell_mode {
                    warnings.push("yarn berry does not support shell mode for dlx.".into());
                }
                if opts.silent {
                    args.push("--quiet".into());
                }
                args.push(command);
                args.extend(opts.args);
            }
        }
        "bun" => {
            args.push("x".into());
            for pkg in opts.additional_packages.iter().chain(name_main.then_some(&opts.package)) {
                args.push("--package".into());
                args.push(pkg.clone());
            }
            args.push(command);
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

    #[test]
    fn dlx_pnpm_and_bun() {
        let opts = || DlxOptions { package: "create-vite".to_owned(), args: argv(&["my-app"]), ..Default::default() };

        let pnpm = resolve_dlx("pnpm", "10.0.0", opts()).unwrap();
        let bun = resolve_dlx("bun", "1.0.0", opts()).unwrap();

        assert_eq!((pnpm.bin.as_str(), pnpm.args), ("pnpm", argv(&["dlx", "create-vite", "my-app"])));
        assert_eq!((bun.bin.as_str(), bun.args[0].as_str()), ("bun", "x"));
    }

    #[test]
    fn dlx_npm_with_extras_runs_the_bin_without_the_version() {
        let bin_for = |package: &str| {
            let opts = DlxOptions {
                package: package.to_owned(),
                additional_packages: argv(&["typescript"]),
                ..Default::default()
            };
            let resolved = resolve_dlx("npm", "11.0.0", opts).unwrap();

            (resolved.args[resolved.args.len() - 2..].to_vec(), resolved.args)
        };

        let (tail, args) = bin_for("create-vite@6.0.0");
        assert_eq!(tail, ["--", "create-vite"]);
        assert!(args.contains(&"--package=create-vite@6.0.0".to_owned()));

        assert_eq!(bin_for("create-vite").0, ["--", "create-vite"]);
        assert_eq!(bin_for("@scope/tool@1.2.3").0, ["--", "tool"]);
        assert_eq!(bin_for("@scope/tool").0, ["--", "tool"]);
    }

    #[test]
    fn npm_bin_name_keeps_the_location_of_a_git_or_url_spec_out_of_the_version_split() {
        for (spec, bin) in [
            ("git+ssh://git@github.com/org/tool.git", "tool.git"),
            ("git@github.com:org/tool.git", "tool.git"),
            ("https://user:token@host.example/pkg.tgz", "pkg.tgz"),
            ("create-vite@6.0.0", "create-vite"),
            ("@scope/tool@1.2.3", "tool"),
        ] {
            assert_eq!(npm_bin_name(spec), bin, "{spec}");
        }
    }

    #[test]
    fn dlx_yarn_v1_falls_back_to_npx() {
        let opts = DlxOptions { package: "create-vite".to_owned(), ..Default::default() };
        let resolved = resolve_dlx("yarn", "1.22.0", opts).unwrap();

        assert_eq!(resolved.bin, "npx");
    }

    #[test]
    fn dlx_npm_lets_npm_pick_the_bin_when_no_extra_packages_are_given() {
        let opts = |package: &str| DlxOptions {
            package: package.to_owned(),
            args: argv(&["new", "app"]),
            ..Default::default()
        };

        // `--package` stops npm from reading the bin out of the manifest, so `@angular/cli` would run `cli`.
        assert_eq!(
            resolve_dlx("npm", "11.0.0", opts("@angular/cli")).unwrap().args,
            ["exec", "--yes", "--", "@angular/cli", "new", "app"]
        );
        assert_eq!(
            resolve_dlx("npm", "11.0.0", opts("create-vite@6.0.0")).unwrap().args,
            ["exec", "--yes", "--", "create-vite@6.0.0", "new", "app"]
        );

        let silent = DlxOptions { silent: true, ..opts("@vue/cli") };

        assert_eq!(
            resolve_dlx("npm", "11.0.0", silent).unwrap().args,
            ["exec", "--yes", "--loglevel", "silent", "--", "@vue/cli", "new", "app"]
        );
    }

    #[test]
    fn dlx_npm_installs_every_package_and_names_the_bin_when_extras_are_given() {
        let opts = DlxOptions {
            package: "ts-node@10.9.2".to_owned(),
            args: argv(&["x.ts"]),
            additional_packages: argv(&["typescript"]),
            ..Default::default()
        };

        assert_eq!(
            resolve_dlx("npm", "11.0.0", opts).unwrap().args,
            ["exec", "--yes", "--package=typescript", "--package=ts-node@10.9.2", "--", "ts-node", "x.ts"]
        );
    }

    #[test]
    fn dlx_npm_shell_mode_passes_the_command_as_a_call_value() {
        let opts = DlxOptions {
            package: "cowsay hi | lolcatjs".to_owned(),
            additional_packages: argv(&["cowsay", "lolcatjs"]),
            shell_mode: true,
            silent: true,
            ..Default::default()
        };

        // npm's `-c` is `--call <String>`: it takes the next token, so `-c --` made `--` the command.
        assert_eq!(
            resolve_dlx("npm", "11.0.0", opts).unwrap().args,
            [
                "exec",
                "--yes",
                "--package=cowsay",
                "--package=lolcatjs",
                "--loglevel",
                "silent",
                "--call=cowsay hi | lolcatjs"
            ]
        );
    }

    #[test]
    fn dlx_with_extra_packages_installs_the_main_package_too() {
        let opts = || DlxOptions {
            package: "ts-node@10.9.2".to_owned(),
            args: argv(&["x.ts"]),
            additional_packages: argv(&["typescript"]),
            ..Default::default()
        };

        // Once a package is named explicitly the positional is a command and nothing else is installed.
        assert_eq!(
            resolve_dlx("pnpm", "10.0.0", opts()).unwrap().args,
            ["dlx", "--package", "typescript", "--package", "ts-node@10.9.2", "ts-node", "x.ts"]
        );
        assert_eq!(
            resolve_dlx("yarn", "4.5.0", opts()).unwrap().args,
            ["dlx", "-p", "typescript", "-p", "ts-node@10.9.2", "ts-node", "x.ts"]
        );
        assert_eq!(
            resolve_dlx("bun", "1.3.0", opts()).unwrap().args,
            ["x", "--package", "typescript", "--package", "ts-node@10.9.2", "ts-node", "x.ts"]
        );

        let classic = resolve_dlx("yarn", "1.22.0", opts()).unwrap();

        assert_eq!(classic.bin, "npx");
        assert_eq!(
            classic.args,
            ["--yes", "--package", "typescript", "--package", "ts-node@10.9.2", "ts-node", "x.ts"]
        );
    }

    #[test]
    fn dlx_shell_mode_keeps_the_command_out_of_the_package_list() {
        let opts = DlxOptions {
            package: "cowsay hi".to_owned(),
            additional_packages: argv(&["cowsay"]),
            shell_mode: true,
            ..Default::default()
        };

        assert_eq!(
            resolve_dlx("pnpm", "10.0.0", opts).unwrap().args,
            ["dlx", "--package", "cowsay", "-c", "cowsay hi"]
        );
    }
}
