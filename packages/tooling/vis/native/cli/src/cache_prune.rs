//! `vis cache prune [--keep-last <n>] [--max-age-days <days>] [--max-size <size>] [--cache-dir <dir>] [--scope <scope>]` —
//! the native fast path.
//!
//! Mirrors `runPrune` and `cachePruneExecute` in `src/commands/cache/{prune,handler}.ts` and the `removeOldEntries` of
//! the task runner's `Cache` (`task-runner/src/cache.ts`), whose result decides the message. The whole run is worked out
//! before anything is removed: which entries `--keep-last` drops, which the age limit (7 days when none is given) and the
//! size limit then drop, in the order Node visits them, and what the "Pruned" line reports. The binary answers only what
//! it can reproduce byte for byte, with the same files left on disk, and hands everything else to Node before it prints
//! or removes anything:
//!
//! - the flags of [`parse`], each once, with plain numbers (`--keep-last` a whole number, `--max-age-days` a decimal,
//!   `--max-size` a whole number of KB, MB, GB or TB) and a known `--scope`; a value Node would reject with an error,
//!   or that its number coercion reads differently, is Node's;
//! - the quiet context of the cache commands, a layout pail's header can be reproduced for, printable ASCII paths and a
//!   message that fits one line (the "Nothing to prune" text holds an em dash, which pail's wrap counts differently);
//! - entries that are plain directories or files, never a symbolic link, and a tree this process can remove in full.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::exit;

use crate::advisories::{output_settings_are_default, write_streams};
use crate::cache::{
    add_safe, collect_entries, evict_directories, format_bytes, has_backslash, now_ms, quiet_workspace_root,
    read_settings, sorted_entries, sum_directory_size, Scope,
};
use crate::pail::{Layout, Level};
use crate::removal::{may_modify, removable_directory};

/// `DEFAULT_MAX_CACHE_AGE` of the task runner's cache: seven days.
const DEFAULT_MAX_CACHE_AGE: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// `V2_ROOT`: the content-addressed subtree, which `removeOldEntries` leaves alone.
const V2_ROOT: &str = "v2";

/// Nothing was removed. Its em dash is three bytes and one column, so it is printed only where it fits one line.
const NOTHING_TO_PRUNE: &str = "Nothing to prune \u{2014} all entries are within the configured limits.";

struct Request {
    cache_dir: Option<String>,
    scope: Scope,
    keep_last: Option<usize>,
    /// `--max-age-days` converted to milliseconds the way `handler.ts` does, in the same order of operations.
    max_age: Option<f64>,
    /// `--max-size` in bytes.
    max_size: Option<f64>,
}

/// What a run prints (pail's info and success levels go to stdout, and prune prints no other level) and removes.
struct Plan {
    stdout: String,
    removals: Vec<PathBuf>,
}

/// Answer `vis cache prune` natively, or delegate to Node. Never returns.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    let Some(plan) = plan(args) else {
        crate::delegate(raw);
    };

    for path in &plan.removals {
        let _ = if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
    }

    write_streams("cache prune", &plan.stdout, "");

    exit(0)
}

/// A whole number without a sign, a leading zero or an exponent, short enough for an exact conversion.
fn whole(value: &str) -> Option<u64> {
    let valid = !value.is_empty()
        && value.len() <= 9
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'));

    valid.then(|| value.parse().ok()).flatten()
}

/// `--max-age-days`: a decimal without a sign, a leading zero or an exponent.
fn decimal(value: &str) -> Option<f64> {
    let (integer, fraction) =
        value.split_once('.').map_or((value, None), |(integer, fraction)| (integer, Some(fraction)));

    whole(integer)?;

    if fraction.is_some_and(|digits| {
        digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        return None;
    }

    value.parse().ok()
}

/// `parseBytes` of `@visulima/humanizer` for `<whole number>KB|MB|GB|TB` (powers of 1024), which is exact in a double.
fn size(value: &str) -> Option<f64> {
    let (digits, level) = ["KB", "MB", "GB", "TB"]
        .iter()
        .enumerate()
        .find_map(|(index, unit)| Some((value.strip_suffix(unit)?, index as i32 + 1)))?;
    let count = whole(digits).filter(|count| *count > 0)?;

    Some(count as f64 * 1024f64.powi(level))
}

/// Parses the arguments after `cache prune`, or `None` for a shape that is Node's.
fn parse(args: &[String]) -> Option<Request> {
    if args.get(1).map(String::as_str) != Some("prune") {
        return None;
    }

    let (mut cache_dir, mut scope, mut keep_last, mut max_age, mut max_size) = (None, None, None, None, None);
    let mut tokens = args.iter().skip(2);

    while let Some(token) = tokens.next() {
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (token.as_str(), None),
        };

        let slot = match name {
            "--cache-dir" => &mut cache_dir,
            "--scope" => &mut scope,
            "--keep-last" => &mut keep_last,
            "--max-age-days" => &mut max_age,
            "--max-size" => &mut max_size,
            _ => return None,
        };

        let value = match inline {
            Some(value) => value,
            None => tokens.next()?.as_str(),
        };

        // An empty or dash-led value is cerebro's to interpret, and a repeated flag is an array there.
        if slot.is_some() || value.is_empty() || value.starts_with('-') {
            return None;
        }

        *slot = Some(value);
    }

    Some(Request {
        cache_dir: cache_dir.map(str::to_owned),
        scope: match scope {
            None | Some("shared") => Scope::Shared,
            Some("worktree") => Scope::Worktree,
            Some("all") => Scope::All,
            Some(_) => return None,
        },
        keep_last: match keep_last {
            None => None,
            Some(value) => Some(usize::try_from(whole(value)?).ok()?),
        },
        // `handler.ts` hands the days over as a number, and `prune.ts` multiplies them out: `days * 24 * 60 * 60 * 1000`.
        max_age: match max_age {
            None => None,
            Some(value) => Some(decimal(value)? * 24.0 * 60.0 * 60.0 * 1000.0),
        },
        max_size: match max_size {
            None => None,
            Some(value) => Some(size(value)?),
        },
    })
}

/// The plan when the invocation is native, or `None` to delegate.
fn plan(args: &[String]) -> Option<Plan> {
    let request = parse(args)?;
    let cwd = env::current_dir().ok()?;
    let root = quiet_workspace_root(&cwd)?;

    if io::stdout().is_terminal() || !output_settings_are_default() {
        return None;
    }

    let layout = Layout::detect(args)?;
    let settings = read_settings(&cwd, &root)?;
    let directories = evict_directories(&root, request.cache_dir.as_deref(), request.scope, &settings)?;
    let mut plan = Plan { stdout: String::new(), removals: Vec::new() };

    for directory in &directories {
        if !directory.bytes().all(|byte| byte.is_ascii_graphic()) {
            return None;
        }

        if directories.len() > 1 {
            plan.stdout.push_str(&layout.block(Level::Info, &format!("# {directory}")));
        }

        prune_directory(&request, directory, layout, &mut plan)?;
    }

    Some(plan)
}

/// `runPrune` for one directory.
fn prune_directory(request: &Request, directory: &str, layout: Layout, plan: &mut Plan) -> Option<()> {
    let base = Path::new(directory);

    // A directory an earlier one of this run removed (the branch container, once it has expired) is not there any more.
    let gone = fs::metadata(base).is_err() || plan.removals.iter().any(|removed| base.starts_with(removed));

    if gone {
        plan.stdout.push_str(&layout.block(Level::Info, &format!("No cache directory to prune at {directory}")));

        return Some(());
    }

    let before = collect_entries(directory)?;
    let mut dropped: Vec<String> = Vec::new();

    // `--keep-last` runs first, on the list newest first.
    if let Some(keep) = request.keep_last.filter(|keep| before.len() > *keep) {
        dropped.extend(before[keep..].iter().map(|entry| entry.hash.clone()));
    }

    expire(request, base, &mut dropped)?;

    let dropped_entries: Vec<_> = before.iter().filter(|entry| dropped.contains(&entry.hash)).collect();
    let removed = dropped_entries.len();
    let reclaimed = dropped_entries.iter().try_fold(0, |total, entry| add_safe(total, entry.size))?;

    for name in &dropped {
        let path = base.join(name);

        // `--keep-last` fails on a removal that does not work, and one that fails half-way cannot be handed back.
        let metadata = fs::symlink_metadata(&path).ok()?;
        let removable = !metadata.is_symlink()
            && if metadata.is_dir() { removable_directory(&path, base) } else { may_modify(base) };

        if !removable {
            return None;
        }

        plan.removals.push(path);
    }

    let message = if removed == 0 {
        // The em dash is one column and three bytes; the line is printed only where both ways of counting fit it.
        if layout.width.saturating_sub(3) < NOTHING_TO_PRUNE.len() {
            return None;
        }

        layout.block(Level::Info, NOTHING_TO_PRUNE)
    } else {
        let noun = if removed == 1 { "y" } else { "ies" };

        layout.block(Level::Success, &format!("Pruned {removed} entr{noun}, freed {}.", format_bytes(reclaimed)?))
    };

    plan.stdout.push_str(&message);

    Some(())
}

/// `removeOldEntries`: appends the names of the entries the age limit and then the size limit remove, in the order
/// `fs.readdir` lists them. `dropped` holds what `--keep-last` removed before, which is gone when Node looks again.
fn expire(request: &Request, base: &Path, dropped: &mut Vec<String>) -> Option<()> {
    let now = now_ms();
    let max_age = request.max_age.unwrap_or(DEFAULT_MAX_CACHE_AGE);
    let mut kept: Vec<(f64, String, u64)> = Vec::new();

    for entry in sorted_entries(base)? {
        let file_name = entry.file_name();

        if file_name.as_encoded_bytes().starts_with(b".") || file_name == V2_ROOT {
            continue;
        }

        // A name Node reads back mangled, or joins into another path, names nothing it can stat.
        let name = file_name.to_str()?.to_owned();

        if has_backslash(&file_name) {
            return None;
        }

        if dropped.contains(&name) {
            continue;
        }

        if entry.file_type().ok()?.is_symlink() {
            return None;
        }

        let Ok(metadata) = fs::metadata(entry.path()) else {
            continue;
        };
        let modified = crate::cache::mtime_ms(&metadata);

        if now - modified > max_age {
            dropped.push(name);
        } else {
            // `getDirectorySize` reads a directory and counts nothing for any other kind of entry.
            let bytes = if metadata.is_dir() { sum_directory_size(&entry.path())? } else { 0 };

            kept.push((modified, name, bytes));
        }
    }

    if let Some(limit) = request.max_size {
        // Oldest first, the order of the listing kept between equal times.
        kept.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        let mut total = kept.iter().try_fold(0, |sum, (_, _, bytes)| add_safe(sum, *bytes))? as f64;

        for (_, name, bytes) in kept {
            if total <= limit {
                break;
            }

            dropped.push(name);
            total -= bytes as f64;
        }
    }

    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|argument| (*argument).to_owned()).collect()
    }

    #[test]
    fn parses_the_flags_it_answers() {
        let request = parse(&argv(&[
            "cache",
            "prune",
            "--keep-last",
            "30",
            "--max-age-days=1.5",
            "--max-size",
            "500MB",
            "--scope",
            "all",
        ]))
        .unwrap();

        assert_eq!(request.keep_last, Some(30));
        assert_eq!(request.max_age, Some(129_600_000.0));
        assert_eq!(request.max_size, Some(524_288_000.0));
        assert!(request.scope == Scope::All);
    }

    #[test]
    fn sizes_are_powers_of_1024() {
        assert_eq!(size("10KB"), Some(10_240.0));
        assert_eq!(size("1GB"), Some(1_073_741_824.0));
        assert_eq!(size("1TB"), Some(1_099_511_627_776.0));
    }

    #[test]
    fn declines_every_other_shape() {
        for shape in [
            &["cache", "prune", "--keep-last", "-1"][..],
            &["cache", "prune", "--keep-last", "1.5"],
            &["cache", "prune", "--keep-last", "01"],
            &["cache", "prune", "--keep-last", "1e3"],
            &["cache", "prune", "--keep-last", "abc"],
            &["cache", "prune", "--max-age-days", "1e3"],
            &["cache", "prune", "--max-age-days", ".5"],
            &["cache", "prune", "--max-age-days", "5."],
            &["cache", "prune", "--max-size", "0MB"],
            &["cache", "prune", "--max-size", "500mb"],
            &["cache", "prune", "--max-size", "500 MB"],
            &["cache", "prune", "--max-size", "1.5GB"],
            &["cache", "prune", "--max-size", "500"],
            &["cache", "prune", "--max-size", "500B"],
            &["cache", "prune", "--max-size", "bogus"],
            &["cache", "prune", "--scope", "bogus"],
            &["cache", "prune", "--keep-last", "1", "--keep-last", "2"],
            &["cache", "prune", "--dry-run"],
            &["cache", "prune", "extra"],
            &["cache", "prune", "--keep-last"],
        ] {
            assert!(parse(&argv(shape)).is_none(), "{shape:?}");
        }
    }
}
