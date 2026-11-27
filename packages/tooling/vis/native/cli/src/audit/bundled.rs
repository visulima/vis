//! Whether Node would scan more than the lockfile lists.
//!
//! The Node handler also reads the packages that a package on disk ships inside itself: the names it lists in
//! `bundleDependencies`, and the directories of a vendored tree (`dist/compiled`, `compiled`). It scans the first and
//! reports the unversioned ones of the second as not scanned, so its report counts more packages and may carry
//! an `unauditable` entry. This crate reads the lockfile only, so it hands the run to Node before it prints
//! anything whenever such a package is on disk.
//!
//! The walk is the one the Node scan makes (`readNodeModulesManifests`): the top-level directories of
//! `node_modules` (symbolic links are skipped), scope directories, pnpm's `.pnpm/<entry>/node_modules` store, and
//! the `node_modules` nested inside a package. It is a superset of what Node acts on: it looks at every package
//! under `node_modules`, where Node looks at those the lockfile lists, and a `package.json` that merely has the key
//! (even as `false` or an empty list), one this crate cannot parse, and a vendored directory with any
//! subdirectory all count.

use std::fs;
use std::path::Path;

use serde_json::Value;

/// The two spellings of the key npm reads.
const BUNDLE_KEYS: [&str; 2] = ["bundleDependencies", "bundledDependencies"];

/// Directories, relative to a package, that vendor copies of other packages.
const VENDORED: [&str; 2] = ["dist/compiled", "compiled"];

const BUNDLES: &str = "a package under node_modules ships other packages inside itself (bundleDependencies)";
const VENDORS: &str = "a package under node_modules ships a vendored tree of packages (dist/compiled)";
const UNREADABLE: &str = "a package.json under node_modules is not JSON this crate reads";

/// The reason Node would scan more than the lockfile for `root`, or `None` when it would not (no `node_modules`
/// counts: Node reads nothing from disk then either).
pub(super) fn decline(root: &Path) -> Option<&'static str> {
    scan(&root.join("node_modules"), false)
}

fn scan(directory: &Path, scoped: bool) -> Option<&'static str> {
    let entries = fs::read_dir(directory).ok()?;

    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };

        // Node skips a link, so a workspace package linked in is not read as an installed copy.
        if kind.is_symlink() {
            continue;
        }

        let name = entry.file_name();
        let path = entry.path();
        let Some(name) = name.to_str() else {
            return Some("a name under node_modules is not UTF-8");
        };

        if name.starts_with('@') {
            if kind.is_dir() {
                if let Some(reason) = scan(&path, true) {
                    return Some(reason);
                }
            }

            continue;
        }

        if name == ".pnpm" && !scoped {
            if let Some(reason) = scan_store(&path) {
                return Some(reason);
            }

            continue;
        }

        if name.starts_with('.') || !kind.is_dir() {
            continue;
        }

        if let Some(reason) = scan_package(&path) {
            return Some(reason);
        }
    }

    None
}

/// pnpm's content-addressed store: `.pnpm/<name>@<version>…/node_modules/<package>`.
fn scan_store(store: &Path) -> Option<&'static str> {
    for entry in fs::read_dir(store).ok()?.flatten() {
        let modules = entry.path().join("node_modules");

        if modules.is_dir() {
            if let Some(reason) = scan(&modules, false) {
                return Some(reason);
            }
        }
    }

    None
}

fn scan_package(package: &Path) -> Option<&'static str> {
    if let Ok(manifest) = fs::read(package.join("package.json")) {
        match serde_json::from_slice::<Value>(&manifest) {
            Ok(Value::Object(fields)) if BUNDLE_KEYS.iter().any(|key| fields.contains_key(*key)) => {
                return Some(BUNDLES)
            }
            Ok(_) => {}
            Err(_) => return Some(UNREADABLE),
        }
    }

    if VENDORED.iter().any(|location| has_subdirectory(&package.join(location))) {
        return Some(VENDORS);
    }

    let nested = package.join("node_modules");

    if nested.is_dir() {
        return scan(&nested, false);
    }

    None
}

fn has_subdirectory(directory: &Path) -> bool {
    fs::read_dir(directory)
        .is_ok_and(|entries| entries.flatten().any(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir())))
}
