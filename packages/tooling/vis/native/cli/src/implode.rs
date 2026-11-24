//! `vis implode [--yes|-y]` — the native fast path.
//!
//! The Node handler (`src/commands/implode/handler.ts`) lists what it removes, strips the vis lines from the
//! shell profiles and deletes `~/.vis`. This module makes the same changes and prints the same bytes. It runs
//! only where it can reproduce all of that, and hands everything else to Node before it prints or changes
//! anything:
//!
//! - the argument shapes `implode`, `implode --yes` and `implode -y`. Without the flag Node needs a terminal
//!   to ask on and otherwise fails with a stack trace, so it answers that run, except when there is nothing
//!   to remove (`~/.vis` is not there), which prints one line either way;
//! - the quiet context of the cache commands (a pnpm workspace root, CI, no terminal on stdout or stderr, no
//!   `vis.config`, no Deno file, default output settings), and a `HOME` that is a normalised absolute path,
//!   because Node builds every path with `os.homedir()` and `@visulima/path`;
//! - a `~/.vis` that is a real directory this process may delete, and shell profiles that are regular UTF-8
//!   files. Node writes a profile through a temporary file renamed over it (which would replace a symlink, and
//!   gives the file the default mode), so the new contents are staged first and a profile that cannot be staged
//!   goes to Node with nothing changed.

use std::env;
use std::ffi::{CString, OsString};
use std::fs::{self, OpenOptions};
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::exit;

use crate::cache::{is_plain, quiet_workspace_root, resolve};
use crate::error::WrapperError;
use crate::node_context::{output_settings_are_default, quiet_context};
use crate::output::{write_stdout, write_streams};

/// `SHELL_PROFILES` in `handler.ts`, relative to the home directory, in the order Node visits them.
const PROFILES: [&str; 6] = [".zshrc", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"];

/// A profile line holding one of these is a vis line.
const MARKERS: [&str; 3] = [".vis/bin", "VIS_HOME", "# vis "];

/// A shell profile that exists, with the text to write back when it holds vis lines.
struct Profile {
    path: String,
    /// `content.includes(".vis")`: Node lists the file under "This will remove".
    listed: bool,
    /// The content without its vis lines, when that differs from the content.
    cleaned: Option<String>,
}

/// What a run does, decided before anything is printed or changed.
struct Plan {
    vis_home: String,
    /// `None` when `~/.vis` is absent: the run only reports that.
    profiles: Option<Vec<Profile>>,
}

/// Answer `vis implode` natively, or delegate to Node. Never returns.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    let Some(plan) = plan(args) else {
        crate::delegate(raw);
    };

    let Some(profiles) = &plan.profiles else {
        write_stdout("implode", "the output", "vis is not installed (no ~/.vis directory found).\n");
        exit(0);
    };

    let Some(staged) = stage(profiles) else {
        crate::delegate(raw);
    };

    let mut out = String::from("This will remove:\n");

    out.push_str(&format!("  {}/\n", plan.vis_home));

    for profile in profiles.iter().filter(|profile| profile.listed) {
        out.push_str(&format!("  Lines in {}\n", profile.path));
    }

    // `cleanShellProfiles` is non-fatal: a profile that cannot be replaced (a busy bind mount, an immutable
    // file) is warned about on stderr and left as it is, and the run goes on.
    let mut warnings = String::new();

    for (profile, temporary) in &staged {
        if fs::rename(temporary, &profile.path).is_err() {
            let _ = fs::remove_file(temporary);

            warnings.push_str(&format!("warning: could not clean {}\n", profile.path));

            continue;
        }

        out.push_str(&format!("Cleaned {}\n", profile.path));
    }

    if let Err(error) = fs::remove_dir_all(&plan.vis_home) {
        write_streams("implode", &out, &warnings);
        WrapperError::usage("implode", format!("Failed to remove {}: {error}", plan.vis_home)).exit();
    }

    out.push_str(&format!("\n\u{2713} Removed {}\n\u{2713} vis has been uninstalled.\n", plan.vis_home));

    write_streams("implode", &out, &warnings);

    exit(0)
}

/// The plan when the invocation is native, or `None` to delegate.
fn plan(args: &[String]) -> Option<Plan> {
    let yes = match args {
        [command] if command == "implode" => false,
        [command, flag] if command == "implode" && matches!(flag.as_str(), "--yes" | "-y") => true,
        _ => return None,
    };

    let cwd = env::current_dir().ok()?;
    let root = quiet_workspace_root(&cwd)?;

    if !quiet_context(&cwd, &root) || io::stdout().is_terminal() || !output_settings_are_default() {
        return None;
    }

    let home = home_directory()?;
    let vis_home = format!("{home}/.vis");

    // `isAccessibleSync(VIS_HOME)`: an inaccessible directory (including a dangling symlink) is "not installed".
    if fs::metadata(&vis_home).is_err() {
        return Some(Plan { vis_home, profiles: None });
    }

    // Without `--yes` Node asks on a terminal and fails with a stack trace without one.
    if !yes || !removable_directory(Path::new(&vis_home), Path::new(&home)) {
        return None;
    }

    let profiles = PROFILES.iter().map(|name| read_profile(&format!("{home}/{name}"))).collect::<Option<Vec<_>>>()?;

    Some(Plan { vis_home, profiles: Some(profiles.into_iter().flatten().collect()) })
}

/// `os.homedir()` as `HOME` gives it, when `join(homedir(), ...)` keeps it as written: an absolute path without
/// a trailing separator, repeated separators or `.` and `..` segments.
fn home_directory() -> Option<String> {
    let home = env::var("HOME").ok()?;

    (home.len() > 1
        && home.starts_with('/')
        && is_plain(&home)
        && !home.chars().any(char::is_control)
        && resolve(&home, &[]) == home)
        .then_some(home)
}

/// The profile at `path`: `Some(None)` when Node finds none (`isAccessibleSync` is false), `Some(Some(_))` for a
/// regular UTF-8 file, and `None` for anything else, which Node reads or rewrites in ways this path does not.
fn read_profile(path: &str) -> Option<Option<Profile>> {
    let Ok(metadata) = fs::metadata(path) else {
        return Some(None);
    };

    if fs::symlink_metadata(path).ok()?.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }

    let content = String::from_utf8(fs::read(path).ok()?).ok()?;
    let kept: Vec<&str> =
        content.split('\n').filter(|line| !MARKERS.iter().any(|marker| line.contains(marker))).collect();
    let rewritten = kept.join("\n");

    Some(Some(Profile {
        path: path.to_owned(),
        listed: content.contains(".vis"),
        cleaned: (rewritten != content).then_some(rewritten),
    }))
}

/// Whether `directory` is a real directory whose whole tree this process may remove: its parent and every
/// directory below it can be written and searched, and read.
fn removable_directory(directory: &Path, parent: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(directory) else {
        return false;
    };

    if !metadata.is_dir() || !may_modify(parent) {
        return false;
    }

    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };

    may_modify(directory)
        && entries.into_iter().all(|entry| {
            entry.is_ok_and(|entry| {
                let path = entry.path();

                !entry.file_type().is_ok_and(|kind| kind.is_dir()) || removable_directory(&path, directory)
            })
        })
}

/// `access(2)` with write and search permission, which removing an entry of `directory` needs.
fn may_modify(directory: &Path) -> bool {
    let Ok(text) = CString::new(directory.as_os_str().as_encoded_bytes()) else {
        return false;
    };

    // SAFETY: `text` is a NUL-terminated string that lives for the whole call.
    unsafe { libc::access(text.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
}

/// Writes the cleaned content of every profile that has any to a temporary file next to it. `None` (the
/// temporary files removed) when one cannot be written.
///
/// `writeFileSync` of `@visulima/fs` keeps the mode and owner of the file it replaces only for a backup, so
/// the new file has the default mode of a new file (`0666` less the umask), like the one written here.
fn stage(profiles: &[Profile]) -> Option<Vec<(&Profile, PathBuf)>> {
    let mut staged: Vec<(&Profile, PathBuf)> = Vec::new();

    for profile in profiles {
        let Some(text) = &profile.cleaned else {
            continue;
        };

        let temporary = PathBuf::from(format!("{}.vis-implode-{}", profile.path, std::process::id()));
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .and_then(|mut file| file.write_all(text.as_bytes()).and_then(|()| file.flush()));

        if written.is_err() {
            let _ = fs::remove_file(&temporary);

            for (_, path) in &staged {
                let _ = fs::remove_file(path);
            }

            return None;
        }

        staged.push((profile, temporary));
    }

    Some(staged)
}
