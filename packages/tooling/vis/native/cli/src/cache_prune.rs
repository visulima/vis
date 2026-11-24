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
//! - entries that are plain directories or files, never a symbolic link, and a tree this process can remove in full
//!   (see [`crate::removal`]); a branch directory whose name is not UTF-8 is Node's too, because Node names its
//!   mangled path in a block of its own.
//!
//! A removal that fails anyway (a race, or a restriction no check sees) is handled as Node handles it. The age and
//! size limits swallow the error and the "Pruned" line comes from counting the entries again, so the line is built
//! from the directory as it is after the removals. `--keep-last` rejects with an error: the run is then handed to
//! Node, which meets the same entry and reports it.

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
use crate::removal::{removable_directory, removable_file};

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

/// One path to remove.
struct Removal {
    path: PathBuf,
    /// Dropped by `--keep-last`, whose removal failure Node does not swallow.
    keep_last: bool,
}

/// The "Pruned" or "Nothing to prune" line of one directory, worked out from what the plan expects to remove and
/// recounted from the directory itself when a removal fails.
struct Summary {
    directory: String,
    entries_before: usize,
    bytes_before: u64,
    removed: usize,
    reclaimed: u64,
}

enum Part {
    Text(String),
    Summary(Summary),
}

/// What a run prints (pail's info and success levels go to stdout, and prune prints no other level) and removes.
struct Plan {
    layout: Layout,
    parts: Vec<Part>,
    removals: Vec<Removal>,
    /// A directory was reported gone because an earlier removal of this run takes it away.
    gone_by_removal: bool,
}

/// Answer `vis cache prune` natively, or delegate to Node. Never returns.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    let Some(plan) = plan(args) else {
        crate::delegate(raw);
    };

    let (mut failed, mut keep_last_failed) = (false, false);

    for removal in &plan.removals {
        let path = &removal.path;

        if (if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }).is_err() {
            failed = true;
            keep_last_failed |= removal.keep_last;
        }
    }

    // `--keep-last` rejects when a removal fails, which only Node can report.
    let stdout = if keep_last_failed { None } else { render(&plan, failed) };

    let Some(stdout) = stdout else {
        crate::delegate(raw);
    };

    write_streams("cache prune", &stdout, "");

    exit(0)
}

/// What the run prints. With `recount`, the "Pruned" line of each directory is rebuilt from the entries left on
/// disk, as `runPrune` does it, because a removal failed and the plan no longer says what happened. `None` when the
/// output can no longer be reproduced.
fn render(plan: &Plan, recount: bool) -> Option<String> {
    // A directory reported gone because its container was to be removed is not gone when that removal failed.
    if recount && plan.gone_by_removal {
        return None;
    }

    let mut stdout = String::new();

    for part in &plan.parts {
        match part {
            Part::Text(text) => stdout.push_str(text),
            Part::Summary(summary) if recount => {
                let after = collect_entries(&summary.directory)?;
                let bytes_after = after.iter().try_fold(0, |total, entry| add_safe(total, entry.size))?;

                stdout.push_str(&summary_message(
                    plan.layout,
                    summary.entries_before.saturating_sub(after.len()),
                    summary.bytes_before.checked_sub(bytes_after)?,
                )?);
            }
            Part::Summary(summary) => {
                stdout.push_str(&summary_message(plan.layout, summary.removed, summary.reclaimed)?)
            }
        }
    }

    Some(stdout)
}

/// The closing line of one directory. `None` for a "Nothing to prune" that pail wraps where this cannot reproduce it:
/// the em dash is one column and three bytes, and the line is printed only where both ways of counting fit it.
fn summary_message(layout: Layout, removed: usize, reclaimed: u64) -> Option<String> {
    if removed == 0 {
        if layout.width.saturating_sub(3) < NOTHING_TO_PRUNE.len() {
            return None;
        }

        return Some(layout.block(Level::Info, NOTHING_TO_PRUNE));
    }

    let noun = if removed == 1 { "y" } else { "ies" };

    Some(layout.block(Level::Success, &format!("Pruned {removed} entr{noun}, freed {}.", format_bytes(reclaimed)?)))
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
    let mut plan = Plan { layout, parts: Vec::new(), removals: Vec::new(), gone_by_removal: false };

    for directory in &directories {
        if !directory.bytes().all(|byte| byte.is_ascii_graphic()) {
            return None;
        }

        if directories.len() > 1 {
            plan.parts.push(Part::Text(layout.block(Level::Info, &format!("# {directory}"))));
        }

        prune_directory(&request, directory, layout, &mut plan)?;
    }

    Some(plan)
}

/// `runPrune` for one directory.
fn prune_directory(request: &Request, directory: &str, layout: Layout, plan: &mut Plan) -> Option<()> {
    let base = Path::new(directory);

    // A directory an earlier one of this run removed (the branch container, once it has expired) is not there any more.
    let under_removal = plan.removals.iter().any(|removal| base.starts_with(&removal.path));
    let gone = fs::metadata(base).is_err() || under_removal;

    if gone {
        plan.gone_by_removal |= under_removal;
        plan.parts.push(Part::Text(layout.block(Level::Info, &format!("No cache directory to prune at {directory}"))));

        return Some(());
    }

    let before = collect_entries(directory)?;
    let mut dropped: Vec<String> = Vec::new();

    // `--keep-last` runs first, on the list newest first.
    if let Some(keep) = request.keep_last.filter(|keep| before.len() > *keep) {
        dropped.extend(before[keep..].iter().map(|entry| entry.hash.clone()));
    }

    let dropped_by_keep_last = dropped.len();

    expire(request, base, &mut dropped)?;

    let dropped_entries: Vec<_> = before.iter().filter(|entry| dropped.contains(&entry.hash)).collect();
    let removed = dropped_entries.len();
    let reclaimed = dropped_entries.iter().try_fold(0, |total, entry| add_safe(total, entry.size))?;

    for (index, name) in dropped.iter().enumerate() {
        let path = base.join(name);

        // `--keep-last` fails on a removal that does not work, and one that fails half-way cannot be handed back.
        let metadata = fs::symlink_metadata(&path).ok()?;
        let removable = !metadata.is_symlink()
            && if metadata.is_dir() { removable_directory(&path, base) } else { removable_file(&path, base) };

        if !removable {
            return None;
        }

        plan.removals.push(Removal { path, keep_last: index < dropped_by_keep_last });
    }

    // Checked now, so that a line this cannot reproduce goes to Node before anything is removed.
    summary_message(layout, removed, reclaimed)?;

    plan.parts.push(Part::Summary(Summary {
        directory: directory.to_owned(),
        entries_before: before.len(),
        bytes_before: before.iter().try_fold(0, |total, entry| add_safe(total, entry.size))?,
        removed,
        reclaimed,
    }));

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

    /// A cache directory of `names` entries, each a directory holding one 10-byte file.
    fn scratch_cache(name: &str, entries: &[&str]) -> String {
        let directory = std::env::temp_dir().join(format!("vis-prune-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&directory);

        for entry in entries {
            fs::create_dir_all(directory.join(entry)).unwrap();
            fs::write(directory.join(entry).join("file"), "0123456789").unwrap();
        }

        directory.to_str().unwrap().to_owned()
    }

    fn summary_plan(directory: &str, removed: usize, reclaimed: u64) -> Plan {
        let layout = Layout { width: 200, colour: false };
        let entries = collect_entries(directory).unwrap();

        Plan {
            layout,
            parts: vec![Part::Summary(Summary {
                directory: directory.to_owned(),
                entries_before: entries.len(),
                bytes_before: entries.iter().map(|entry| entry.size).sum(),
                removed,
                reclaimed,
            })],
            removals: Vec::new(),
            gone_by_removal: false,
        }
    }

    #[test]
    fn the_pruned_line_reports_what_the_removals_did_not_what_the_plan_expected() {
        let directory = scratch_cache("recount", &["aaa", "bbb", "ccc"]);
        let plan = summary_plan(&directory, 2, 20);

        // The plan expected two entries to go, but only one of the removals worked.
        fs::remove_dir_all(Path::new(&directory).join("aaa")).unwrap();

        assert!(render(&plan, false).unwrap().contains("Pruned 2 entries, freed 20.0Bytes."));

        let recounted = render(&plan, true).unwrap();

        assert!(recounted.contains("Pruned 1 entry, freed 10.0Bytes."), "{recounted}");

        // Nothing went at all: the "nothing to prune" line, as Node counts it.
        fs::write(Path::new(&directory).join("zzz"), "").unwrap();
        fs::create_dir_all(Path::new(&directory).join("aaa")).unwrap();
        fs::write(Path::new(&directory).join("aaa/file"), "0123456789").unwrap();

        let untouched = summary_plan(&directory, 1, 10);

        assert!(render(&untouched, true).unwrap().contains("Nothing to prune"));

        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_container_reported_gone_is_handed_to_node_when_its_removal_failed() {
        let directory = scratch_cache("gone", &["aaa"]);
        let mut plan = summary_plan(&directory, 0, 0);

        plan.gone_by_removal = true;

        assert!(render(&plan, false).is_some());
        assert!(render(&plan, true).is_none());

        fs::remove_dir_all(&directory).unwrap();
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
