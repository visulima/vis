//! Writing files the way `writeFileSync` of `@visulima/fs` does, for the files `vis security sync` rewrites: the new
//! bytes go to a sibling temporary file that is created exclusively (mode `0666` less the umask, whatever the mode of the
//! file it replaces was: Node's `writeFileSync` only keeps a mode when asked to back the file up) and is renamed over the
//! target. The target is a new inode afterwards, as it is under Node, and a link to it is replaced, not followed.
//!
//! Every file is staged before any is renamed, so a directory that refuses a temporary file is found before the
//! first target changes, and the caller can still hand the command to Node.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A file to write.
pub(crate) struct File {
    pub(crate) path: PathBuf,
    pub(crate) contents: String,
}

/// How a write failed.
pub(crate) enum Failure {
    /// Nothing was renamed: the targets are as they were.
    Staging(io::Error),
    /// A rename failed after `renamed` others went through (none: the targets are still as they were).
    Renaming { renamed: usize, error: io::Error },
}

fn temporary(target: &Path) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos());

    let mut name = target.as_os_str().to_owned();

    name.push(format!(".{:x}.{nanos:x}.tmp", std::process::id()));

    PathBuf::from(name)
}

fn stage(file: &File) -> io::Result<PathBuf> {
    let temp = temporary(&file.path);
    let mut handle = OpenOptions::new().write(true).create_new(true).open(&temp)?;

    match handle.write_all(file.contents.as_bytes()) {
        Ok(()) => Ok(temp),
        Err(error) => {
            let _ = fs::remove_file(&temp);

            Err(error)
        }
    }
}

/// Writes `files` in order.
pub(crate) fn write_all(files: &[File]) -> Result<(), Failure> {
    let mut staged: Vec<PathBuf> = Vec::new();

    for file in files {
        match stage(file) {
            Ok(temp) => staged.push(temp),
            Err(error) => {
                for temp in &staged {
                    let _ = fs::remove_file(temp);
                }

                return Err(Failure::Staging(error));
            }
        }
    }

    for (index, (file, temp)) in files.iter().zip(&staged).enumerate() {
        if let Err(error) = fs::rename(temp, &file.path) {
            for temp in &staged[index..] {
                let _ = fs::remove_file(temp);
            }

            return Err(Failure::Renaming { renamed: index, error });
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("vis-sync-stage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);

        fs::create_dir_all(&path).unwrap();

        path
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_file_gets_the_default_mode_and_leaves_no_temporary_behind() {
        let dir = directory("mode");
        let target = dir.join("a.yaml");

        fs::write(&target, "old").unwrap();
        fs::set_permissions(&target, std::os::unix::fs::PermissionsExt::from_mode(0o611)).unwrap();

        let result = write_all(&[File { path: target.clone(), contents: "new".to_owned() }]);

        assert!(result.is_ok());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        // `0666` less the umask, as for any new file; the old `0611`, which no new file gets, is gone.
        assert_ne!(std::os::unix::fs::MetadataExt::mode(&fs::metadata(&target).unwrap()) & 0o7777, 0o611);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failure_while_staging_changes_nothing() {
        let dir = directory("staging");
        let first = dir.join("a.yaml");

        fs::write(&first, "old").unwrap();

        let files = [
            File { path: first.clone(), contents: "new".to_owned() },
            File { path: dir.join("missing").join("b.json"), contents: "x".to_owned() },
        ];

        assert!(matches!(write_all(&files), Err(Failure::Staging(_))));
        assert_eq!(fs::read_to_string(&first).unwrap(), "old");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_file_is_created() {
        let dir = directory("new");
        let target = dir.join("b.json");

        assert!(write_all(&[File { path: target.clone(), contents: "{}".to_owned() }]).is_ok());
        assert_eq!(fs::read_to_string(&target).unwrap(), "{}");

        let _ = fs::remove_dir_all(&dir);
    }
}
