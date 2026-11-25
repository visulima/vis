//! Writing a file the way Node's `fs.writeFile` does, for the commands that rewrite a file in place.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// Opens `path` for the way Node's `fs.writeFile` writes it: an existing file is rewritten in place,
/// so its inode, owner, hard links, ACLs and xattrs stay as they were, and a new file gets the default
/// mode. It does not truncate, so a refused open (read-only file, a directory) leaves the file as it
/// was and the caller can still hand the command to Node.
pub(crate) fn open_for_write(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create(true).truncate(false).open(path)
}

/// Replaces the contents of the file opened by `open_for_write`. Nothing is staged in a sibling, so
/// no copy of the contents exists with a looser mode than the destination's. A failure here can
/// leave the file truncated, as it can under Node.
pub(crate) fn overwrite(file: &mut File, contents: &str) -> io::Result<()> {
    file.set_len(0)?;
    file.write_all(contents.as_bytes())
}
