//! Native ports of the bundled `pre-commit-hooks`-equivalent builtins.
//!
//! Each function mirrors its TypeScript counterpart in
//! `src/commands/hook/builtins/` byte for byte (same files rewritten, same log
//! lines, same exit codes). `check-json` is deliberately NOT ported: its failure
//! messages come from V8's `JSON.parse`, so a config that uses it is handed to
//! the Node runner instead.

use std::fs;
use std::io;
use std::path::Path;
use std::process::Command;

/// A builtin: `(files, args, root)` → exit code. `Err` is an I/O failure the
/// caller reports as `builtin "<id>" crashed: <message>` with exit code 1.
pub type Builtin = fn(&[String], &[String], &Path) -> io::Result<i32>;

/// The builtin implemented here for `name`, if any.
pub fn resolve(name: &str) -> Option<Builtin> {
    match name {
        "trailing-whitespace" => Some(trailing_whitespace),
        "end-of-file-fixer" => Some(end_of_file_fixer),
        "mixed-line-ending" => Some(mixed_line_ending),
        "check-merge-conflict" => Some(check_merge_conflict),
        _ => None,
    }
}

// TAB, VT, FF, CR, SP
const fn is_ws(b: u8) -> bool {
    matches!(b, 0x09 | 0x0b | 0x0c | 0x0d | 0x20)
}

fn is_markdown(file: &str) -> bool {
    let lower = file.to_ascii_lowercase();

    [".md", ".markdown", ".mdown", ".mdx"].iter().any(|ext| lower.ends_with(ext))
}

fn trailing_whitespace(files: &[String], _args: &[String], root: &Path) -> io::Result<i32> {
    let mut rc = 0;

    for file in files {
        let markdown = is_markdown(file);
        let path = root.join(file);
        let buf = fs::read(&path)?;
        let mut out: Vec<u8> = Vec::with_capacity(buf.len());
        let mut i = 0;

        while i <= buf.len() {
            let mut end = i;

            while end < buf.len() && buf[end] != 0x0a {
                end += 1;
            }

            let had_lf = end < buf.len() && buf[end] == 0x0a;
            let mut content_end = end;
            let mut had_cr = false;

            if had_lf && end > i && buf[end - 1] == 0x0d {
                had_cr = true;
                content_end = end - 1;
            }

            let content = &buf[i..content_end];
            let mut strip_end = content.len();

            while strip_end > 0 && is_ws(content[strip_end - 1]) {
                strip_end -= 1;
            }

            let non_ws = content.iter().any(|b| !is_ws(*b));

            if markdown
                && content.len() >= 2
                && content[content.len() - 1] == 0x20
                && content[content.len() - 2] == 0x20
                && non_ws
            {
                strip_end = (strip_end + 2).min(content.len());
            }

            out.extend_from_slice(&content[..strip_end]);

            if had_cr {
                out.push(0x0d);
            }

            if had_lf {
                out.push(0x0a);
            }

            if !had_lf {
                break;
            }

            i = end + 1;
        }

        if out != buf {
            fs::write(&path, &out)?;
            println!("Fixing {file}");
            rc = 1;
        }
    }

    Ok(rc)
}

fn end_of_file_fixer(files: &[String], _args: &[String], root: &Path) -> io::Result<i32> {
    let mut rc = 0;

    for file in files {
        let path = root.join(file);
        let buf = fs::read(&path)?;

        if buf.is_empty() {
            continue;
        }

        let last = buf[buf.len() - 1];

        if last != 0x0a && last != 0x0d {
            let mut next = buf.clone();

            next.push(0x0a);
            fs::write(&path, next)?;
            println!("Fixing {file}");
            rc = 1;

            continue;
        }

        let mut end = buf.len();

        while end > 0 && (buf[end - 1] == 0x0a || buf[end - 1] == 0x0d) {
            end -= 1;
        }

        if end == 0 {
            fs::write(&path, [])?;
            println!("Fixing {file}");
            rc = 1;

            continue;
        }

        let trailing = &buf[end..];
        let keep: &[u8] = if trailing.first() == Some(&0x0d) && trailing.get(1) == Some(&0x0a) {
            &[0x0d, 0x0a]
        } else if trailing.first() == Some(&0x0d) {
            &[0x0d]
        } else {
            &[0x0a]
        };

        if trailing == keep {
            continue;
        }

        let mut next = buf[..end].to_vec();

        next.extend_from_slice(keep);
        fs::write(&path, next)?;
        println!("Fixing {file}");
        rc = 1;
    }

    Ok(rc)
}

#[derive(Clone, Copy, PartialEq)]
enum Ending {
    Cr,
    Crlf,
    Lf,
}

impl Ending {
    fn bytes(self) -> &'static [u8] {
        match self {
            Ending::Cr => &[0x0d],
            Ending::Crlf => &[0x0d, 0x0a],
            Ending::Lf => &[0x0a],
        }
    }

    fn parse(value: &str) -> Option<Ending> {
        match value {
            "cr" => Some(Ending::Cr),
            "crlf" => Some(Ending::Crlf),
            "lf" => Some(Ending::Lf),
            _ => None,
        }
    }
}

fn mixed_line_ending(files: &[String], args: &[String], root: &Path) -> io::Result<i32> {
    let mut fix_arg = "auto".to_owned();
    let mut idx = 0;

    while idx < args.len() {
        let a = &args[idx];

        if a == "-f" || a == "--fix" {
            idx += 1;

            match args.get(idx) {
                Some(next) => fix_arg = next.clone(),
                None => {
                    eprintln!("mixed-line-ending: {a} requires a value (auto|no|lf|crlf|cr)");

                    return Ok(2);
                }
            }
        } else if let Some(value) = a.strip_prefix("--fix=") {
            fix_arg = value.to_owned();
        }

        idx += 1;
    }

    if !matches!(fix_arg.as_str(), "auto" | "cr" | "crlf" | "lf" | "no") {
        eprintln!("mixed-line-ending: invalid --fix value {fix_arg}");

        return Ok(2);
    }

    let mut rc = 0;

    for file in files {
        let path = root.join(file);
        let buf = fs::read(&path)?;
        // Insertion-ordered so a tie in `auto` mode picks the first-seen ending
        // (upstream `Counter.most_common(1)`).
        let mut counts: Vec<(Ending, usize)> = Vec::new();
        let mut lines: Vec<(&[u8], Option<Ending>)> = Vec::new();
        let bump = |kind: Ending, counts: &mut Vec<(Ending, usize)>| {
            if let Some(entry) = counts.iter_mut().find(|(k, _)| *k == kind) {
                entry.1 += 1;
            } else {
                counts.push((kind, 1));
            }
        };
        let mut start = 0;
        let mut i = 0;

        while i < buf.len() {
            let b = buf[i];

            if b == 0x0d && buf.get(i + 1) == Some(&0x0a) {
                lines.push((&buf[start..i], Some(Ending::Crlf)));
                bump(Ending::Crlf, &mut counts);
                i += 1;
                start = i + 1;
            } else if b == 0x0d {
                lines.push((&buf[start..i], Some(Ending::Cr)));
                bump(Ending::Cr, &mut counts);
                start = i + 1;
            } else if b == 0x0a {
                lines.push((&buf[start..i], Some(Ending::Lf)));
                bump(Ending::Lf, &mut counts);
                start = i + 1;
            }

            i += 1;
        }

        if start < buf.len() {
            lines.push((&buf[start..], None));
        }

        let mixed = counts.len() > 1;

        if fix_arg == "no" {
            if mixed {
                println!("{file}: mixed line endings");
                rc = 1;
            }

            continue;
        }

        let target = if fix_arg == "auto" {
            if !mixed {
                continue;
            }

            let mut best: Option<(Ending, usize)> = None;

            for c in &counts {
                if best.is_none_or(|b| c.1 > b.1) {
                    best = Some(*c);
                }
            }

            best.map(|b| b.0)
        } else {
            let target = Ending::parse(&fix_arg);

            if !counts.iter().any(|(k, n)| Some(*k) != target && *n > 0) {
                continue;
            }

            target
        };

        let Some(target) = target else { continue };
        let mut out: Vec<u8> = Vec::with_capacity(buf.len());

        for (content, ending) in &lines {
            out.extend_from_slice(content);

            if ending.is_some() {
                out.extend_from_slice(target.bytes());
            }
        }

        fs::write(&path, out)?;
        println!("{file}: fixed mixed line endings");
        rc = 1;
    }

    Ok(rc)
}

/// `check_merge_conflict.py:is_in_merge`.
fn is_in_merge(root: &Path) -> bool {
    let Ok(output) = Command::new("git").args(["rev-parse", "--git-dir"]).current_dir(root).output() else {
        return false;
    };

    if !output.status.success() {
        return false;
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let git_dir = if raw.starts_with('/') { Path::new(&raw).to_path_buf() } else { root.join(&raw) };

    if !git_dir.join("MERGE_MSG").exists() {
        return false;
    }

    git_dir.join("MERGE_HEAD").exists()
        || git_dir.join("rebase-apply").exists()
        || git_dir.join("rebase-merge").exists()
}

const CONFLICT_PATTERNS: [&str; 5] = ["<<<<<<< ", "======= ", "=======\r\n", "=======\n", ">>>>>>> "];

fn check_merge_conflict(files: &[String], args: &[String], root: &Path) -> io::Result<i32> {
    let assume_in_merge = args.iter().any(|a| a == "--assume-in-merge");

    if !assume_in_merge && !is_in_merge(root) {
        return Ok(0);
    }

    let mut rc = 0;

    for file in files {
        let bytes = fs::read(root.join(file))?;
        let content = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = content.split('\n').collect();

        for (i, raw) in lines.iter().enumerate() {
            let line = if i < lines.len() - 1 { format!("{raw}\n") } else { (*raw).to_owned() };

            for pattern in CONFLICT_PATTERNS {
                if line.starts_with(pattern) {
                    println!("{file}:{}: Merge conflict string \"{}\" found", i + 1, pattern.trim());
                    rc = 1;
                }
            }
        }
    }

    Ok(rc)
}
