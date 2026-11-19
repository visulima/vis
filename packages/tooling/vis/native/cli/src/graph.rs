//! Project names and the dependency graph for a JS-only workspace, read natively.
//!
//! Mirrors `buildProjectGraph` in `packages/tooling/vis/src/config/workspace.ts` for roots whose
//! project directories `workspace::project_directories` resolves natively. Every project has a
//! `package.json` with a string `name`, and no `project.json` or overlay can add a name, an
//! implicit edge or a project type. Anything else returns `GraphResult::Delegate`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::Path;

use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};

use crate::workspace::{project_directories, Membership};

/// Outcome of building the graph of a root.
#[derive(Debug, PartialEq)]
pub enum GraphResult {
    Native(ProjectGraph),
    /// The Node CLI must answer for this root.
    Delegate,
}

#[derive(Debug, PartialEq)]
pub struct ProjectGraph {
    /// Keyed by project name, which is the `package.json` name.
    pub nodes: BTreeMap<String, Node>,
    /// Edges per source project, in the order Node emits them: `dependencies`, then
    /// `devDependencies`, then `peerDependencies`, each in key order, with a target kept once.
    pub dependencies: BTreeMap<String, Vec<Edge>>,
    /// Project directory, relative to the root, of each project name.
    pub directories: BTreeMap<String, String>,
}

#[derive(Debug, PartialEq)]
pub struct Node {
    pub name: String,
    pub project_type: ProjectType,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProjectType {
    Library,
    Application,
}

impl ProjectType {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectType::Library => "library",
            ProjectType::Application => "application",
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Edge {
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EdgeKind {
    Static,
    DevDependency,
    PeerDependency,
}

#[cfg(test)]
impl EdgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EdgeKind::Static => "static",
            EdgeKind::DevDependency => "devDependency",
            EdgeKind::PeerDependency => "peerDependency",
        }
    }
}

/// The `package.json` fields the graph reads. Everything else is ignored, as Node ignores it.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Manifest {
    name: Option<String>,
    bin: Present,
    dependencies: DepKeys,
    #[serde(rename = "devDependencies")]
    dev_dependencies: DepKeys,
    #[serde(rename = "peerDependencies")]
    peer_dependencies: DepKeys,
}

/// Whether a key is present at all. Node tests `bin !== undefined`, so `"bin": null` counts.
#[derive(Default)]
struct Present(bool);

impl<'de> Deserialize<'de> for Present {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        IgnoredAny::deserialize(deserializer)?;

        Ok(Present(true))
    }
}

/// The keys of a dependency map in Node's `Object.keys` order. A `null` field has no keys.
/// Any other shape fails to deserialize, which makes the whole manifest delegate.
#[derive(Default)]
enum DepKeys {
    #[default]
    Absent,
    Keys(Vec<String>),
}

impl<'de> Deserialize<'de> for DepKeys {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(DepKeysVisitor)
    }
}

struct DepKeysVisitor;

impl<'de> Visitor<'de> for DepKeysVisitor {
    type Value = DepKeys;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a dependency map or null")
    }

    fn visit_unit<E: de::Error>(self) -> Result<DepKeys, E> {
        Ok(DepKeys::Absent)
    }

    fn visit_none<E: de::Error>(self) -> Result<DepKeys, E> {
        Ok(DepKeys::Absent)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<DepKeys, A::Error> {
        let mut keys: Vec<String> = Vec::new();
        let mut has_index_key = false;

        while let Some(key) = map.next_key::<String>()? {
            map.next_value::<IgnoredAny>()?;

            // Node lists integer-like keys first, in numeric order. Those names are left to Node.
            has_index_key |= !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_digit());

            // A repeated key keeps the position it first had, as `JSON.parse` does.
            if !keys.contains(&key) {
                keys.push(key);
            }
        }

        if has_index_key {
            return Err(de::Error::custom("integer-like dependency key"));
        }

        Ok(DepKeys::Keys(keys))
    }
}

/// Builds the project names and dependency graph of the workspace rooted at `root`, or delegates.
///
/// `root` must satisfy the same preconditions as `workspace::project_directories`.
pub fn project_graph(root: &Path) -> GraphResult {
    resolve(root).unwrap_or(GraphResult::Delegate)
}

fn resolve(root: &Path) -> Option<GraphResult> {
    let Membership::Native(directories) = project_directories(root) else {
        return None;
    };

    let mut projects: Vec<(String, Manifest, String)> = Vec::new();
    let mut names: BTreeSet<String> = BTreeSet::new();

    for directory in &directories {
        let manifest = read_manifest(&root.join(directory).join("package.json"))?;
        let name = manifest.name.clone().filter(|name| !name.is_empty())?;

        // Node keeps the last project of a repeated name, and `__proto__` is not a plain key.
        if name == "__proto__" || !names.insert(name.clone()) {
            return None;
        }

        projects.push((name, manifest, directory.clone()));
    }

    let mut nodes = BTreeMap::new();
    let mut dependencies = BTreeMap::new();
    let mut directories = BTreeMap::new();

    for (name, manifest, directory) in &projects {
        directories.insert(name.clone(), directory.clone());

        let project_type = if manifest.bin.0 { ProjectType::Application } else { ProjectType::Library };

        nodes.insert(name.clone(), Node { name: name.clone(), project_type });

        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut edges = Vec::new();

        for (fields, kind) in [
            (&manifest.dependencies, EdgeKind::Static),
            (&manifest.dev_dependencies, EdgeKind::DevDependency),
            (&manifest.peer_dependencies, EdgeKind::PeerDependency),
        ] {
            let keys = match fields {
                DepKeys::Absent => continue,
                DepKeys::Keys(keys) => keys,
            };

            for key in keys {
                if names.contains(key) && seen.insert(key) {
                    edges.push(Edge { source: name.clone(), target: key.clone(), kind });
                }
            }
        }

        dependencies.insert(name.clone(), edges);
    }

    Some(GraphResult::Native(ProjectGraph { dependencies, directories, nodes }))
}

/// `None` when the file is missing, unreadable, or not a manifest this module reproduces.
fn read_manifest(path: &Path) -> Option<Manifest> {
    let text = fs::read_to_string(path).ok()?;

    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/graph")
    }

    /// `(source, target, kind)` triples sorted the way the TypeScript parity test sorts them.
    fn sorted_edges(graph: &ProjectGraph) -> Vec<(String, String, String)> {
        let mut edges: Vec<(String, String, String)> = graph
            .dependencies
            .values()
            .flatten()
            .map(|edge| (edge.source.clone(), edge.target.clone(), edge.kind.as_str().to_string()))
            .collect();
        edges.sort();

        edges
    }

    fn sorted_nodes(graph: &ProjectGraph) -> Vec<(String, String)> {
        let mut nodes: Vec<(String, String)> =
            graph.nodes.values().map(|node| (node.name.clone(), node.project_type.as_str().to_string())).collect();
        nodes.sort();

        nodes
    }

    fn manifest(text: &str) -> Option<Manifest> {
        serde_json::from_str(text).ok()
    }

    #[test]
    fn dependency_fields_keep_node_order_and_dedupe_targets() {
        let parsed = manifest(
            r#"{"name":"a","dependencies":{"b":"1","c":"1"},"devDependencies":{"b":"1","d":"1"},"peerDependencies":{"c":"1"}}"#,
        )
        .expect("manifest");

        let DepKeys::Keys(statics) = &parsed.dependencies else { panic!("keys") };
        let DepKeys::Keys(dev) = &parsed.dev_dependencies else { panic!("keys") };

        assert_eq!(statics, &["b", "c"]);
        assert_eq!(dev, &["b", "d"]);
    }

    #[test]
    fn repeated_dependency_key_keeps_its_first_position() {
        let parsed = manifest(r#"{"name":"a","dependencies":{"b":"1","c":"1","b":"2"}}"#).expect("manifest");

        let DepKeys::Keys(statics) = &parsed.dependencies else { panic!("keys") };

        assert_eq!(statics, &["b", "c"]);
    }

    #[test]
    fn integer_like_dependency_key_is_rejected() {
        assert!(manifest(r#"{"name":"a","dependencies":{"0":"1"}}"#).is_none());
    }

    #[test]
    fn non_object_dependency_field_is_rejected() {
        assert!(manifest(r#"{"name":"a","dependencies":["b"]}"#).is_none());
        assert!(manifest(r#"{"name":"a","dependencies":"b"}"#).is_none());
    }

    #[test]
    fn null_dependency_field_has_no_keys() {
        let parsed = manifest(r#"{"name":"a","dependencies":null}"#).expect("manifest");

        assert!(matches!(parsed.dependencies, DepKeys::Absent));
    }

    #[test]
    fn optional_dependencies_are_not_edges() {
        let parsed = manifest(r#"{"name":"a","optionalDependencies":{"b":"1"}}"#).expect("manifest");

        assert!(matches!(parsed.dependencies, DepKeys::Absent));
        assert!(matches!(parsed.dev_dependencies, DepKeys::Absent));
        assert!(matches!(parsed.peer_dependencies, DepKeys::Absent));
    }

    #[test]
    fn present_bin_null_is_an_application() {
        assert!(manifest(r#"{"name":"a","bin":null}"#).expect("manifest").bin.0);
        assert!(!manifest(r#"{"name":"a"}"#).expect("manifest").bin.0);
    }

    #[test]
    fn fixtures_match_their_expected_graph() {
        let mut checked = 0;

        for entry in fs::read_dir(fixture_root()).expect("fixture root") {
            let case = entry.expect("fixture entry").path();
            let expected: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(case.join("expected.json")).expect("expected.json"))
                    .expect("valid expected.json");
            let actual = project_graph(&case);

            match expected.get("native") {
                Some(native) => {
                    let GraphResult::Native(graph) = actual else {
                        panic!("{}: expected native, got delegate", case.display());
                    };

                    let mut want_nodes: Vec<(String, String)> = native["nodes"]
                        .as_array()
                        .expect("nodes")
                        .iter()
                        .map(|node| {
                            (
                                node["name"].as_str().expect("name").to_string(),
                                node["type"].as_str().expect("type").to_string(),
                            )
                        })
                        .collect();
                    want_nodes.sort();

                    let mut want_edges: Vec<(String, String, String)> = native["edges"]
                        .as_array()
                        .expect("edges")
                        .iter()
                        .map(|edge| {
                            (
                                edge["source"].as_str().expect("source").to_string(),
                                edge["target"].as_str().expect("target").to_string(),
                                edge["type"].as_str().expect("type").to_string(),
                            )
                        })
                        .collect();
                    want_edges.sort();

                    assert_eq!(sorted_nodes(&graph), want_nodes, "{} nodes", case.display());
                    assert_eq!(sorted_edges(&graph), want_edges, "{} edges", case.display());
                }
                None => assert_eq!(actual, GraphResult::Delegate, "{}", case.display()),
            }

            checked += 1;
        }

        assert_eq!(checked, 9, "fixture count changed");
    }

    /// A temporary project whose only candidate is `pkgs/a` with the given manifest text. Slice 1 accepts
    /// it (the name is a string), so any delegation comes from this module's own checks.
    fn project_with_candidate(manifest: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vis-graph-{}-{}", std::process::id(), manifest.len()));
        let _ = fs::remove_dir_all(&root);

        fs::create_dir_all(root.join("pkgs/a")).unwrap();
        fs::write(root.join("package.json"), r#"{"name":"root","workspaces":["pkgs/*"]}"#).unwrap();
        fs::write(root.join("pkgs/a/package.json"), manifest).unwrap();

        root
    }

    #[test]
    fn an_empty_project_name_delegates() {
        let root = project_with_candidate(r#"{"name":""}"#);

        assert_eq!(project_graph(&root), GraphResult::Delegate);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_proto_project_name_delegates() {
        let root = project_with_candidate(r#"{"name":"__proto__"}"#);

        assert_eq!(project_graph(&root), GraphResult::Delegate);

        let _ = fs::remove_dir_all(&root);
    }
}
