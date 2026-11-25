use super::{push_each, push_flags, Manager, ResolveError, ResolvedCommand};

/// How `vis outdated` prints its report. Only `json` and `list` reach the package manager; any other value
/// (`table`, or one this version does not know) leaves the manager's own format alone.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OutdatedFormat {
    #[default]
    Table,
    Json,
    List,
}

impl OutdatedFormat {
    pub fn parse(format: &str) -> Self {
        match format {
            "json" => Self::Json,
            "list" => Self::List,
            _ => Self::Table,
        }
    }
}

/// Options for `resolve_outdated`.
#[derive(Clone, Debug, Default)]
pub struct OutdatedOptions {
    pub packages: Vec<String>,
    pub long: bool,
    pub format: OutdatedFormat,
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

            match opts.format {
                OutdatedFormat::Json => args.extend(["--format".into(), "json".into()]),
                OutdatedFormat::List => args.extend(["--format".into(), "list".into()]),
                OutdatedFormat::Table => {}
            }

            args.extend(opts.packages);
        }
        Manager::Npm => {
            args.push("outdated".into());

            if opts.long {
                args.push("--long".into());
            }

            match opts.format {
                OutdatedFormat::Json => args.push("--json".into()),
                OutdatedFormat::List => args.push("--parseable".into()),
                OutdatedFormat::Table => {}
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
            OutdatedOptions { filter: vec!["@scope/a".to_owned()], format: OutdatedFormat::Json, ..Default::default() };
        let resolved = resolve_outdated("pnpm", "9.0.0", opts).unwrap();

        assert_eq!(resolved.args, ["--filter", "@scope/a", "outdated", "--format", "json"]);
    }
}
