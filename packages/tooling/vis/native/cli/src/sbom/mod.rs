//! `vis sbom` — the native fast path for the CycloneDX JSON BOM of a pnpm workspace.
//!
//! The Node handler (`src/commands/sbom/handler.ts`) builds the BOM from the workspace graph and the
//! lockfile and writes it to a file, or to stdout for `--output -`. This module writes the same bytes,
//! except for the two values that are random by design: the `serialNumber` UUID and the timestamp. It answers
//! only the context and the inputs it can prove (see [`context`] and [`bom::build`]) and hands everything
//! else, unchanged, to Node. Every check runs before a file is created or a byte is printed, so a
//! delegation never follows an effect.
//!
//! Native: `vis sbom` with `--format json`, `--output <path>|-`, `--focus <a,b>` and `--include-dev`, each at
//! most once, in a CI context off a terminal, at the root of a JavaScript-only pnpm workspace whose
//! `pnpm-lock.yaml` and `package.json` files are read exactly (see `lock.rs`, `meta.rs`, `semver.rs`).
//! Node: `--format xml`, every other flag, any other lockfile manager, a `vis.config.*`, a project with a
//! `project.json`, another ecosystem's lock file at the root, a terminal, and everything the readers refuse.

mod bom;
mod json;
mod lock;
mod meta;
mod semver;

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::cache_hash::root_collation;
use crate::graph::{project_graph, GraphResult};
use crate::js;
use crate::node_context::{ci_root_context, quiet_context};
use crate::output::write_stdout;
use crate::pail::{Layout, Level};
use crate::text::is_ascii_graphic_path;
use crate::vis_config::{self, ConfigState};
use vis_core::date::iso_from_millis;

/// Lock and manifest files of the other ecosystems `vis sbom` reads from the root, which Node adds to the BOM
/// or reports on stderr as found-but-not-included.
const OTHER_ECOSYSTEM_FILES: [&str; 12] = [
    "Cargo.lock",
    "Gemfile.lock",
    "Package.resolved",
    "build.zig.zon",
    "composer.lock",
    "go.sum",
    "gradle.lockfile",
    "mix.lock",
    "packages.lock.json",
    "pom.xml",
    "pubspec.lock",
    "uv.lock",
];

struct Plan {
    include_dev: bool,
    focus: Vec<String>,
    /// `-` for stdout.
    output: String,
}

/// The value of `--name value` or `--name=value`, advancing `rest` past it. `Some(None)` when `argument` is a
/// different option, `None` when the value is missing, empty or looks like a flag (`-` itself is a value).
fn value_of<'a>(argument: &'a str, name: &str, rest: &mut impl Iterator<Item = &'a String>) -> Option<Option<&'a str>> {
    let value = if argument == name {
        rest.next()?.as_str()
    } else if let Some(value) = argument.strip_prefix(name).and_then(|after| after.strip_prefix('=')) {
        value
    } else {
        return Some(None);
    };

    (!value.is_empty() && (value == "-" || !value.starts_with('-'))).then_some(Some(value))
}

/// `output` as a path Node's `resolve` leaves as it is: plain ASCII, no spaces, one leading slash at most (`resolve`
/// folds `//a` into `/a`, which the message then shows), no `.` or `..` segment.
fn plain_output(output: &str) -> bool {
    output == "-"
        || (output.bytes().all(|byte| byte.is_ascii_graphic() && byte != b'\\')
            && !output.starts_with("//")
            && !output.ends_with('/')
            && output
                .strip_prefix('/')
                .unwrap_or(output)
                .split('/')
                .all(|segment| !segment.is_empty() && segment != "." && segment != ".."))
}

/// The arguments after `sbom`, or `None` for any shape this module does not answer.
fn parse(args: &[String]) -> Option<Plan> {
    let (mut include_dev, mut format, mut focus, mut output) = (false, false, None, None);
    let mut rest = args.iter().skip(1);

    while let Some(argument) = rest.next() {
        if argument == "--include-dev" {
            if include_dev {
                return None;
            }

            include_dev = true;

            continue;
        }

        if let Some(value) = value_of(argument, "--format", &mut rest)? {
            if format || value != "json" {
                return None;
            }

            format = true;

            continue;
        }

        if let Some(value) = value_of(argument, "--focus", &mut rest)? {
            if focus.replace(value).is_some() {
                return None;
            }

            continue;
        }

        match value_of(argument, "--output", &mut rest)? {
            Some(value) if output.is_none() && plain_output(value) => output = Some(value.to_owned()),
            _ => return None,
        }
    }

    // `focusRaw.split(",").map((name) => name.trim()).filter(Boolean)`; JavaScript's `trim` is only the ASCII one here.
    let focus = match focus {
        Some(raw) if raw.is_ascii() => {
            raw.split(',').map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned).collect()
        }
        Some(_) => return None,
        None => Vec::new(),
    };

    Some(Plan { include_dev, focus, output: output.unwrap_or_else(|| "sbom.cdx.json".to_owned()) })
}

/// Whether Node would reach the same answer: a CI context off a terminal, no output settings that change
/// the status lines, and `cwd` the workspace root of a pnpm workspace with no config.
fn context(cwd: &Path) -> bool {
    ci_root_context(cwd)
        && quiet_context(cwd, cwd)
        && vis_config::read(cwd) == ConfigState::Absent
        && root_collation()
        && !OTHER_ECOSYSTEM_FILES.iter().any(|name| cwd.join(name).exists())
}

/// `new Date().toISOString()`.
fn timestamp() -> String {
    iso_from_millis(
        i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()).unwrap_or(0),
    )
}

/// Whether the file can be written where Node writes it. `ensureDirSync` looks at the directory with `lstat`: one
/// that exists must be a real directory (a symlink to one is an error in Node), and one that is missing is made
/// with its parents, which must lead to a directory. The target itself must be a file or not exist.
fn writable(target: &Path) -> bool {
    if target.exists() && !target.is_file() {
        return false;
    }

    let Some(parent) = target.parent() else {
        return false;
    };

    match fs::symlink_metadata(parent) {
        Ok(metadata) => metadata.is_dir(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            parent.ancestors().find(|directory| directory.exists()).is_some_and(Path::is_dir)
        }
        Err(_) => false,
    }
}

/// The largest document Node reliably delivers to a pipe or socket. Its stdout is asynchronous there and the process
/// exits right after writing, so what the reader has not yet taken from the pipe's buffer (64 KiB) is lost: a
/// larger document arrives cut short, at a length that depends on how fast the reader is.
const STREAM_LIMIT: usize = 64 * 1024;

/// Whether stdout is a pipe or a socket.
#[cfg(unix)]
fn stdout_is_stream() -> bool {
    // SAFETY: `fstat` only writes the `stat` it is given.
    let mut status: libc::stat = unsafe { std::mem::zeroed() };

    if unsafe { libc::fstat(libc::STDOUT_FILENO, &mut status) } != 0 {
        return true;
    }

    matches!(status.st_mode & libc::S_IFMT, libc::S_IFIFO | libc::S_IFSOCK)
}

#[cfg(not(unix))]
fn stdout_is_stream() -> bool {
    true
}

/// Answer `vis sbom` natively, or delegate to Node. Never returns.
pub fn run(args: &[String], raw: &[OsString]) -> ! {
    match answer(args) {
        Some(code) => exit(code),
        None => crate::process::delegate(raw),
    }
}

/// The exit status when this module answered, `None` to delegate.
fn answer(args: &[String]) -> Option<i32> {
    let plan = parse(args)?;
    let cwd = env::current_dir().ok()?;

    if !context(&cwd) {
        return None;
    }

    let to_stdout = plan.output == "-";
    let layout = if to_stdout { None } else { Some(Layout::detect(args)?) };

    let GraphResult::Native(graph) = project_graph(&cwd) else {
        return None;
    };

    let options = bom::Options { focus: &plan.focus, include_dev: plan.include_dev };
    let bom = bom::build(&cwd, &graph, &options).ok()?;
    let text = bom.to_json(&timestamp(), &format!("urn:uuid:{}", js::random_uuid()?));

    let Some(layout) = layout else {
        // A document that Node would cut short on a pipe is Node's to cut short.
        if text.len() > STREAM_LIMIT && stdout_is_stream() {
            return None;
        }

        write_stdout("sbom", "the SBOM", &text);

        return Some(0);
    };

    let target: PathBuf =
        if plan.output.starts_with('/') { PathBuf::from(&plan.output) } else { cwd.join(&plan.output) };

    if !is_ascii_graphic_path(&target) || !writable(&target) {
        return None;
    }

    fs::create_dir_all(target.parent()?).ok()?;
    fs::write(&target, &text).ok()?;

    let message = layout.block(Level::Success, &format!("SBOM written to {}", target.display()))
        + &layout.block(
            Level::Notice,
            &format!("{} components, {} dependency edges", bom.component_count(), bom.dependency_count()),
        );

    write_stdout("sbom", "the confirmation", &message);

    Some(0)
}

#[cfg(test)]
mod tests {
    use super::{parse, plain_output, timestamp};

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| (*part).to_owned()).collect()
    }

    #[test]
    fn parses_the_native_shapes() {
        let plan = parse(&argv(&["sbom"])).unwrap();

        assert_eq!((plan.include_dev, plan.focus.len(), plan.output.as_str()), (false, 0, "sbom.cdx.json"));

        let plan =
            parse(&argv(&["sbom", "--format=json", "--include-dev", "--focus", "a, b,,", "--output", "-"])).unwrap();

        assert_eq!(
            (plan.include_dev, plan.focus, plan.output),
            (true, vec!["a".to_owned(), "b".to_owned()], "-".to_owned())
        );
    }

    #[test]
    fn delegates_every_other_shape() {
        for shape in [
            &["sbom", "--format", "xml"][..],
            &["sbom", "--format"],
            &["sbom", "--output"],
            &["sbom", "--output", "--include-dev"],
            &["sbom", "--output=a", "--output=b"],
            &["sbom", "--include-dev", "--include-dev"],
            &["sbom", "--include-dev=false"],
            &["sbom", "--no-include-dev"],
            &["sbom", "--focus="],
            &["sbom", "x"],
            &["sbom", "--output", "../x.json"],
            &["sbom", "--output", "a b.json"],
        ] {
            assert!(parse(&argv(shape)).is_none(), "{shape:?}");
        }
    }

    #[test]
    fn only_plain_paths_are_resolved_the_same() {
        assert!(plain_output("out/sbom.json") && plain_output("/tmp/sbom.json") && plain_output("-"));
        assert!(
            !plain_output("out//x")
                && !plain_output("./x")
                && !plain_output("out/")
                && !plain_output("a\\b")
                && !plain_output("//tmp/x")
        );
    }

    #[test]
    fn the_timestamp_is_an_iso_string_with_milliseconds() {
        let text = timestamp();

        assert_eq!(text.len(), 24);
        assert!(text.ends_with('Z') && text.as_bytes()[10] == b'T' && text.as_bytes()[19] == b'.');
    }
}
