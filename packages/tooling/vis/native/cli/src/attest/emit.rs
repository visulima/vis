//! `vis attest <subject>` (`attestEmitExecute`) for a run with no ambient OIDC token.
//!
//! Node hashes the artifact and, finding no token to sign with, skips signing: a JSON document with
//! `--format json`, a warning otherwise. That is all this module answers. The run that signs needs Sigstore, and the
//! failures (a missing subject or workspace root, an unreadable artifact, `--require-signing`, a predicate other than
//! `slsaProvenance`) are thrown by Node with a stack trace, so they stay Node's.
//!
//! The subject must be a path that needs no normalising (no `.` or `..` segment, no trailing slash) of printable ASCII,
//! so the name Node prints is the last segment as it is.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::exit;

use sha2::{Digest, Sha256};

use super::{format_of, parse};
use crate::js::{json_string, pretty_document};
use crate::node_context::context_decline;
use crate::output::write_streams;
use crate::text::is_ascii_graphic;

/// `detectAmbientOidc`: `CI` equal to `true`, or either token variable set to anything.
fn has_ambient_oidc() -> bool {
    env::var_os("CI").is_some_and(|value| value == "true")
        || env::var_os("ACTIONS_ID_TOKEN_REQUEST_URL").is_some()
        || env::var_os("SIGSTORE_ID_TOKEN").is_some()
}

/// What a run prints.
struct Outcome {
    stdout: String,
    stderr: String,
}

/// Answers `vis attest <subject>` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Ok(outcome) => {
            write_streams("attest", &outcome.stdout, &outcome.stderr);

            exit(0)
        }
        Err(reason) => crate::process::delegate_because(&reason, raw_args),
    }
}

fn answer(args: &[String]) -> Result<Outcome, String> {
    let parsed = parse(args.get(1..).unwrap_or_default(), &["format", "output", "predicate"], &["require-signing"])
        .ok_or("not the plain flags of `attest <subject>`")?;
    let [subject] = parsed.words.as_slice() else { return Err("not exactly one subject".to_owned()) };

    // Node reads this word as the `verify` leaf wherever it stands.
    if subject == "verify" {
        return Err("the subject is named like the `verify` leaf".to_owned());
    }

    if parsed.switch("require-signing") {
        return Err("`--require-signing` fails without a token, with a stack trace".to_owned());
    }

    if parsed.value("predicate").is_some_and(|predicate| predicate != "slsaProvenance") {
        return Err("a predicate other than slsaProvenance is an error".to_owned());
    }

    let format = format_of(&parsed).ok_or("a format other than json, ndjson and table")?;

    if let Some(reason) = context_decline() {
        return Err(reason.to_owned());
    }

    if has_ambient_oidc() {
        return Err("an ambient OIDC token is present: Node signs".to_owned());
    }

    let root = env::current_dir().map_err(|error| format!("the working directory cannot be read: {error}"))?;
    let path = subject_path(&root, subject)?;
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("the subject has no file name")?;
    let sha256 = sha256_of(&path)?;

    if format == "json" {
        let stdout = pretty_document(&[
            ("ok", "false".to_owned()),
            ("reason", json_string("no-ambient-oidc")),
            ("sha256", json_string(&sha256)),
            ("skipped", "true".to_owned()),
            ("subject", json_string(name)),
        ]);

        return Ok(Outcome { stdout, stderr: String::new() });
    }

    // `logger.warn` of the toolbox writes the message and a line break to stderr. Whether it colours the line is
    // only known where the run has no colour at all, which is all this answers.
    if crate::term::piped_colour_level(args) != Some(0) {
        return Err("the colour level cannot be told to be none without Node".to_owned());
    }

    let message = format!(
        "No ambient OIDC token (not running in CI). Keyless signing needs a Fulcio identity from CI OIDC. Skipping signing (subject sha256: {sha256}). Pass --require-signing to make this fatal."
    );

    Ok(Outcome { stdout: String::new(), stderr: format!("{message}\n") })
}

/// The path of the subject: absolute as given, else below the workspace root; `Err` for a text that would need
/// normalising or that is not printable ASCII.
fn subject_path(root: &Path, subject: &str) -> Result<PathBuf, String> {
    let plain = !subject.is_empty()
        && is_ascii_graphic(subject)
        && !subject.ends_with('/')
        && !subject.contains("//")
        && subject.split('/').all(|segment| segment != "." && segment != "..");

    if !plain {
        return Err("the subject is a path that needs normalising, or is not printable ASCII".to_owned());
    }

    Ok(if subject.starts_with('/') { PathBuf::from(subject) } else { root.join(subject) })
}

/// The SHA-256 of the file, in lower-case hex; `Err` when it cannot be read (Node throws).
fn sha256_of(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("the subject cannot be read: {error}"))?;

    if !metadata.is_file() {
        return Err("the subject is not a regular file".to_owned());
    }

    let bytes = fs::read(path).map_err(|error| format!("the subject cannot be read: {error}"))?;

    Ok(Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_subject_path_needs_no_normalising() {
        let root = Path::new("/work");

        assert_eq!(subject_path(root, "dist/app.tgz").unwrap(), Path::new("/work/dist/app.tgz"));
        assert_eq!(subject_path(root, "/abs/app.tgz").unwrap(), Path::new("/abs/app.tgz"));

        for odd in ["./app.tgz", "dist/../app.tgz", "dist/", "a//b", "caf\u{e9}.tgz", "a b", "", ".."] {
            assert!(subject_path(root, odd).is_err(), "{odd:?}");
        }
    }

    #[test]
    fn the_digest_is_the_sha256_of_the_bytes() {
        let directory = std::env::temp_dir().join(format!("vis-attest-emit-{}", std::process::id()));

        fs::create_dir_all(&directory).unwrap();

        let file = directory.join("a.bin");

        fs::write(&file, b"abc").unwrap();

        assert_eq!(sha256_of(&file).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(sha256_of(&directory).is_err());
        assert!(sha256_of(&directory.join("missing")).is_err());

        fs::remove_dir_all(&directory).unwrap();
    }
}
