//! Project names and the dependency graph for a JS-only workspace, read natively.
//!
//! Mirrors `buildProjectGraph` in `packages/tooling/vis/src/config/workspace.ts` for roots whose
//! project directories `workspace::project_directories` resolves natively. Every project has a
//! `package.json` with a string `name`, and no `project.json` or overlay can add a name, an
//! implicit edge or a project type. Anything else returns `GraphResult::Delegate`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;

use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};

use crate::package_json::{parse_field, PackageJson, GRAPH_FIELDS};
use crate::workspace::{project_packages, project_packages_vetted};

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
    pub projects: BTreeMap<String, Project>,
    /// The project names in discovery order, which is the order Node holds its graph in.
    pub order: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub struct Project {
    /// The project directory, relative to the root.
    pub directory: String,
    pub project_type: ProjectType,
    /// Edges from this project, in the order Node emits them: `dependencies`, then
    /// `devDependencies`, then `peerDependencies`, each in key order, with a target kept once.
    pub edges: Vec<Edge>,
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
#[derive(Default)]
struct Manifest {
    name: Option<String>,
    /// Whether `bin` is present at all. Node tests `bin !== undefined`, so `"bin": null` counts.
    has_bin: bool,
    dependencies: DepKeys,
    dev_dependencies: DepKeys,
    peer_dependencies: DepKeys,
}

impl Manifest {
    /// The graph's reading of a parsed manifest, or `None` for a shape this module does not reproduce: a repeated
    /// field, or a dependency field that is not a map or `null`.
    fn read(package: &PackageJson) -> Option<Self> {
        if package.repeats(GRAPH_FIELDS) {
            return None;
        }

        Some(Self {
            name: package.name(),
            has_bin: package.has_bin,
            dependencies: parse_field(package.dependencies.as_deref())?,
            dev_dependencies: parse_field(package.dev_dependencies.as_deref())?,
            peer_dependencies: parse_field(package.peer_dependencies.as_deref())?,
        })
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
    project_graph_with_manifests(root).map_or(GraphResult::Delegate, |(graph, _)| GraphResult::Native(graph))
}

/// The parsed `package.json` of every project, by project name.
pub(crate) type Manifests = BTreeMap<String, PackageJson>;

/// [`project_graph`] with the manifests it was built from, so a caller that reads more of them (`vis list`) does
/// not read and parse them again. `None` where [`project_graph`] delegates.
pub(crate) fn project_graph_with_manifests(root: &Path) -> Option<(ProjectGraph, Manifests)> {
    graph_of(project_packages(root)?)
}

/// [`project_graph_with_manifests`] for a root whose `vis.config.*` the caller has read and found free of keys that
/// change the project set (see `workspace::project_directories_vetted`).
pub(crate) fn project_graph_vetted_with_manifests(root: &Path) -> Option<(ProjectGraph, Manifests)> {
    graph_of(project_packages_vetted(root)?)
}

fn graph_of(packages: Vec<(String, PackageJson)>) -> Option<(ProjectGraph, Manifests)> {
    let mut projects: Vec<(String, Manifest, String)> = Vec::new();
    let mut names: BTreeSet<String> = BTreeSet::new();
    let mut manifests = Manifests::new();

    for (directory, package) in packages {
        let manifest = Manifest::read(&package)?;
        // The membership has refused an empty name and `__proto__` already (see `PackageJson::name`).
        let name = manifest.name.clone()?;

        // Node keeps the last project of a repeated name.
        if !names.insert(name.clone()) {
            return None;
        }

        manifests.insert(name.clone(), package);
        projects.push((name, manifest, directory));
    }

    let mut graph = BTreeMap::new();

    for (name, manifest, directory) in &projects {
        let project_type = if manifest.has_bin { ProjectType::Application } else { ProjectType::Library };
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

        graph.insert(name.clone(), Project { directory: directory.clone(), project_type, edges });
    }

    let order = projects.iter().map(|(name, _, _)| name.clone()).collect();

    Some((ProjectGraph { order, projects: graph }, manifests))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/graph")
    }

    /// `(source, target, kind)` triples sorted the way the TypeScript parity test sorts them.
    fn sorted_edges(graph: &ProjectGraph) -> Vec<(String, String, String)> {
        let mut edges: Vec<(String, String, String)> = graph
            .projects
            .values()
            .flat_map(|project| &project.edges)
            .map(|edge| (edge.source.clone(), edge.target.clone(), edge.kind.as_str().to_string()))
            .collect();
        edges.sort();

        edges
    }

    fn sorted_nodes(graph: &ProjectGraph) -> Vec<(String, String)> {
        let mut nodes: Vec<(String, String)> = graph
            .projects
            .iter()
            .map(|(name, project)| (name.clone(), project.project_type.as_str().to_string()))
            .collect();
        nodes.sort();

        nodes
    }

    fn manifest(text: &str) -> Option<Manifest> {
        Manifest::read(&serde_json::from_str(text).ok()?)
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
        assert!(manifest(r#"{"name":"a","bin":null}"#).expect("manifest").has_bin);
        assert!(!manifest(r#"{"name":"a"}"#).expect("manifest").has_bin);
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
}
