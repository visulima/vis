use super::{validate_pm, ResolvedCommand};

/// Resolve `vis dedupe`.
pub fn resolve_dedupe(pm: &str, version: &str, check: bool) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            args.push("dedupe".into());

            if check {
                args.push("--check".into());
            }
        }
        "npm" => {
            args.push("dedupe".into());

            if check {
                args.push("--dry-run".into());
            }
        }
        "yarn" => {
            if version.starts_with("1.") {
                warnings.push("yarn v1 does not support dedupe. Upgrade to yarn berry (v2+).".into());

                return Ok(ResolvedCommand { args: vec!["install".into()], bin: "yarn".into(), warnings });
            }

            args.push("dedupe".into());

            if check {
                args.push("--check".into());
            }
        }
        "bun" => {
            warnings.push("bun does not support dedupe operations.".into());

            return Ok(ResolvedCommand { args: vec!["install".into()], bin: "bun".into(), warnings });
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_check_maps_per_pm() {
        assert_eq!(resolve_dedupe("pnpm", "9.0.0", true).unwrap().args, ["dedupe", "--check"]);
        assert_eq!(resolve_dedupe("npm", "10.0.0", true).unwrap().args, ["dedupe", "--dry-run"]);
        // bun has no dedupe -> install fallback with a warning.
        let bun = resolve_dedupe("bun", "1.1.0", false).unwrap();

        assert_eq!(bun.args, ["install"]);
        assert!(!bun.warnings.is_empty());
    }
}
