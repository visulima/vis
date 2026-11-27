//! `vis shim status` — the native fast path.
//!
//! The Node handler (`src/commands/shim/handler.ts`) looks at `.vis/shims` under the working directory and at `PATH`
//! and prints two to four lines. It reads the file system and one variable, so the whole answer comes from them.
//! This module prints the same text for a CI context off a terminal at the root of a pnpm workspace (the same context
//! `task-why` answers in), and hands everything else to Node before it prints anything: any other argument, a
//! working directory or `PATH` that is not UTF-8, and a Windows system (the handler looks for `.cmd` files there).

use std::env;
use std::ffi::OsString;
use std::path::Path;
use std::process::exit;

use crate::node_context::context_is_native;
use crate::output::write_stdout;
use crate::pm_shim::SHIM_NAMES;

/// The text Node prints for the shim directory `directory` and the `PATH` entries `path`.
/// What separates the entries of `PATH`, as `path.delimiter` does in Node.
const PATH_DELIMITER: char = if cfg!(windows) { ';' } else { ':' };

fn text(directory: &Path, path: &str) -> Option<String> {
    let shown = directory.to_str()?;

    if !directory.metadata().is_ok_and(|metadata| metadata.is_dir()) {
        return Some("PM shims: not installed. Run `vis shim install`.\n".to_owned());
    }

    let missing: Vec<&str> =
        SHIM_NAMES.iter().copied().filter(|name| directory.join(name).metadata().is_err()).collect();
    let mut text = format!("PM shims: installed in {shown}\n");

    if !missing.is_empty() {
        text.push_str(&format!(
            "WARNING: {} shim(s) missing ({}). Re-run `vis shim install`.\n",
            missing.len(),
            missing.join(", ")
        ));
    }

    text.push_str(if path.split(PATH_DELIMITER).any(|entry| entry == shown) {
        "PATH: active (shim dir is on PATH).\n"
    } else {
        "PATH: NOT on PATH \u{2014} the guard is inactive until you add it.\n"
    });

    Some(text)
}

/// The text Node prints, or `None` when Node has to answer.
fn answer(args: &[String]) -> Option<String> {
    if args != ["shim", "status"] || !context_is_native() {
        return None;
    }

    let path = match env::var("PATH") {
        Ok(path) => path,
        Err(env::VarError::NotPresent) => String::new(),
        Err(env::VarError::NotUnicode(_)) => return None,
    };

    text(&env::current_dir().ok()?.join(".vis").join("shims"), &path)
}

/// Answers `vis shim status` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let Some(text) = answer(args) else { crate::process::delegate(raw_args) };

    write_stdout("shim", "the shim status", &text);

    exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_directory_is_not_installed() {
        let directory = std::env::temp_dir().join("vis-shim-status-test-missing");

        assert_eq!(text(&directory, "").as_deref(), Some("PM shims: not installed. Run `vis shim install`.\n"));
    }

    #[test]
    fn the_report_names_missing_shims_and_the_path() {
        let directory = std::env::temp_dir().join(format!("vis-shim-status-test-{}", std::process::id()));

        std::fs::create_dir_all(&directory).expect("create the shim directory");
        std::fs::write(directory.join("npm"), "").expect("write a shim");

        let shown = directory.to_str().expect("a UTF-8 temporary directory");
        let off = text(&directory, "/usr/bin").expect("a report");
        let on = text(&directory, &format!("/usr/bin{PATH_DELIMITER}{shown}")).expect("a report");

        std::fs::remove_dir_all(&directory).expect("remove the shim directory");

        assert_eq!(
            off,
            format!("PM shims: installed in {shown}\nWARNING: 5 shim(s) missing (npx, pnpm, pnpx, yarn, yarnpkg). Re-run `vis shim install`.\nPATH: NOT on PATH \u{2014} the guard is inactive until you add it.\n")
        );
        assert!(on.ends_with("PATH: active (shim dir is on PATH).\n"));
    }
}
