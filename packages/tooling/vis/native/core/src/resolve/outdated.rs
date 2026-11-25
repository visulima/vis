use super::{push_each, push_flags, Manager, ResolveError, ResolvedCommand};

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
pub fn resolve_outdated(pm: &str, version: &str, opts: OutdatedOptions) -> Result<ResolvedCommand, ResolveError> {
    let manager = Manager::new(pm, version)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match manager {
        Manager::Pnpm => {
            push_each(&mut args, "--filter", &opts.filter);

            args.push("outdated".into());

            push_flags(
                &mut args,
                &[
                    (opts.long, "--long"),
                    (opts.recursive, "--recursive"),
                    (opts.workspace_root, "--include-workspace-root"),
                    (opts.prod, "--prod"),
                    (opts.dev, "--dev"),
                    (opts.no_optional, "--no-optional"),
                    (opts.compatible, "--compatible"),
                ],
            );

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
        Manager::Npm => {
            args.push("outdated".into());

            if opts.long {
                args.push("--long".into());
            }

            match opts.format.as_str() {
                "json" => args.push("--json".into()),
                "list" => args.push("--parseable".into()),
                _ => {}
            }

            push_each(&mut args, "--workspace", &opts.filter);

            push_flags(&mut args, &[(opts.recursive, "--all"), (opts.global, "--global")]);

            args.extend(opts.packages);
        }
        Manager::YarnClassic => {
            args.push("outdated".into());
            args.extend(opts.packages);
        }
        Manager::YarnBerry => {
            warnings.push("yarn berry uses 'yarn upgrade-interactive' instead of outdated.".into());
            args.push("upgrade-interactive".into());
        }
        Manager::Bun => {
            args.push("outdated".into());

            push_each(&mut args, "--filter", &opts.filter);

            args.extend(opts.packages);
        }
    }

    Ok(ResolvedCommand { args, bin: manager.bin().to_owned(), warnings })
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
