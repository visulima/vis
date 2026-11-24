//! What a native command checks before it deletes a directory tree: Node's `rm` fails with a stack trace when a
//! directory cannot be emptied, and a native run cannot hand over to Node cleanly once it has removed part of the
//! tree. A removal that fails despite these checks (a race, or a restriction no check sees) is handed over anyway,
//! after the fact, by the commands that use them.

use std::ffi::CString;
use std::fs::{self, Metadata};
use std::path::Path;

/// Whether the file system flags of `metadata` forbid removing or changing the entry (`chflags uchg` or `uappnd`,
/// and the system versions of both), which `access(2)` does not report. Only macOS is checked: the equivalent on
/// Linux (`chattr +i`) needs an `ioctl` on an open file.
#[cfg(target_os = "macos")]
pub(crate) fn locked(metadata: &Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;

    // UF_IMMUTABLE | UF_APPEND | SF_IMMUTABLE | SF_APPEND
    metadata.st_flags() & (0x2 | 0x4 | 0x2_0000 | 0x4_0000) != 0
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn locked(_metadata: &Metadata) -> bool {
    false
}

/// Whether the entry at `path` exists and its flags allow removing or changing it (see [`locked`]).
fn unlocked(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| !locked(&metadata))
}

/// Whether `path`, an entry of `parent` that is not a directory, can be removed.
pub(crate) fn removable_file(path: &Path, parent: &Path) -> bool {
    may_modify(parent) && unlocked(path) && unlocked(parent)
}

/// Whether `directory` is a real directory whose whole tree this process may remove: its parent and every
/// directory below it can be written and searched, and read. A symbolic link or a file is not.
pub(crate) fn removable_directory(directory: &Path, parent: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(directory) else {
        return false;
    };

    if !metadata.is_dir() || locked(&metadata) || !may_modify(parent) || !unlocked(parent) {
        return false;
    }

    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };

    may_modify(directory)
        && entries.into_iter().all(|entry| {
            entry.is_ok_and(|entry| {
                let path = entry.path();

                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    removable_directory(&path, directory)
                } else {
                    entry.metadata().is_ok_and(|metadata| !locked(&metadata))
                }
            })
        })
}

/// `access(2)` with write and search permission, which removing an entry of `directory` needs.
pub(crate) fn may_modify(directory: &Path) -> bool {
    let Ok(text) = CString::new(directory.as_os_str().as_encoded_bytes()) else {
        return false;
    };

    // SAFETY: `text` is a NUL-terminated string that lives for the whole call.
    unsafe { libc::access(text.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use super::removable_directory;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("vis-removal-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(directory.join("tree/inner")).unwrap();

        directory
    }

    #[test]
    fn a_tree_of_writable_directories_can_be_removed() {
        let root = scratch("writable");

        assert!(removable_directory(&root.join("tree"), &root));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_read_only_directory_below_the_tree_cannot() {
        let root = scratch("locked");

        fs::set_permissions(root.join("tree/inner"), fs::Permissions::from_mode(0o555)).unwrap();
        assert!(!removable_directory(&root.join("tree"), &root));

        fs::set_permissions(root.join("tree/inner"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    /// An immutable file lets `access(2)` pass but fails the removal, so the tree must not count as removable.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_immutable_entry_cannot_be_removed() {
        use std::process::Command;

        let root = scratch("immutable");
        let file = root.join("tree/inner/pinned");

        fs::write(&file, "").unwrap();
        assert!(Command::new("chflags").arg("uchg").arg(&file).status().unwrap().success());

        assert!(!removable_directory(&root.join("tree"), &root));
        assert!(!super::removable_file(&file, &root.join("tree/inner")));

        assert!(Command::new("chflags").arg("nouchg").arg(&file).status().unwrap().success());
        assert!(removable_directory(&root.join("tree"), &root));
        assert!(super::removable_file(&file, &root.join("tree/inner")));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_symbolic_link_or_a_file_is_not_a_tree() {
        let root = scratch("link");

        fs::write(root.join("file"), "").unwrap();
        std::os::unix::fs::symlink(root.join("tree"), root.join("link")).unwrap();

        assert!(!removable_directory(&root.join("file"), &root));
        assert!(!removable_directory(&root.join("link"), &root));

        fs::remove_dir_all(&root).unwrap();
    }
}
