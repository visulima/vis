//! Native `vis x <file> [args...]` — the file runner.
//!
//! Follows nub's model: a Rust front-end that spawns the project's Node with the
//! TS/`.env`/polyfill preload (`--import dist/runtime/preload.js`), or Bun. This
//! is a CHILD process (the Node lean path runs the target in-process); the
//! behaviour is equivalent for a file runner, and skipping the vis boot is the win.
//!
//! Edge cases that genuinely need the in-process / re-exec path are delegated back
//! to the Node lean path unchanged:
//!   - `--node` escape hatch (env-stripped plain Node),
//!   - `VIS_UNFLAG` / Yarn PnP (need Node *start* flags → re-exec),
//!   - `VIS_AUGMENT_SUBPROCESS` (NODE_OPTIONS propagation).
//!
//! Runtime resolution mirrors the lean path: `--runtime` / `VIS_RUNTIME` /
//! lockfile detection (the vis-config `runtime:` pin is intentionally not read,
//! same trade-off the lean path documents).

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{self, WrapperError};

enum Runtime {
    Bun,
    Node,
}

struct Parsed {
    node: bool,
    runtime_flag: Option<String>,
    file: Option<String>,
    script_args: Vec<String>,
}

/// Parse the tokens after `vis x`. Mirrors `parseLeanXArgs`: `--node` / `--runtime`
/// are recognised only BEFORE the file; the first other token is the file and
/// everything after it is forwarded to the script (a single leading `--` between
/// the file and its args is consumed).
fn parse(args: &[String]) -> Parsed {
    let mut node = false;
    let mut runtime_flag = None;
    let mut file = None;
    let mut script_args = Vec::new();
    let mut index = 0;

    while index < args.len() {
        let token = &args[index];

        if file.is_some() {
            script_args.push(token.clone());
            index += 1;
            continue;
        }

        match token.as_str() {
            "--node" => node = true,
            "--runtime" => {
                runtime_flag = args.get(index + 1).cloned();
                index += 1;
            }
            other if other.starts_with("--runtime=") => {
                runtime_flag = Some(other["--runtime=".len()..].to_owned());
            }
            other => {
                file = Some(other.to_owned());
            }
        }

        index += 1;
    }

    if script_args.first().map(String::as_str) == Some("--") {
        script_args.remove(0);
    }

    Parsed { file, node, runtime_flag, script_args }
}

/// Walk up from `cwd` looking for `name`; true if found at any ancestor.
fn found_walking_up(cwd: &Path, name: &str) -> bool {
    let mut current = Some(cwd.to_path_buf());

    while let Some(directory) = current {
        if directory.join(name).exists() {
            return true;
        }

        current = directory.parent().map(Path::to_path_buf).filter(|parent| parent != &directory);
    }

    false
}

/// The runtime a caller asked for, with the name Node's error gives the request: a non-empty
/// `--runtime`, else a non-empty `VIS_RUNTIME` (an empty one is no request, as in `resolveRuntime`).
pub(crate) fn requested_runtime(flag: Option<&str>) -> Option<(&'static str, String)> {
    flag.filter(|value| !value.is_empty()).map(|value| ("--runtime", value.to_owned())).or_else(|| {
        env::var_os("VIS_RUNTIME")
            .map(|value| value.to_string_lossy().into_owned())
            .filter(|value| !value.is_empty())
            .map(|value| ("VIS_RUNTIME", value))
    })
}

/// The runtime of the nearest directory (from `cwd` up) that holds a lockfile of either kind; within a
/// directory the bun lockfiles come first. No lockfile at all means node. Mirrors `detectFromLockfile`.
fn runtime_from_lockfile(cwd: &Path) -> Runtime {
    const BUN: [&str; 2] = ["bun.lock", "bun.lockb"];
    const NODE: [&str; 4] = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json"];

    for directory in cwd.ancestors() {
        if BUN.iter().any(|name| directory.join(name).exists()) {
            return Runtime::Bun;
        }

        if NODE.iter().any(|name| directory.join(name).exists()) {
            return Runtime::Node;
        }
    }

    Runtime::Node
}

/// Resolve node vs bun. Mirrors the Node lean path (`resolve-runtime.ts`): an explicit
/// `--runtime`/`VIS_RUNTIME` must be `node` or `bun` (anything else is a hard error with Node's text,
/// NOT silently node); otherwise the lockfile of the nearest directory that has one decides.
/// NOTE: deliberately NOT the heavier PM detector — the lean path ignores the `packageManager` field /
/// config files / user agent.
fn resolve_runtime(flag: Option<&str>, cwd: &Path) -> Result<Runtime, String> {
    match requested_runtime(flag) {
        Some((_, value)) if value == "node" => Ok(Runtime::Node),
        Some((_, value)) if value == "bun" => Ok(Runtime::Bun),
        Some((origin, value)) => Err(format!("{origin} requested unknown runtime \"{value}\". Supported: bun, node.")),
        None => Ok(runtime_from_lockfile(cwd)),
    }
}

/// True when the runner needs the Node in-process / re-exec path (start flags or
/// loader propagation), which the native child-spawn can't provide. Yarn PnP is
/// detected by walking up for `.pnp.cjs` (it sits at the project root, not cwd).
fn needs_node_path(node_flag: bool, cwd: &Path) -> bool {
    node_flag
        || env::var_os("VIS_UNFLAG").is_some()
        || env::var_os("VIS_AUGMENT_SUBPROCESS").is_some()
        || found_walking_up(cwd, ".pnp.cjs")
}

/// The TS/.env/polyfill preload, derived from the JS fallback entry
/// (`<pkg>/dist/bin.js` → `<pkg>/dist/runtime/preload.js`).
fn preload_path() -> Option<PathBuf> {
    let entry = env::var_os("VIS_FALLBACK_ENTRY")?;

    Path::new(&entry).parent().map(|dist| dist.join("runtime").join("preload.js"))
}

/// The value of `--import` for the preload. Node takes a path on Unix; on Windows `node --import` rejects
/// `C:\...` (it reads the drive as a URL scheme), so the path goes as a `file://` URL. `None` for a Windows
/// path that is not Unicode, which no URL can name.
fn preload_specifier(preload: &Path) -> Option<OsString> {
    if cfg!(windows) {
        preload.to_str().map(|path| file_url(path).into())
    } else {
        Some(preload.as_os_str().to_owned())
    }
}

/// The `file://` URL of an absolute Windows path (`C:\a b\c.js`, `\\server\share\c.js`, or either with the
/// `\\?\` prefix), written as `pathToFileURL` does: forward slashes, the host of a UNC path as the URL host,
/// everything but unreserved characters, `/` and the drive colon percent-encoded as UTF-8.
fn file_url(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let split_host = |rest: &str| match rest.split_once('/') {
        Some((host, tail)) => (host.to_ascii_lowercase(), format!("/{tail}")),
        None => (rest.to_ascii_lowercase(), String::new()),
    };
    let (host, absolute) = if let Some(rest) = slashed.strip_prefix("//?/UNC/") {
        split_host(rest)
    } else if let Some(rest) = slashed.strip_prefix("//?/") {
        (String::new(), format!("/{rest}"))
    } else if let Some(rest) = slashed.strip_prefix("//") {
        split_host(rest)
    } else if slashed.starts_with('/') {
        (String::new(), slashed)
    } else {
        (String::new(), format!("/{slashed}"))
    };

    let mut url = format!("file://{host}");

    for byte in absolute.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                url.push(char::from(byte))
            }
            other => url.push_str(&format!("%{other:02X}")),
        }
    }

    url
}

/// Entry point. `args` is the full invocation including the leading `x` and `raw_args` the same argv as
/// the OS gave it (what the Node fallback replays, byte for byte). Never returns.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    error::finish(try_run(args, raw_args))
}

/// Runs the file and returns the exit status to adopt, or the failure to report.
fn try_run(args: &[String], raw_args: &[OsString]) -> Result<i32, WrapperError> {
    let rest = if args.len() > 1 { &args[1..] } else { &[] };
    let parsed = parse(rest);

    let file = match parsed.file {
        Some(file) => file,
        None => return Err(WrapperError::bare_usage("No file specified. Usage: vis x <file> [args...]")),
    };

    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    // Edge cases → hand the whole invocation back to the Node lean path.
    if needs_node_path(parsed.node, &cwd) {
        crate::delegate(raw_args);
    }

    let absolute = if Path::new(&file).is_absolute() { file } else { cwd.join(&file).to_string_lossy().into_owned() };

    // Node writes the bare message, without a `vis x:` prefix, and exits 1.
    let runtime = resolve_runtime(parsed.runtime_flag.as_deref(), &cwd).map_err(WrapperError::bare_usage)?;

    match runtime {
        Runtime::Bun => {
            let mut command = Command::new("bun");

            command.arg("run").arg(&absolute).args(&parsed.script_args).current_dir(&cwd);

            match command.status() {
                Ok(status) => Ok(crate::node_exit_code(status)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(WrapperError::unavailable(
                    "x",
                    "runtime is bun but the `bun` binary is not on PATH. Install it from https://bun.sh.",
                )),
                Err(error) => Err(WrapperError::launch("x", "bun", error)),
            }
        }
        Runtime::Node => {
            let preload = match preload_path() {
                Some(preload) => preload,
                None => {
                    // No launcher contract (run directly) — fall back to Node.
                    crate::delegate(raw_args);
                }
            };
            let Some(specifier) = preload_specifier(&preload) else {
                crate::delegate(raw_args);
            };

            let node = env::var("VIS_NODE").unwrap_or_else(|_| "node".to_owned());
            let mut command = Command::new(node);

            command.arg("--import").arg(&specifier).arg(&absolute).args(&parsed.script_args).current_dir(&cwd);

            // Replaces this process (or spawns and waits, off Unix); only returns the failure to
            // start it, since a started command exits with its own status.
            Err(WrapperError::launch("x", "runtime", crate::run_in_place(&mut command)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{file_url, parse, runtime_from_lockfile, Runtime};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn first_positional_is_the_file_rest_forwarded() {
        let parsed = parse(&args(&["app.ts", "--watch", "x"]));

        assert_eq!(parsed.file.as_deref(), Some("app.ts"));
        assert_eq!(parsed.script_args, ["--watch", "x"]);
        assert!(!parsed.node);
    }

    #[test]
    fn runtime_flag_before_file_in_both_forms() {
        assert_eq!(parse(&args(&["--runtime", "bun", "f.ts"])).runtime_flag.as_deref(), Some("bun"));
        assert_eq!(parse(&args(&["--runtime=bun", "f.ts"])).runtime_flag.as_deref(), Some("bun"));
    }

    #[test]
    fn node_flag_before_file() {
        let parsed = parse(&args(&["--node", "f.ts", "a"]));

        assert!(parsed.node);
        assert_eq!(parsed.file.as_deref(), Some("f.ts"));
        assert_eq!(parsed.script_args, ["a"]);
    }

    #[test]
    fn leading_double_dash_between_file_and_args_is_consumed() {
        let parsed = parse(&args(&["f.ts", "--", "--watch"]));

        assert_eq!(parsed.file.as_deref(), Some("f.ts"));
        assert_eq!(parsed.script_args, ["--watch"]);
    }

    #[test]
    fn flags_after_the_file_belong_to_the_script() {
        let parsed = parse(&args(&["f.ts", "--runtime", "bun"]));

        assert_eq!(parsed.file.as_deref(), Some("f.ts"));
        assert_eq!(parsed.runtime_flag, None);
        assert_eq!(parsed.script_args, ["--runtime", "bun"]);
    }

    #[test]
    fn a_windows_drive_path_becomes_a_file_url() {
        assert_eq!(file_url(r"C:\app\dist\runtime\preload.js"), "file:///C:/app/dist/runtime/preload.js");
        assert_eq!(file_url("D:/app/preload.js"), "file:///D:/app/preload.js");
    }

    #[test]
    fn a_path_with_spaces_and_reserved_characters_is_percent_encoded() {
        assert_eq!(file_url(r"C:\Program Files\vis #1\a%b?.js"), "file:///C:/Program%20Files/vis%20%231/a%25b%3F.js");
        assert_eq!(file_url(r"C:\Users\Jörg\preload.js"), "file:///C:/Users/J%C3%B6rg/preload.js");
    }

    #[test]
    fn a_unc_path_keeps_its_host() {
        assert_eq!(file_url(r"\\Server\share\my dir\preload.js"), "file://server/share/my%20dir/preload.js");
    }

    #[test]
    fn the_verbatim_prefix_is_dropped() {
        assert_eq!(file_url(r"\\?\C:\app\preload.js"), "file:///C:/app/preload.js");
        assert_eq!(file_url(r"\\?\UNC\server\share\preload.js"), "file://server/share/preload.js");
    }

    #[test]
    fn the_nearest_directory_with_a_lockfile_decides_the_runtime() {
        let root = std::env::temp_dir().join(format!("vis-x-runtime-{}", std::process::id()));
        let app = root.join("examples").join("app");

        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(root.join("bun.lock"), "{}").unwrap();
        assert!(matches!(runtime_from_lockfile(&app), Runtime::Bun), "a lockfile above, nothing nearer");

        std::fs::write(app.join("package-lock.json"), "{}").unwrap();
        assert!(matches!(runtime_from_lockfile(&app), Runtime::Node), "the nearer npm lockfile wins");

        std::fs::write(app.join("bun.lockb"), "").unwrap();
        assert!(matches!(runtime_from_lockfile(&app), Runtime::Bun), "within a directory bun comes first");

        let _ = std::fs::remove_dir_all(&root);
    }
}
