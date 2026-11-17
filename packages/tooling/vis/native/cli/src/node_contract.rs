//! The Node contract, filled in from the executable's own location.
//!
//! The JS launcher (`bin/vis.mjs`) used to be the only thing that set
//! `VIS_FALLBACK_ENTRY` and `VIS_VERSION` before starting this binary. When the
//! npm install puts the binary at `<package>/bin/vis` itself there is no
//! launcher, so [`init`] derives the same values from where the executable
//! lives. Anything already set (by the launcher, or by a user override such as
//! `VIS_FALLBACK_ENTRY`) wins. `VIS_NODE` is left alone: delegation uses it when
//! set and otherwise runs `node` from `PATH`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// The package files this binary delegates to.
#[derive(Debug, PartialEq, Eq)]
struct Layout {
    entry: PathBuf,
    version: Option<String>,
}

/// Fill in `VIS_FALLBACK_ENTRY`, `VIS_VERSION` and `VIS_LAUNCHER` for this process
/// (and the Node CLI it spawns) when the launcher did not.
pub fn init() {
    set_if_unset("VIS_LAUNCHER", "native");

    let Ok(exe) = env::current_exe().and_then(fs::canonicalize) else {
        return;
    };

    if let Some(layout) = locate(&exe) {
        set_if_unset("VIS_FALLBACK_ENTRY", &layout.entry);

        if let Some(version) = &layout.version {
            set_if_unset("VIS_VERSION", version);
        }
    }
}

fn set_if_unset(key: &str, value: impl AsRef<std::ffi::OsStr>) {
    if env::var_os(key).is_none() {
        env::set_var(key, value);
    }
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
}
