use super::{validate_pm, ResolvedCommand};

/// Leading integer of a version string (`"11.0.0-rc.0"` -> `Some(11)`), or None
/// when it doesn't start with a digit (`"latest"`).
fn parse_major(version: &str) -> Option<u32> {
    let end = version.find(|c: char| !c.is_ascii_digit()).unwrap_or(version.len());

    version[..end].parse::<u32>().ok()
}

/// `Some(true)` for pnpm >= 11, `Some(false)` below, `None` if unparseable.
fn is_pnpm_v11_plus(version: &str) -> Option<bool> {
    parse_major(version).map(|major| major >= 11)
}

/// True when the target looks like a filesystem path rather than a bare name.
fn is_path_like(target: &str) -> bool {
    target.starts_with('/')
        || target.starts_with('\\')
        || target.starts_with("./")
        || target.starts_with(".\\")
        || target.starts_with("../")
        || target.starts_with("..\\")
        || target == "."
        || target == ".."
        || (target.len() >= 3
            && target.as_bytes()[1] == b':'
            && (target.as_bytes()[2] == b'/' || target.as_bytes()[2] == b'\\'))
}

/// Resolve `vis link [target]`.
pub fn resolve_link(pm: &str, version: &str, target: Option<String>) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = vec!["link".to_owned()];
    let mut warnings = Vec::new();

    if pm == "pnpm" {
        match is_pnpm_v11_plus(version) {
            Some(true) => match &target {
                None => warnings.push(
                    "pnpm v11 removed arg-less `pnpm link`. Pass an explicit path, e.g. `vis link ./packages/my-pkg`."
                        .into(),
                ),
                Some(t) if !is_path_like(t) => {
                    warnings.push(format!("pnpm v11 removed global-store name resolution for `pnpm link {t}`. Use a relative or absolute path instead."));
                }
                _ => {}
            },
            None => match &target {
                None => warnings.push(
                    "pnpm version unknown. Arg-less `pnpm link` was removed in v11; pass an explicit path to be safe."
                        .into(),
                ),
                Some(t) if !is_path_like(t) => {
                    warnings.push(format!("pnpm version unknown. Global-store name resolution for `pnpm link {t}` was removed in v11; use a path to be safe."));
                }
                _ => {}
            },
            Some(false) => {}
        }
    }

    if let Some(t) = target {
        args.push(t);
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

/// Resolve `vis unlink <packages>`.
pub fn resolve_unlink(
    pm: &str,
    version: &str,
    packages: Vec<String>,
    recursive: bool,
) -> Result<ResolvedCommand, String> {
    validate_pm(pm)?;

    let mut args = Vec::new();
    let mut warnings = Vec::new();

    match pm {
        "pnpm" => {
            args.push("unlink".into());

            if recursive {
                args.push("--recursive".into());
            }

            args.extend(packages);
        }
        "npm" => {
            args.push("unlink".into());

            if recursive {
                warnings.push("npm does not support --recursive for unlink.".into());
            }

            args.extend(packages);
        }
        "yarn" => {
            args.push("unlink".into());

            if recursive && !version.starts_with("1.") {
                args.push("--all".into());
            } else if recursive {
                warnings.push("yarn v1 does not support recursive unlink.".into());
            }

            args.extend(packages);
        }
        "bun" => {
            args.push("unlink".into());

            if recursive {
                warnings.push("bun does not support --recursive for unlink.".into());
            }

            args.extend(packages);
        }
        _ => unreachable!(),
    }

    Ok(ResolvedCommand { args, bin: pm.to_owned(), warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_pnpm_v11_warns_on_bare_name() {
        let resolved = resolve_link("pnpm", "11.0.0", Some("my-pkg".to_owned())).unwrap();

        assert_eq!(resolved.args, ["link", "my-pkg"]);
        assert!(!resolved.warnings.is_empty(), "v11 bare-name link should warn");

        // A path target on v11 does not warn.
        assert!(resolve_link("pnpm", "11.0.0", Some("./packages/p".to_owned())).unwrap().warnings.is_empty());
    }

    #[test]
    fn unlink_recursive_per_pm() {
        assert_eq!(
            resolve_unlink("pnpm", "9.0.0", vec!["p".to_owned()], true).unwrap().args,
            ["unlink", "--recursive", "p"]
        );
        // npm has no recursive unlink -> warning, no flag.
        let npm = resolve_unlink("npm", "10.0.0", vec!["p".to_owned()], true).unwrap();

        assert_eq!(npm.args, ["unlink", "p"]);
        assert!(!npm.warnings.is_empty());
    }
}
