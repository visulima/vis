use super::{push_each, push_flags, Manager, ResolveError, ResolvedCommand};

/// Options for `resolve_why`.
#[derive(Clone, Debug, Default)]
pub struct WhyOptions {
    pub packages: Vec<String>,
    pub json: bool,
    pub long: bool,
    pub parseable: bool,
    pub recursive: bool,
    pub dev: bool,
    pub prod: bool,
    pub no_optional: bool,
    pub global: bool,
    pub depth: Option<i32>,
    pub filter: Vec<String>,
}

/// Resolve `vis why <packages>`.
pub fn resolve_why(pm: &str, version: &str, opts: WhyOptions) -> Result<ResolvedCommand, ResolveError> {
    let manager = Manager::new(pm, version)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match manager {
        Manager::Pnpm => {
            push_each(&mut args, "--filter", &opts.filter);

            args.push("why".into());

            push_flags(
                &mut args,
                &[
                    (opts.json, "--json"),
                    (opts.long, "--long"),
                    (opts.parseable, "--parseable"),
                    (opts.recursive, "--recursive"),
                    (opts.dev, "--dev"),
                    (opts.prod, "--prod"),
                    (opts.no_optional, "--no-optional"),
                    (opts.global, "--global"),
                ],
            );

            if let Some(d) = opts.depth {
                args.push("--depth".into());
                args.push(d.to_string());
            }

            args.extend(opts.packages);
        }
        Manager::Npm => {
            args.push("explain".into());

            if opts.json {
                args.push("--json".into());
            }

            push_each(&mut args, "--workspace", &opts.filter);

            if opts.long {
                warnings.push("npm does not support --long for explain.".into());
            }

            args.extend(opts.packages);
        }
        Manager::YarnClassic => {
            args.push("why".into());

            if opts.packages.len() > 1 {
                warnings.push("yarn v1 only supports querying one package at a time.".into());
            }

            if let Some(p) = opts.packages.first() {
                args.push(p.clone());
            }

            if opts.json {
                args.push("--json".into());
            }
        }
        Manager::YarnBerry => {
            args.push("why".into());

            if opts.recursive {
                args.push("-R".into());
            }

            args.extend(opts.packages);

            if opts.json {
                args.push("--json".into());
            }
        }
        Manager::Bun => {
            args.push("why".into());

            if let Some(d) = opts.depth {
                args.push("--depth".into());
                args.push(d.to_string());
            }

            args.extend(opts.packages);
        }
    }

    Ok(ResolvedCommand { args, bin: manager.bin().to_owned(), warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn why_npm_uses_explain() {
        let opts = WhyOptions { packages: vec!["lodash".to_owned()], json: true, ..Default::default() };
        let resolved = resolve_why("npm", "10.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args, ["explain", "--json", "lodash"]);
    }
}
