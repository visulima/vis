//! The parts of a task key that Node and the native `vis` CLI both compute, in one place.
//!
//! These are the total versions: they take what the caller already decided (which files are global inputs, what the
//! command and its overrides are) and never refuse. Whether a workspace is one the caller can reproduce is the
//! caller's question (`run_key` answers it for the CLI; the Node hasher keys whatever it is given).

use crate::file_hasher::hash_bytes;
use crate::task_hasher::hash_command;

/// The `__global__` hash of a workspace's global input files.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GlobalInputs {
    /// xxh3-128 of `name + fileHash` (no separators) for each existing global input file in `names` order, then of
    /// each `extra` part; `None` when there is none.
    pub hash: Option<String>,
    /// The first regular file that could not be read (it is left out of the hash): its path and the reason.
    pub unreadable: Option<(String, String)>,
}

/// Hashes the global inputs of a workspace: the files `names` names below `workspace_root`, then the `extra` parts
/// (the caller's own global signals, such as its `globalEnv` entries).
///
/// A name is always read below the root, an absolute one included. A path that does not exist or is a directory is
/// skipped. Anything else is read, a device or a pipe behind a symlink as well, and left out when the read fails; a
/// regular file that cannot be read is also reported in [`GlobalInputs::unreadable`], so a caller that must not key
/// on a partial read can refuse.
pub fn hash_global_inputs(workspace_root: &str, names: &[String], extra: &[String]) -> GlobalInputs {
    let mut combined = Vec::new();
    let mut unreadable = None;

    for name in names {
        let path = format!("{}/{}", workspace_root.trim_end_matches('/'), name.trim_start_matches('/'));
        let Ok(metadata) = std::fs::metadata(&path) else { continue };

        if metadata.is_dir() {
            continue;
        }

        match std::fs::read(&path) {
            Ok(content) => {
                combined.extend_from_slice(name.as_bytes());
                combined.extend_from_slice(hash_bytes(&content).as_bytes());
            }
            Err(error) if metadata.is_file() => {
                unreadable.get_or_insert_with(|| (path.clone(), error.to_string()));
            }
            Err(_) => {}
        }
    }

    for part in extra {
        combined.extend_from_slice(part.as_bytes());
    }

    GlobalInputs { hash: (!combined.is_empty()).then(|| hash_bytes(&combined)), unreadable }
}

/// The command hash of a task: [`hash_command`] over the envelope
/// `{"command":<command>,"outputs":<outputs as a JSON string>,"overrides":<overrides>}`.
///
/// `command_json` is the JSON text of the command string and `overrides_json` the JSON text of the overrides object
/// with its keys sorted, both exactly as `JSON.stringify` writes them; `outputs` is the canonical JSON text of the
/// outputs list, which the envelope carries as a string.
pub fn hash_task_command(
    project: &str,
    target: &str,
    configuration: Option<&str>,
    command_json: &str,
    outputs: &str,
    overrides_json: &str,
) -> String {
    let outputs = js_json_string(outputs);

    hash_command(
        project,
        target,
        configuration,
        &format!(r#"{{"command":{command_json},"outputs":{outputs},"overrides":{overrides_json}}}"#),
    )
}

/// Serialises `text` as `JSON.stringify` does: the escapes `\"` `\\` `\b` `\f` `\n`
/// `\r` `\t`, `\u00xx` for the other control characters, everything else verbatim
/// (Rust strings cannot hold the lone surrogates `JSON.stringify` escapes).
pub(crate) fn js_json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);

    out.push('"');

    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }

    out.push('"');

    out
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn workspace(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("key-parts-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        root
    }

    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_command_envelope_carries_command_outputs_and_overrides_in_that_order() {
        let overrides = r#"{"command":"tsc","visOptions":{}}"#;

        assert_eq!(
            hash_task_command("app", "build", Some("prod"), r#""tsc""#, r#"["dist/**"]"#, overrides),
            hash_command(
                "app",
                "build",
                Some("prod"),
                r#"{"command":"tsc","outputs":"[\"dist/**\"]","overrides":{"command":"tsc","visOptions":{}}}"#
            )
        );
    }

    #[test]
    fn global_inputs_hash_name_and_file_hash_then_the_extra_parts() {
        let root = workspace("global");

        fs::write(root.join("a.lock"), "a").unwrap();
        fs::create_dir(root.join("dir.lock")).unwrap();

        let root_str = root.to_str().unwrap();
        let all = names(&["missing", "a.lock", "dir.lock"]);
        let expected = hash_bytes(format!("a.lock{}globalEnv:X=1:y", hash_bytes(b"a")).as_bytes());

        assert_eq!(
            hash_global_inputs(root_str, &all, &["globalEnv:X=1:y".to_owned()]),
            GlobalInputs { hash: Some(expected), unreadable: None }
        );
        assert_eq!(hash_global_inputs(root_str, &names(&["missing", "dir.lock"]), &[]), GlobalInputs::default());
        assert_eq!(hash_global_inputs(root_str, &[], &["only".to_owned()]).hash, Some(hash_bytes(b"only")));
    }

    #[test]
    fn a_global_input_is_read_below_the_root_and_a_device_behind_a_symlink_is_read() {
        let root = workspace("edges");

        fs::write(root.join("extra.txt"), "e").unwrap();
        std::os::unix::fs::symlink("/dev/null", root.join(".env")).unwrap();

        let root_str = root.to_str().unwrap();
        let e = hash_bytes(b"e");
        let empty = hash_bytes(b"");

        assert_eq!(
            hash_global_inputs(root_str, &names(&["/extra.txt"]), &[]).hash,
            Some(hash_bytes(format!("/extra.txt{e}").as_bytes()))
        );
        // The path below the root is `<root>/<root>/extra.txt`, which does not exist.
        assert_eq!(hash_global_inputs(root_str, &[format!("{root_str}/extra.txt")], &[]), GlobalInputs::default());
        assert_eq!(
            hash_global_inputs(root_str, &names(&[".env"]), &[]),
            GlobalInputs { hash: Some(hash_bytes(format!(".env{empty}").as_bytes())), unreadable: None }
        );
    }

    #[test]
    fn an_unreadable_global_input_is_left_out_and_reported() {
        let root = workspace("unreadable");
        let locked = root.join("locked.lock");

        fs::write(&locked, "x").unwrap();
        fs::write(root.join("ok.lock"), "ok").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        // Running as root reads the file anyway; the assertion only holds where the permission bits apply.
        if fs::read(&locked).is_err() {
            let global = hash_global_inputs(root.to_str().unwrap(), &names(&["locked.lock", "ok.lock"]), &[]);

            assert_eq!(global.hash, Some(hash_bytes(format!("ok.lock{}", hash_bytes(b"ok")).as_bytes())));
            assert!(global.unreadable.unwrap().0.ends_with("/locked.lock"));
        }

        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
    }
}
