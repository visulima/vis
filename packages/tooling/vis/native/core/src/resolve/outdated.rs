use super::{validate_pm, ResolvedCommand};

/// Options for `resolve_outdated`.
#[derive(Clone, Debug, Default)]
pub struct OutdatedOptions {
    pub packages: Vec<String>,
    pub long: bool,
    pub format: String,
    pub recursive: bool,
    pub filter: Vec<String>,
    pub workspace_root: bool,
    pub prod: bool,
    pub dev: bool,
    pub no_optional: bool,
    pub compatible: bool,
    pub global: bool,
}

/// Resolve `vis outdated`.
pub fn resolve_outdated(pm: &str, version: &str, opts: OutdatedOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }

            args.push("outdated".into());

            if opts.long {
                args.push("--long".into());
            }

            if opts.recursive {
                args.push("--recursive".into());
            }

            if opts.workspace_root {
                args.push("--include-workspace-root".into());
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

            if opts.compatible {
                args.push("--compatible".into());
            }

            match opts.format.as_str() {
                "json" => {
                    args.push("--format".into());
                    args.push("json".into());
                }
                "list" => {
                    args.push("--format".into());
                    args.push("list".into());
                }
                _ => {}
            }

            args.extend(opts.packages);
        }
        "npm" => {
            args.push("outdated".into());

            if opts.long {
                args.push("--long".into());
            }

            match opts.format.as_str() {
                "json" => args.push("--json".into()),
                "list" => args.push("--parseable".into()),
                _ => {}
            }

            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }

            if opts.recursive {
                args.push("--all".into());
            }

            if opts.global {
                args.push("--global".into());
            }

            args.extend(opts.packages);
        }
        "yarn" => {
            if version.starts_with("1.") {
                args.push("outdated".into());
                args.extend(opts.packages);
            } else {
                warnings.push("yarn berry uses 'yarn upgrade-interactive' instead of outdated.".into());
                args.push("upgrade-interactive".into());
            }
        }
        "bun" => {
            args.push("outdated".into());

            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }

            args.extend(opts.packages);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outdated_format_and_filter() {
        let opts =
            OutdatedOptions { filter: vec!["@scope/a".to_owned()], format: "json".to_owned(), ..Default::default() };
        let resolved = resolve_outdated("pnpm", "9.0.0", opts).unwrap();

        assert_eq!(resolved.args, ["--filter", "@scope/a", "outdated", "--format", "json"]);
    }
}
