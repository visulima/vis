//! The Node contract, filled in from the executable's own location.
//!
//! The JS launcher (`bin/vis.mjs`) used to be the only thing that set
//! `VIS_FALLBACK_ENTRY` and `VIS_VERSION` before starting this binary. When the
//! npm install puts the binary at `<package>/bin/vis` itself there is no
//! launcher, so [`init`] derives the same values from where the executable
//! lives. A binary that is found inside a package owns those values: it replaces
//! whatever a parent `vis` process left in the environment (a stale entry would
//! otherwise point the Node fallback at another install). A binary outside a
//! package (a platform package, started by the launcher) keeps what the launcher
//! set. Tests and dev builds that sit in a package but need a stub entry set
//! `VIS_FALLBACK_ENTRY_OVERRIDE`, which wins over the located entry. `VIS_NODE` is left alone: delegation uses it when set and otherwise runs
//! `node` from `PATH`.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

/// The package files this binary delegates to.
#[derive(Debug, PartialEq, Eq)]
struct Layout {
    entry: PathBuf,
    version: Option<String>,
}

/// Fill in `VIS_FALLBACK_ENTRY`, `VIS_VERSION` and `VIS_LAUNCHER` for this process
/// (and the Node CLI it spawns).
pub fn init() {
    let exe = env::current_exe().and_then(fs::canonicalize).ok();

    match exe.as_deref().and_then(locate) {
        Some(layout) => {
            for (key, value) in owned_env(&layout, env::var_os("VIS_FALLBACK_ENTRY_OVERRIDE")) {
                match value {
                    Some(value) => env::set_var(key, value),
                    None => env::remove_var(key),
                }
            }
        }
        None => {
            if env::var_os("VIS_LAUNCHER").is_none() {
                env::set_var("VIS_LAUNCHER", "native");
            }
        }
    }
}

/// What a binary installed inside a package sets, `None` meaning "must be unset".
fn owned_env(layout: &Layout, entry_override: Option<OsString>) -> [(&'static str, Option<OsString>); 3] {
    [
        ("VIS_FALLBACK_ENTRY", Some(entry_override.unwrap_or_else(|| layout.entry.clone().into_os_string()))),
        ("VIS_VERSION", layout.version.as_ref().map(OsString::from)),
        ("VIS_LAUNCHER", Some(OsString::from("native"))),
    ]
}

/// Find the package that owns `exe`: the binary installed at `<package>/bin/vis`,
/// or a dev build copied to `<package>/vis-native-cli`. A package is recognised by
/// the `dist/bin.js` it ships, so a binary inside a platform package (which has
/// none) yields nothing and relies on the launcher's environment instead.
fn locate(exe: &Path) -> Option<Layout> {
    let dir = exe.parent()?;

    [dir.parent(), Some(dir)].into_iter().flatten().find_map(|root| {
        let entry = root.join("dist").join("bin.js");

        entry.is_file().then(|| Layout { entry, version: package_version(root) })
    })
}

fn package_version(root: &Path) -> Option<String> {
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(root.join("package.json")).ok()?).ok()?;

    manifest.get("version")?.as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("vis-node-contract-{}-{name}", std::process::id()));

        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        dir
    }

    fn install_package(root: &Path) {
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/bin.js"), "").unwrap();
        fs::write(root.join("package.json"), r#"{"name":"@visulima/vis","version":"1.2.3"}"#).unwrap();
    }

    #[test]
    fn locates_the_package_for_a_binary_installed_at_bin_vis() {
        let root = scratch("bin-vis");

        install_package(&root);
        fs::create_dir_all(root.join("bin")).unwrap();

        let layout = locate(&root.join("bin").join("vis")).unwrap();

        assert_eq!(layout.entry, root.join("dist/bin.js"));
        assert_eq!(layout.version.as_deref(), Some("1.2.3"));
    }

    #[test]
    fn locates_the_package_for_a_dev_build_next_to_package_json() {
        let root = scratch("dev-build");

        install_package(&root);

        let layout = locate(&root.join("vis-native-cli")).unwrap();

        assert_eq!(layout.entry, root.join("dist/bin.js"));
    }

    #[test]
    fn finds_nothing_for_a_binary_inside_a_platform_package() {
        let root = scratch("platform-package");

        fs::create_dir_all(root.join("node_modules/@visulima/vis-binding-x")).unwrap();

        assert_eq!(locate(&root.join("node_modules/@visulima/vis-binding-x/vis-native-cli")), None);
    }

    #[test]
    fn omits_the_version_when_package_json_is_unreadable() {
        let root = scratch("no-manifest");

        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/bin.js"), "").unwrap();

        assert_eq!(locate(&root.join("vis-native-cli")).unwrap().version, None);
    }

    #[test]
    fn a_located_package_overrides_what_a_parent_process_left_behind() {
        let root = scratch("owned-env");

        install_package(&root);
        fs::create_dir_all(root.join("bin")).unwrap();

        let layout = locate(&root.join("bin").join("vis")).unwrap();

        assert_eq!(
            owned_env(&layout, None),
            [
                ("VIS_FALLBACK_ENTRY", Some(root.join("dist/bin.js").into_os_string())),
                ("VIS_VERSION", Some(OsString::from("1.2.3"))),
                ("VIS_LAUNCHER", Some(OsString::from("native"))),
            ]
        );
    }

    #[test]
    fn a_located_package_without_a_manifest_clears_an_inherited_version() {
        let layout = Layout { entry: PathBuf::from("/pkg/dist/bin.js"), version: None };

        assert_eq!(owned_env(&layout, None)[1], ("VIS_VERSION", None));
    }

    #[test]
    fn an_explicit_override_wins_over_the_located_entry() {
        let layout = Layout { entry: PathBuf::from("/pkg/dist/bin.js"), version: None };

        assert_eq!(
            owned_env(&layout, Some(OsString::from("/stub.mjs")))[0],
            ("VIS_FALLBACK_ENTRY", Some(OsString::from("/stub.mjs")))
        );
    }
}
