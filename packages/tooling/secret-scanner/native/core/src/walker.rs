// Directory walker built on the `ignore` crate.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{WalkBuilder, WalkState};

use crate::skip::{SkipReason, Skipped};

#[derive(Debug, Clone, Default)]
pub struct WalkOptions {
    pub respect_gitignore: bool,
    pub respect_hidden: bool,
    /// Raw gitignore-syntax lines (e.g. `dist/`, `!keep-me.env`). Applied on top of
    /// `.gitignore`, supports negation and directory markers.
    pub extra_ignores: Vec<String>,
    /// Paths to additional files whose content is gitignore-syntax. Each file is its
    /// own source and a `!` in it never re-includes what another source excluded. A
    /// `.secretlintignore` is anchored at its own directory and only matches below it;
    /// any other file is anchored at each scan root.
    pub ignore_files: Vec<PathBuf>,
    pub threads: usize,
}

/// An entry the walker could not read (an unreadable directory drops its whole
/// subtree, so callers must not treat it as clean). Only I/O failures count: glob /
/// ignore-file syntax errors are not unread content.
fn walk_error(err: &ignore::Error, path: Option<&std::path::Path>) -> Option<Skipped> {
    match err {
        ignore::Error::WithPath { path, err } => walk_error(err, Some(path)),
        ignore::Error::WithDepth { err, .. } | ignore::Error::WithLineNumber { err, .. } => walk_error(err, path),
        ignore::Error::Loop { child, .. } => Some(Skipped::file(child.clone(), SkipReason::SymlinkLoop)),
        ignore::Error::Io(io_err) => path.map(|p| Skipped::file(p.to_path_buf(), io_err.into())),
        _ => None,
    }
}

/// Synchronously walk `roots` and return every file path discovered, respecting
/// ignore rules, plus the entries it failed to read. `build_parallel` handles
/// concurrency internally, so no extra orchestration thread is spawned — a panic
/// inside the walker propagates to the caller instead of deadlocking the channel.
pub fn walk_paths_reporting(roots: &[PathBuf], opts: &WalkOptions) -> (Vec<PathBuf>, Vec<Skipped>) {
    if roots.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut builder = WalkBuilder::new(&roots[0]);
    for r in roots.iter().skip(1) {
        builder.add(r);
    }

    // `ignore` crate treats threads(0) as "auto", so pass through unchanged.
    builder
        .standard_filters(opts.respect_gitignore)
        .git_ignore(opts.respect_gitignore)
        .git_exclude(opts.respect_gitignore)
        .git_global(opts.respect_gitignore)
        .hidden(opts.respect_hidden)
        .follow_links(false)
        .threads(opts.threads);

    let cwd = std::env::current_dir().unwrap_or_default();
    let sources = ignore_file_sources(&opts.ignore_files, roots, &cwd);
    if !sources.is_empty() {
        builder.filter_entry(move |entry| {
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            if is_dir && entry.depth() == 0 {
                return true;
            }
            !excluded_by_source(&sources, &absolute(entry.path(), &cwd), is_dir)
        });
    }

    // Inline gitignore-syntax patterns. Compile once and attach via `add_custom_ignore_filename`
    // isn't an option (that takes a filename, not patterns), so we build a Gitignore matcher
    // and use it as a filter inside the parallel walker below.
    let custom_gitignore = if opts.extra_ignores.is_empty() {
        None
    } else {
        let mut b = GitignoreBuilder::new(&roots[0]);
        for pat in &opts.extra_ignores {
            if let Err(e) = b.add_line(None, pat) {
                eprintln!("secret-scanner: ignoring invalid extraIgnores pattern {pat:?}: {e}");
            }
        }
        match b.build() {
            Ok(gi) => Some(gi),
            Err(e) => {
                eprintln!("secret-scanner: failed to build extraIgnores matcher: {e}");
                None
            }
        }
    };

    let collected = Mutex::new(Vec::<PathBuf>::new());
    let errors = Mutex::new(Vec::<Skipped>::new());
    let custom = custom_gitignore.as_ref();

    builder.build_parallel().run(|| {
        let collected = &collected;
        let errors = &errors;
        Box::new(move |result| {
            let entry = match result {
                Ok(entry) => entry,
                Err(err) => {
                    if let (Some(e), Ok(mut v)) = (walk_error(&err, None), errors.lock()) {
                        v.push(e);
                    }
                    return WalkState::Continue;
                }
            };

            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if !is_file {
                return WalkState::Continue;
            }

            let path = entry.path();
            if let Some(gi) = custom {
                if gi.matched(path, false).is_ignore() {
                    return WalkState::Continue;
                }
            }

            if let Ok(mut v) = collected.lock() {
                v.push(entry.into_path());
            }
            WalkState::Continue
        })
    });

    (collected.into_inner().unwrap_or_default(), errors.into_inner().unwrap_or_default())
}

type IgnoreSource = (PathBuf, Gitignore);

const SECRETLINTIGNORE: &str = ".secretlintignore";

/// Absolute form of `path` with `.` and `..` resolved lexically, so it compares
/// component-wise against other paths spelled the same way.
fn absolute(path: &Path, cwd: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in cwd.join(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// One matcher per ignore file. A `.secretlintignore` is rooted at its own directory;
/// any other file is rooted at each scan root. Either way a `!` only re-includes paths
/// inside the file that declared it.
fn ignore_file_sources(files: &[PathBuf], scan_roots: &[PathBuf], cwd: &Path) -> Vec<IgnoreSource> {
    let scan_roots: Vec<PathBuf> = scan_roots
        .iter()
        .map(|root| {
            let root = absolute(root, cwd);
            if root.is_file() {
                root.parent().map(Path::to_path_buf).unwrap_or(root)
            } else {
                root
            }
        })
        .collect();

    files
        .iter()
        .flat_map(|file| {
            let file = absolute(file, cwd);
            let roots = if file.file_name().is_some_and(|name| name == SECRETLINTIGNORE) {
                file.parent().map(|parent| vec![parent.to_path_buf()]).unwrap_or_default()
            } else {
                scan_roots.clone()
            };
            roots.into_iter().filter_map(move |root| {
                let mut b = GitignoreBuilder::new(&root);
                if let Some(e) = b.add(&file) {
                    eprintln!("secret-scanner: ignoring invalid ignore file {}: {e}", file.display());
                }
                match b.build() {
                    Ok(gi) => Some((root, gi)),
                    Err(e) => {
                        eprintln!("secret-scanner: failed to build ignore file {}: {e}", file.display());
                        None
                    }
                }
            })
        })
        .collect()
}

fn excluded_by_source(sources: &[IgnoreSource], path: &Path, is_dir: bool) -> bool {
    sources.iter().any(|(root, gi)| {
        path.starts_with(root) && path != root && gi.matched_path_or_any_parents(path, is_dir).is_ignore()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("secret-scanner-walker-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("config")).unwrap();
        fs::create_dir_all(dir.join("app/config")).unwrap();
        for file in ["config/a.txt", "app/config/b.txt", "app/c.env", "keep.env"] {
            fs::write(dir.join(file), "x").unwrap();
        }
        dir
    }

    fn walk(root: &Path, ignore_files: Vec<PathBuf>) -> Vec<String> {
        let opts = WalkOptions { ignore_files, threads: 1, ..Default::default() };
        let (paths, _) = walk_paths_reporting(&[root.to_path_buf()], &opts);
        let mut names: Vec<String> =
            paths.iter().map(|p| p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")).collect();
        names.sort();
        names
    }

    #[test]
    fn anchored_patterns_are_relative_to_the_ignore_file_directory() {
        let dir = tree("anchored");
        let ignore = dir.join("app/.secretlintignore");
        fs::write(&ignore, "/config/\n").unwrap();

        let names = walk(&dir, vec![ignore]);
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(names, ["app/.secretlintignore", "app/c.env", "config/a.txt", "keep.env"]);
    }

    #[test]
    fn negation_stays_inside_its_own_source() {
        let dir = tree("negation");
        let exclude = dir.join("exclude.ignore");
        let except = dir.join("except.ignore");
        fs::write(&exclude, "*.env\n").unwrap();
        fs::write(&except, "!keep.env\n").unwrap();

        let names = walk(&dir, vec![exclude, except]);
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(names, ["app/config/b.txt", "config/a.txt", "except.ignore", "exclude.ignore"]);
    }

    #[test]
    fn a_source_only_matches_below_its_own_directory() {
        let dir = tree("below");
        let ignore = dir.join("config/.secretlintignore");
        fs::write(&ignore, "*\n").unwrap();

        let names = walk(&dir, vec![ignore]);
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(names, ["app/c.env", "app/config/b.txt", "keep.env"]);
    }

    #[test]
    fn an_explicit_file_is_anchored_at_the_scan_root() {
        let dir = tree("explicit");
        let ignore = dir.join("config/secrets.ignore");
        fs::write(&ignore, "/app/\n*.env\n").unwrap();

        let names = walk(&dir, vec![ignore]);
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(names, ["config/a.txt", "config/secrets.ignore"]);
    }

    #[test]
    fn a_scan_root_spelled_with_dot_dot_still_matches() {
        let dir = tree("dotdot");
        let ignore = dir.join("app/.secretlintignore");
        fs::write(&ignore, "*.env\n").unwrap();

        let spelled = dir.join("config/../app");
        let opts = WalkOptions { ignore_files: vec![ignore], threads: 1, ..Default::default() };
        let (paths, _) = walk_paths_reporting(&[spelled], &opts);
        let _ = fs::remove_dir_all(&dir);

        assert!(paths.iter().all(|p| p.extension().is_none_or(|e| e != "env")), "{paths:?}");
    }
}
