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
use std::ffi::{OsStr, OsString};
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
    // The JS launcher sets `VIS_HANDOFF=launcher` when it starts this binary itself, so
    // the binary keeps the `node` launcher value it set. The marker is consumed here so
    // no child inherits it: a stale marker from a parent would mislabel a direct run.
    let handoff = env::var_os("VIS_HANDOFF").as_deref() == Some(OsStr::new("launcher"));

    env::remove_var("VIS_HANDOFF");

    // What only the launcher can vouch for: `process.version` of its Node, and the status it wants a run it
    // cannot answer handed back with. A start without the hand-off drops whatever a parent process left behind,
    // so `vis run` answers natively only with a version it can trust and never exits with a stale status.
    if !handoff {
        env::remove_var("VIS_NODE_VERSION");
        env::remove_var("VIS_HANDBACK_STATUS");
    }

    let exe = env::current_exe().and_then(fs::canonicalize).ok();

    match exe.as_deref().and_then(locate) {
        Some(layout) => {
            for (key, value) in owned_env(&layout, env::var_os("VIS_FALLBACK_ENTRY_OVERRIDE"), handoff) {
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

/// The `@visulima/vis` version: `VIS_VERSION` (set by the launcher, or by [`init`]), else this crate's own
/// version for a binary run on its own.
pub fn version() -> String {
    env::var("VIS_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned())
}

/// What a binary installed inside a package sets, `None` meaning "must be unset".
fn owned_env(
    layout: &Layout,
    entry_override: Option<OsString>,
    handoff: bool,
) -> [(&'static str, Option<OsString>); 4] {
    let launcher = if handoff { "node" } else { "native" };

    [
        ("VIS_FALLBACK_ENTRY", Some(entry_override.unwrap_or_else(|| layout.entry.clone().into_os_string()))),
        ("VIS_VERSION", layout.version.as_ref().map(OsString::from)),
        ("VIS_LAUNCHER", Some(OsString::from(launcher))),
        // Consumed above; cleared so a `vis` started from a child process does not inherit it.
        ("VIS_FALLBACK_ENTRY_OVERRIDE", None),
    ]
}

/// Find the `@visulima/vis` package that owns `exe`: the binary installed at
/// `<package>/bin/vis`, or a dev build copied to `<package>/vis-native-cli`. A
/// package is recognised by its `dist/bin.js` and by a manifest named
/// `@visulima/vis`, so an application that happens to ship a `dist/bin.js` is not
/// adopted. A binary inside a platform package (which has neither) yields nothing
/// and relies on the launcher's environment instead.
fn locate(exe: &Path) -> Option<Layout> {
    let dir = exe.parent()?;

    [dir.parent(), Some(dir)].into_iter().flatten().find_map(|root| {
        let entry = root.join("dist").join("bin.js");

        if !entry.is_file() {
            return None;
        }

        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(root.join("package.json")).ok()?).ok()?;

        if manifest.get("name")?.as_str()? != "@visulima/vis" {
            return None;
        }

        Some(Layout { entry, version: manifest.get("version").and_then(|version| version.as_str()).map(str::to_owned) })
    })
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
    fn ignores_a_dist_bin_js_that_belongs_to_another_package() {
        let root = scratch("other-package");

        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/bin.js"), "").unwrap();
        fs::write(root.join("package.json"), r#"{"name":"my-app","version":"9.9.9"}"#).unwrap();

        assert_eq!(locate(&root.join("vis-native-cli")), None);
    }

    #[test]
    fn ignores_a_package_without_a_readable_manifest() {
        let root = scratch("no-manifest");

        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/bin.js"), "").unwrap();

        assert_eq!(locate(&root.join("vis-native-cli")), None);
    }

    #[test]
    fn a_located_package_overrides_what_a_parent_process_left_behind() {
        let root = scratch("owned-env");

        install_package(&root);
        fs::create_dir_all(root.join("bin")).unwrap();

        let layout = locate(&root.join("bin").join("vis")).unwrap();

        assert_eq!(
            owned_env(&layout, None, false),
            [
                ("VIS_FALLBACK_ENTRY", Some(root.join("dist").join("bin.js").into_os_string())),
                ("VIS_VERSION", Some(OsString::from("1.2.3"))),
                ("VIS_LAUNCHER", Some(OsString::from("native"))),
                ("VIS_FALLBACK_ENTRY_OVERRIDE", None),
            ]
        );
    }

    #[test]
    fn a_located_package_without_a_manifest_clears_an_inherited_version() {
        let layout = Layout { entry: PathBuf::from("/pkg/dist/bin.js"), version: None };

        assert_eq!(owned_env(&layout, None, false)[1], ("VIS_VERSION", None));
    }

    #[test]
    fn an_explicit_override_wins_over_the_located_entry() {
        let layout = Layout { entry: PathBuf::from("/pkg/dist/bin.js"), version: None };

        assert_eq!(
            owned_env(&layout, Some(OsString::from("/stub.mjs")), false)[0],
            ("VIS_FALLBACK_ENTRY", Some(OsString::from("/stub.mjs")))
        );
    }

    #[test]
    fn a_launcher_handoff_keeps_the_node_launcher_value() {
        let layout = Layout { entry: PathBuf::from("/pkg/dist/bin.js"), version: None };

        assert_eq!(owned_env(&layout, None, true)[2], ("VIS_LAUNCHER", Some(OsString::from("node"))));
    }
}
