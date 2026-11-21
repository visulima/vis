use std::collections::BTreeMap;
use xxhash_rust::xxh3::xxh3_128;

use crate::file_hasher::hex;

/// Represents the hash details for a task.
#[derive(Clone, Debug, Default)]
pub struct TaskHashDetails {
    /// The command hash.
    pub command: String,
    /// File/node hashes as key-value pairs [key, hash].
    pub nodes: Vec<Vec<String>>,
    /// Implicit dependency hashes as key-value pairs [key, hash].
    pub implicit_deps: Option<Vec<Vec<String>>>,
    /// Runtime hashes as key-value pairs [key, hash].
    pub runtime: Option<Vec<Vec<String>>>,
}

/// Appends one identity field followed by a NUL, so adjacent fields cannot run
/// together (`("ab", "c")` and `("a", "bc")` hash differently). Every hashed
/// field goes through here, so the separator rule lives in one place.
fn push_field(data: &mut Vec<u8>, bytes: &[u8]) {
    data.extend_from_slice(bytes);
    data.push(0);
}

/// Section tags for `compute_task_hash`; a section's pairs can never be read as
/// another section's.
const NODES: u8 = 1;
const IMPLICIT_DEPS: u8 = 2;
const RUNTIME: u8 = 3;

/// Appends one section of `[key, value]` pairs, sorted by key for a
/// deterministic result. The section starts with its `tag`, a presence byte
/// (`None` and `Some(vec![])` differ) and the number of pairs kept, so moving a
/// pair to another section changes the hash.
fn write_pairs(data: &mut Vec<u8>, tag: u8, pairs: Option<&[Vec<String>]>) {
    data.push(tag);

    let Some(pairs) = pairs else {
        data.push(0);

        return;
    };

    let sorted: BTreeMap<&str, &str> =
        pairs.iter().filter(|pair| pair.len() == 2).map(|pair| (pair[0].as_str(), pair[1].as_str())).collect();

    data.push(1);
    data.extend_from_slice(&(sorted.len() as u64).to_le_bytes());

    for (key, value) in sorted {
        push_field(data, key.as_bytes());
        push_field(data, value.as_bytes());
    }
}

/// Computes the command hash for a task using xxh3-128.
/// Takes project name, target name, optional configuration, and sorted overrides JSON.
pub fn hash_command(project: &str, target: &str, configuration: Option<&str>, overrides_json: &str) -> String {
    let mut data = Vec::new();

    push_field(&mut data, project.as_bytes());
    push_field(&mut data, target.as_bytes());

    // A presence tag keeps a missing configuration apart from an empty one without
    // relying on the caller never passing a NUL.
    match configuration {
        Some(config) => {
            data.push(1);
            push_field(&mut data, config.as_bytes());
        }
        None => data.push(0),
    }

    push_field(&mut data, overrides_json.as_bytes());

    let h = xxh3_128(&data);
    hex::encode(h.to_be_bytes())
}

/// Computes the final combined hash from task hash details using xxh3-128.
/// This produces the cache key used for lookup.
pub fn compute_task_hash(details: &TaskHashDetails) -> String {
    let mut data = Vec::new();

    push_field(&mut data, details.command.as_bytes());
    write_pairs(&mut data, NODES, Some(&details.nodes));
    write_pairs(&mut data, IMPLICIT_DEPS, details.implicit_deps.as_deref());
    write_pairs(&mut data, RUNTIME, details.runtime.as_deref());

    let h = xxh3_128(&data);
    hex::encode(h.to_be_bytes())
}

/// Hashes an environment variable name + value pair using xxh3-128.
pub fn hash_env_var(name: &str, value: &str) -> String {
    let mut data = Vec::new();

    push_field(&mut data, name.as_bytes());
    push_field(&mut data, value.as_bytes());

    let h = xxh3_128(&data);
    hex::encode(h.to_be_bytes())
}

#[cfg(test)]
mod tests {
    use super::{compute_task_hash, hash_command, hash_env_var, TaskHashDetails};

    fn pairs(items: &[(&str, &str)]) -> Vec<Vec<String>> {
        items.iter().map(|(key, value)| vec![(*key).to_owned(), (*value).to_owned()]).collect()
    }

    #[test]
    fn hash_command_separates_project_and_target() {
        assert_ne!(hash_command("ab", "c", None, "{}"), hash_command("a", "bc", None, "{}"));
    }

    #[test]
    fn hash_command_separates_target_and_configuration() {
        assert_ne!(hash_command("app", "build", Some("prod"), "{}"), hash_command("app", "buil", Some("dprod"), "{}"));
    }

    #[test]
    fn hash_command_tells_a_missing_configuration_from_an_empty_one() {
        assert_ne!(hash_command("app", "build", None, "{}"), hash_command("app", "build", Some(""), "{}"));
    }

    #[test]
    fn hash_command_is_stable_for_the_same_inputs() {
        assert_eq!(hash_command("app", "build", Some("prod"), "{}"), hash_command("app", "build", Some("prod"), "{}"));
    }

    #[test]
    fn hash_command_does_not_depend_on_nul_free_input() {
        assert_ne!(hash_command("app", "build", None, "{}"), hash_command("app", "build", Some("\0"), "{}"));
        assert_ne!(hash_command("app", "build", Some("\0"), "{}"), hash_command("app", "build", Some(""), "{}"));
    }

    #[test]
    fn task_hash_tells_sections_apart() {
        let nodes = TaskHashDetails { nodes: pairs(&[("a", "1")]), ..Default::default() };
        let runtime = TaskHashDetails { runtime: Some(pairs(&[("a", "1")])), ..Default::default() };
        let implicit = TaskHashDetails { implicit_deps: Some(pairs(&[("a", "1")])), ..Default::default() };

        assert_ne!(compute_task_hash(&nodes), compute_task_hash(&runtime));
        assert_ne!(compute_task_hash(&runtime), compute_task_hash(&implicit));
    }

    #[test]
    fn task_hash_tells_a_missing_section_from_an_empty_one() {
        let missing = TaskHashDetails::default();
        let empty = TaskHashDetails { implicit_deps: Some(Vec::new()), ..Default::default() };

        assert_ne!(compute_task_hash(&missing), compute_task_hash(&empty));
    }

    #[test]
    fn task_hash_ignores_pair_order() {
        let a = TaskHashDetails { nodes: pairs(&[("a", "1"), ("b", "2")]), ..Default::default() };
        let b = TaskHashDetails { nodes: pairs(&[("b", "2"), ("a", "1")]), ..Default::default() };

        assert_eq!(compute_task_hash(&a), compute_task_hash(&b));
    }

    #[test]
    fn env_var_hash_separates_name_and_value() {
        assert_ne!(hash_env_var("ab", "c"), hash_env_var("a", "bc"));
    }
}
