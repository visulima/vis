use super::{validate_pm, ResolvedCommand};

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
pub fn resolve_why(pm: &str, version: &str, opts: WhyOptions) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            for f in &opts.filter {
                args.push("--filter".into());
                args.push(f.clone());
            }

            args.push("why".into());

            if opts.json {
                args.push("--json".into());
            }

            if opts.long {
                args.push("--long".into());
            }

            if opts.parseable {
                args.push("--parseable".into());
            }

            if opts.recursive {
                args.push("--recursive".into());
            }

            if opts.dev {
                args.push("--dev".into());
            }

            if opts.prod {
                args.push("--prod".into());
            }

            if opts.no_optional {
                args.push("--no-optional".into());
            }

            if opts.global {
                args.push("--global".into());
            }

            if let Some(d) = opts.depth {
                args.push("--depth".into());
                args.push(d.to_string());
            }

            args.extend(opts.packages);
        }
        "npm" => {
            args.push("explain".into());

            if opts.json {
                args.push("--json".into());
            }

            for f in &opts.filter {
                args.push("--workspace".into());
                args.push(f.clone());
            }

            if opts.long {
                warnings.push("npm does not support --long for explain.".into());
            }

            args.extend(opts.packages);
        }
        "yarn" => {
            args.push("why".into());

            if version.starts_with("1.") {
                if opts.packages.len() > 1 {
                    warnings.push("yarn v1 only supports querying one package at a time.".into());
                }

                if let Some(p) = opts.packages.first() {
                    args.push(p.clone());
                }
            } else {
                if opts.recursive {
                    args.push("-R".into());
                }

                args.extend(opts.packages);
            }

            if opts.json {
                args.push("--json".into());
            }
        }
        "bun" => {
            args.push("why".into());

            if let Some(d) = opts.depth {
                args.push("--depth".into());
                args.push(d.to_string());
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
    fn why_npm_uses_explain() {
        let opts = WhyOptions { packages: vec!["lodash".to_owned()], json: true, ..Default::default() };
        let resolved = resolve_why("npm", "10.0.0", opts).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert_eq!(resolved.args, ["explain", "--json", "lodash"]);
    }
}
