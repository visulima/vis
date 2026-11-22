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

/// Resolve node vs bun. Mirrors the Node lean path (`resolve-runtime.ts`):
/// explicit `--runtime`/`VIS_RUNTIME` must be `node` or `bun` (anything else is a
/// hard error — NOT silently node); otherwise a LOCKFILE-ONLY walk (`bun.lock` /
/// `bun.lockb` -> bun, else node). NOTE: deliberately NOT the heavier PM detector
/// — the lean path ignores the `packageManager` field / config files / user agent.
fn resolve_runtime(flag: Option<&str>, cwd: &Path) -> Result<Runtime, String> {
    let explicit = flag.map(str::to_owned).or_else(|| env::var("VIS_RUNTIME").ok());

    if let Some(runtime) = explicit.as_deref() {
        if !runtime.is_empty() {
            return match runtime {
                "node" => Ok(Runtime::Node),
                "bun" => Ok(Runtime::Bun),
                other => Err(format!("unsupported runtime '{other}'. Use 'node' or 'bun'.")),
            };
        }
    }

    if found_walking_up(cwd, "bun.lock") || found_walking_up(cwd, "bun.lockb") {
        Ok(Runtime::Bun)
    } else {
        Ok(Runtime::Node)
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

/// Entry point. `args` is the full invocation including the leading `x` (so the
/// Node-fallback path can replay it verbatim). Never returns.
pub fn run(args: &[String]) -> ! {
    error::finish(try_run(args))
}

/// Runs the file and returns the exit status to adopt, or the failure to report.
fn try_run(args: &[String]) -> Result<i32, WrapperError> {
    let rest = if args.len() > 1 { &args[1..] } else { &[] };
    let parsed = parse(rest);

    let file = match parsed.file {
        Some(file) => file,
        None => return Err(WrapperError::bare_usage("No file specified. Usage: vis x <file> [args...]")),
    };

    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    // Edge cases → hand the whole invocation back to the Node lean path.
    if needs_node_path(parsed.node, &cwd) {
        crate::delegate(args);
    }

    let absolute = if Path::new(&file).is_absolute() { file } else { cwd.join(&file).to_string_lossy().into_owned() };

    let runtime =
        resolve_runtime(parsed.runtime_flag.as_deref(), &cwd).map_err(|message| WrapperError::usage("x", message))?;

    match runtime {
        Runtime::Bun => {
            let mut command = Command::new("bun");

            command.arg("run").arg(&absolute).args(&parsed.script_args).current_dir(&cwd);

            match command.status() {
                Ok(status) => Ok(crate::forward_code(status)),
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
                    crate::delegate(args);
                }
            };

            let node = env::var("VIS_NODE").unwrap_or_else(|_| "node".to_owned());
            let mut command = Command::new(node);

            command.arg("--import").arg(&preload).arg(&absolute).args(&parsed.script_args).current_dir(&cwd);

            // Replaces this process (or spawns and waits, off Unix); only returns the failure to
            // start it, since a started command exits with its own status.
            Err(WrapperError::launch("x", "runtime", crate::run_in_place(&mut command)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

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
}
