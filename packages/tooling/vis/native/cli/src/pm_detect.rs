//! What Node decides about the package manager before it looks at a lockfile: the installer chosen from the
//! environment, a `packageManager` pin in an ancestor, and Corepack. The native commands leave the run to Node when
//! any of these applies, because the manager they would pick from the lockfile could differ.

use std::env;
use std::fs;
use std::path::Path;

/// Node picks the installer from `VIS_INSTALLER` and from `aube` on PATH before it looks at
/// lockfiles, so a native choice from the lockfile would differ.
pub(crate) fn installer_selected_by_environment() -> bool {
    env::var_os("VIS_INSTALLER").is_some() || env::var_os("VIS_RUNTIME").is_some() || binary_on_path("aube")
}

/// Whether `name` (with the Windows executable extensions) is a file in a `PATH` directory. This is the question
/// Node's own `which` asks; `pm_run::on_path` asks `execvp`'s (an executable file of exactly that name) instead.
pub(crate) fn binary_on_path(name: &str) -> bool {
    let names = [name.to_owned(), format!("{name}.exe"), format!("{name}.cmd"), format!("{name}.bat")];

    env::var_os("PATH").is_some_and(|path| {
        env::split_paths(&path).any(|directory| names.iter().any(|name| directory.join(name).is_file()))
    })
}

/// Node runs the installer a `packageManager` pin names through Corepack, which can differ from the
/// one native finds. Any pin in an ancestor `package.json` leaves the command to Node.
pub(crate) fn ancestor_pins_package_manager(cwd: &Path) -> bool {
    cwd.ancestors().any(|directory| {
        fs::read_to_string(directory.join("package.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .is_some_and(|manifest| manifest.get("packageManager").is_some())
    })
}

/// Whether Node wraps the package manager in Corepack: a `packageManager` pin in `cwd` or an ancestor
/// (`install.corepack` left on `auto`) and `corepack` on `PATH`. The native path never does.
pub(crate) fn corepack_applies(cwd: &Path) -> bool {
    binary_on_path("corepack") && ancestor_pins_package_manager(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_package_manager_pin_in_any_ancestor_counts() {
        let root = env::temp_dir().join(format!("vis-pm-detect-{}", std::process::id()));
        let app = root.join("packages").join("app");

        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&app).unwrap();
        // A manifest that does not parse pins nothing, and the walk goes on above it.
        fs::write(app.join("package.json"), "not json").unwrap();

        fs::write(root.join("package.json"), r#"{"packageManager":"pnpm@9.0.0"}"#).unwrap();

        assert!(ancestor_pins_package_manager(&app));
        assert!(ancestor_pins_package_manager(&root));

        let _ = fs::remove_dir_all(&root);
    }
}
