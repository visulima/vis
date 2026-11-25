use super::{Manager, ResolvedCommand};

/// Resolve `vis pm <subcommand> [args]` to the PM-specific invocation (per-PM
/// mapping for cache/list/pack/view + npm-only verbs, with a default pass-through).
pub fn resolve_pm_command(
    pm: &str,
    version: &str,
    subcommand: &str,
    mut extra_args: Vec<String>,
) -> Result<ResolvedCommand, String> {
    let manager = Manager::new(pm, version)?;
    let mut args = Vec::new();
    let mut warnings = Vec::new();

    // Commands that always delegate to npm.
    let npm_only = ["deprecate", "fund", "ping", "search", "token"];

    if npm_only.contains(&subcommand) {
        if manager != Manager::Npm {
            warnings.push(format!("'{subcommand}' is not natively supported by {}. Delegating to npm.", manager.bin()));
        }

        args.push(subcommand.to_owned());
        args.extend(extra_args);

        return Ok(ResolvedCommand { args, bin: "npm".into(), warnings });
    }

    match (subcommand, manager) {
        ("cache", Manager::Pnpm) => {
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
        ("cache", Manager::Bun) => args.extend(["pm".into(), "cache".into()]),
        ("list" | "ls", Manager::Bun) => args.extend(["pm".into(), "ls".into()]),
        ("list" | "ls", _) => args.push("list".into()),
        ("pack", Manager::Bun) => args.extend(["pm".into(), "pack".into()]),
        ("view" | "info", Manager::YarnClassic) => args.push("info".into()),
        ("view" | "info", Manager::YarnBerry) => args.extend(["npm".into(), "info".into()]),
        ("view" | "info", Manager::Bun) => args.extend(["pm".into(), "view".into()]),
        ("view" | "info", _) => args.push("view".into()),
        _ => {
            let lacks_prune_and_rebuild = matches!(manager, Manager::YarnClassic | Manager::YarnBerry | Manager::Bun);

            if subcommand == "prune" && lacks_prune_and_rebuild {
                warnings
                    .push(format!("{} does not support 'prune'. It prunes automatically on install.", manager.bin()));
            }

            if subcommand == "rebuild" && lacks_prune_and_rebuild {
                warnings.push(format!("{} does not support 'rebuild'.", manager.bin()));
            }

            args.push(subcommand.to_owned());
        }
    }

    args.extend(extra_args);

    Ok(ResolvedCommand { args, bin: manager.bin().to_owned(), warnings })
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
