use super::{validate_pm, ResolvedCommand};

/// Resolve `vis pm <subcommand> [args]` to the PM-specific invocation (per-PM
/// mapping for cache/list/pack/view + npm-only verbs, with a default pass-through).
pub fn resolve_pm_command(
    pm: &str,
    version: &str,
    subcommand: &str,
    mut extra_args: Vec<String>,
) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    // Commands that always delegate to npm.
    let npm_only = ["deprecate", "fund", "ping", "search", "token"];

    if npm_only.contains(&subcommand) {
        if pm != "npm" {
            warnings.push(format!("'{subcommand}' is not natively supported by {pm}. Delegating to npm."));
        }

        args.push(subcommand.to_owned());
        args.extend(extra_args);

        return Ok(ResolvedCommand { args, bin: "npm".into(), warnings });
    }

    match (subcommand, pm) {
        ("cache", "pnpm") => {
            args.push("store".into());

            match extra_args.first().map(String::as_str) {
                Some("dir") => {
                    args.push("path".into());
                    extra_args.clear();
                }
                Some("clean") => {
                    args.push("prune".into());
                    extra_args.remove(0);
                }
                _ => {}
            }
        }
        ("cache", "bun") => args.extend(["pm".into(), "cache".into()]),
        ("list" | "ls", "bun") => args.extend(["pm".into(), "ls".into()]),
        ("list" | "ls", _) => args.push("list".into()),
        ("pack", "bun") => args.extend(["pm".into(), "pack".into()]),
        ("view" | "info", "yarn") if version.starts_with("1.") => args.push("info".into()),
        ("view" | "info", "yarn") => args.extend(["npm".into(), "info".into()]),
        ("view" | "info", "bun") => args.extend(["pm".into(), "view".into()]),
        ("view" | "info", _) => args.push("view".into()),
        _ => {
            if subcommand == "prune" && (pm == "yarn" || pm == "bun") {
                warnings.push(format!("{pm} does not support 'prune'. It prunes automatically on install."));
            }

            if subcommand == "rebuild" && (pm == "yarn" || pm == "bun") {
                warnings.push(format!("{pm} does not support 'rebuild'."));
            }

            args.push(subcommand.to_owned());
        }
    }

    args.extend(extra_args);

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolve::argv;

    #[test]
    fn pm_cache_dir_maps_to_pnpm_store_path() {
        let resolved = resolve_pm_command("pnpm", "9.0.0", "cache", argv(&["dir"])).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["store", "path"]);
    }

    #[test]
    fn pm_passthrough_forwards_flags() {
        let resolved = resolve_pm_command("pnpm", "9.0.0", "publish", argv(&["--dry-run"])).unwrap();

        assert_eq!(resolved.bin, "pnpm");
        assert_eq!(resolved.args, ["publish", "--dry-run"]);
    }

    #[test]
    fn pm_npm_only_verb_delegates_to_npm() {
        let resolved = resolve_pm_command("pnpm", "9.0.0", "ping", argv(&[])).unwrap();

        assert_eq!(resolved.bin, "npm");
        assert!(!resolved.warnings.is_empty());
    }
}
