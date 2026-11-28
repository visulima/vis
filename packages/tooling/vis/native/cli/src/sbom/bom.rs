//! The CycloneDX 1.7 BOM of a pnpm workspace, ported from `buildCycloneDxBom`
//! (`src/sbom/cyclonedx.ts`) for the JavaScript-only case: workspace projects from the native graph, registry
//! packages from `pnpm-lock.yaml`, licence, author and references from the installed copies.
//!
//! The walk, the ordering and the key order of every object follow the Node code. Whatever it cannot
//! reproduce returns [`Unsupported`] before anything is printed or written.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::Value;

use super::json::Json;
use super::meta::{decorate, read_manifest, Decoration, Deps, Installed, License, Manifest, Unsupported};
use super::semver;
use super::xml::{Element, Unescapable};
use crate::collation::collate;
use crate::graph::{ProjectGraph, ProjectType};
use crate::pnpm_lock::{self as lock, Entry};

const SCHEMA: &str = "http://cyclonedx.org/schema/bom-1.7.schema.json";

pub(super) struct Options<'a> {
    pub(super) focus: &'a [String],
    pub(super) include_dev: bool,
}

pub(super) struct Bom {
    components: Vec<Component>,
    dependencies: Vec<(String, Vec<String>)>,
    metadata: Component,
}

struct Component {
    bom_ref: String,
    name: String,
    scope: Option<&'static str>,
    kind: &'static str,
    version: String,
    hash: Option<lock::Hash>,
    decoration: Decoration,
}

impl Bom {
    pub(super) fn component_count(&self) -> usize {
        self.components.len()
    }

    pub(super) fn dependency_count(&self) -> usize {
        self.dependencies.len()
    }

    /// `JSON.stringify(bom, undefined, 2)` plus the newline the handler appends.
    pub(super) fn to_json(&self, timestamp: &str, serial_number: &str) -> String {
        let dependencies = self.dependencies.iter().map(|(reference, depends_on)| {
            let mut entry = Vec::new();

            if !depends_on.is_empty() {
                entry.push((
                    "dependsOn",
                    Json::Array(depends_on.iter().map(|target| Json::string(target.as_str())).collect()),
                ));
            }

            entry.push(("ref", Json::string(reference.as_str())));

            Json::Object(entry)
        });

        let tool = Json::Object(vec![("name", Json::string("@visulima/vis")), ("type", Json::string("application"))]);

        let document = Json::Object(vec![
            ("$schema", Json::string(SCHEMA)),
            ("bomFormat", Json::string("CycloneDX")),
            ("components", Json::Array(self.components.iter().map(Component::to_json).collect())),
            ("dependencies", Json::Array(dependencies.collect())),
            (
                "metadata",
                Json::Object(vec![
                    ("component", self.metadata.to_json()),
                    ("lifecycles", Json::Array(vec![Json::Object(vec![("phase", Json::string("build"))])])),
                    ("timestamp", Json::string(timestamp)),
                    ("tools", Json::Object(vec![("components", Json::Array(vec![tool]))])),
                ]),
            ),
            ("serialNumber", Json::string(serial_number)),
            ("specVersion", Json::string("1.7")),
            ("version", Json::Number(1)),
        ]);

        format!("{}\n", document.pretty())
    }

    /// `serializeBomToXml(bom)`: the `metadata`, and `components` and `dependencies` where there are any. `Err` when a
    /// value is one the XML library does not escape in full (see `xml.rs`), which only Node writes.
    pub(super) fn to_xml(&self, timestamp: &str, serial_number: &str) -> Result<String, Unescapable> {
        let tool = Element::parent("component", vec![Element::text("name", "@visulima/vis")])
            .with_attribute("type", "application");
        let metadata = Element::parent(
            "metadata",
            vec![
                Element::text("timestamp", timestamp),
                Element::parent(
                    "lifecycles",
                    vec![Element::parent("lifecycle", vec![Element::text("phase", "build")])],
                ),
                Element::parent("tools", vec![Element::parent("components", vec![tool])]),
                self.metadata.to_xml(),
            ],
        );
        let mut children = vec![metadata];

        if !self.components.is_empty() {
            children.push(Element::parent("components", self.components.iter().map(Component::to_xml).collect()));
        }

        if !self.dependencies.is_empty() {
            let dependencies = self.dependencies.iter().map(|(reference, depends_on)| {
                let targets: Vec<Element> = depends_on
                    .iter()
                    .map(|target| Element::empty("dependency").with_attribute("ref", target.as_str()))
                    .collect();

                if targets.is_empty() {
                    Element::empty("dependency").with_attribute("ref", reference.as_str())
                } else {
                    Element::parent("dependency", targets).with_attribute("ref", reference.as_str())
                }
            });

            children.push(Element::parent("dependencies", dependencies.collect()));
        }

        let document = Element::parent("bom", children)
            .with_attribute("version", "1")
            .with_attribute("xmlns", "http://cyclonedx.org/schema/bom/1.7")
            .with_attribute("serialNumber", serial_number);

        Ok(format!("{}\n", document.document()?))
    }
}

impl Component {
    /// `componentToXmlElement`: the children in the order the Node code pushes them, each only where it is truthy.
    fn to_xml(&self) -> Element {
        let mut children = vec![Element::text("name", self.name.as_str())];

        if !self.version.is_empty() {
            children.push(Element::text("version", self.version.as_str()));
        }

        if let Some(description) = &self.decoration.description {
            children.push(Element::text("description", description.as_str()));
        }

        if let Some(author) = &self.decoration.author {
            children.push(Element::text("author", author.as_str()));
        }

        if let Some(hash) = &self.hash {
            let entry = Element::text("hash", hash.hex.as_str()).with_attribute("alg", hash.algorithm);

            children.push(Element::parent("hashes", vec![entry]));
        }

        if let Some(licenses) = &self.decoration.licenses {
            children.push(Element::parent("licenses", vec![license_xml(licenses)]));
        }

        children.push(Element::text("purl", self.bom_ref.as_str()));

        if let Some(scope) = self.scope {
            children.push(Element::text("scope", scope));
        }

        if !self.decoration.references.is_empty() {
            let references = self.decoration.references.iter().map(|(kind, url)| {
                Element::parent("reference", vec![Element::text("url", url.as_str())]).with_attribute("type", *kind)
            });

            children.push(Element::parent("externalReferences", references.collect()));
        }

        Element::parent("component", children)
            .with_attribute("type", self.kind)
            .with_attribute("bom-ref", self.bom_ref.as_str())
    }

    fn to_json(&self) -> Json {
        let mut fields = vec![
            ("bom-ref", Json::string(self.bom_ref.as_str())),
            ("name", Json::string(self.name.as_str())),
            ("purl", Json::string(self.bom_ref.as_str())),
        ];

        if let Some(scope) = self.scope {
            fields.push(("scope", Json::string(scope)));
        }

        fields.push(("type", Json::string(self.kind)));
        fields.push(("version", Json::string(self.version.as_str())));

        if let Some(hash) = &self.hash {
            let entry =
                Json::Object(vec![("alg", Json::string(hash.algorithm)), ("content", Json::string(hash.hex.as_str()))]);

            fields.push(("hashes", Json::Array(vec![entry])));
        }

        if let Some(description) = &self.decoration.description {
            fields.push(("description", Json::string(description.as_str())));
        }

        if let Some(author) = &self.decoration.author {
            fields.push(("author", Json::string(author.as_str())));
        }

        if let Some(licenses) = &self.decoration.licenses {
            fields.push(("licenses", Json::Array(vec![license_json(licenses)])));
        }

        if !self.decoration.references.is_empty() {
            let references = self.decoration.references.iter().map(|(kind, url)| {
                Json::Object(vec![("type", Json::string(*kind)), ("url", Json::string(url.as_str()))])
            });

            fields.push(("externalReferences", Json::Array(references.collect())));
        }

        Json::Object(fields)
    }
}

/// `licensesToXmlElement` for one entry: an expression, or a licence with its id, else its name. An entry with
/// neither is an element with no children, which the library does not write.
fn license_xml(license: &License) -> Element {
    match license {
        License::Expression(expression) => Element::text("expression", expression.as_str()),
        License::Id(id) if !id.is_empty() => Element::parent("license", vec![Element::text("id", id.as_str())]),
        License::Name(name) if !name.is_empty() => {
            Element::parent("license", vec![Element::text("name", name.as_str())])
        }
        License::Id(_) | License::Name(_) => Element::parent("license", Vec::new()),
    }
}

fn license_json(license: &License) -> Json {
    match license {
        License::Id(id) => Json::Object(vec![("license", Json::Object(vec![("id", Json::string(id.as_str()))]))]),
        License::Name(name) => {
            Json::Object(vec![("license", Json::Object(vec![("name", Json::string(name.as_str()))]))])
        }
        License::Expression(expression) => Json::Object(vec![("expression", Json::string(expression.as_str()))]),
    }
}

/// `encodeSegment`: everything outside `[A-Za-z0-9_.~-]` as `%XX`. ASCII only, as the callers ensure.
fn encode_segment(text: &str) -> String {
    text.bytes().fold(String::new(), |mut out, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'~' | b'-') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }

        out
    })
}

/// `toNpmPurl`.
fn npm_purl(name: &str, version: &str) -> String {
    let lowered = name.to_ascii_lowercase();

    if lowered.starts_with('@') {
        if let Some(slash) = lowered.find('/').filter(|&slash| slash > 0) {
            return format!(
                "pkg:npm/{}/{}@{}",
                encode_segment(&lowered[..slash]),
                encode_segment(&lowered[slash + 1..]),
                encode_segment(version)
            );
        }
    }

    format!("pkg:npm/{}@{}", encode_segment(&lowered), encode_segment(version))
}

/// A string a purl is built from. The percent-encoding of non-ASCII text goes by UTF-16 unit in Node.
fn ascii(text: &str) -> Result<&str, Unsupported> {
    if text.is_ascii() {
        Ok(text)
    } else {
        Err(Unsupported)
    }
}

/// A version or name in a `Value`: a string, or `fallback` when it is null or absent. Anything else is passed
/// through by Node as it is.
fn string_or<'a>(value: Option<&'a Value>, fallback: &'a str) -> Result<&'a str, Unsupported> {
    match value {
        None | Some(Value::Null) => Ok(fallback),
        Some(Value::String(text)) => ascii(text),
        Some(_) => Err(Unsupported),
    }
}

/// The index `name -> versions` of every lockfile entry, in lockfile order, and `resolveSpecifier`.
struct Index {
    versions: HashMap<String, Vec<String>>,
}

impl Index {
    fn new(entries: &[Entry]) -> Self {
        let mut versions: HashMap<String, Vec<String>> = HashMap::new();

        for entry in entries {
            versions.entry(entry.name.clone()).or_default().push(entry.version.clone());
        }

        Self { versions }
    }

    /// `resolveSpecifier`: an exact version, the version behind an `npm:` prefix, the greatest version in a
    /// range, and else the first version the lockfile lists.
    fn resolve(&self, name: &str, specifier: &str) -> Result<Option<String>, Unsupported> {
        let Some(versions) = self.versions.get(name).filter(|versions| !versions.is_empty()) else {
            return Ok(None);
        };

        if versions.iter().any(|version| version == specifier) {
            return Ok(Some(specifier.to_owned()));
        }

        let stripped = match specifier.split_once(':') {
            Some(("npm", rest)) if !specifier.starts_with(':') => rest,
            _ => specifier,
        };

        if stripped != specifier && versions.iter().any(|version| version == stripped) {
            return Ok(Some(stripped.to_owned()));
        }

        let best = semver::max_satisfying(versions, stripped).map_err(|_| Unsupported)?;

        Ok(Some(versions[best.unwrap_or(0)].clone()))
    }
}

/// A dependency map as `(name, specifier)` pairs; every specifier must be a string.
fn pairs(deps: &Deps) -> Result<Vec<(&str, &str)>, Unsupported> {
    match deps {
        Deps::Absent => Ok(Vec::new()),
        Deps::Other => Err(Unsupported),
        Deps::Map(entries) => entries
            .iter()
            .map(|(name, specifier)| match specifier {
                Value::String(specifier) => Ok((name.as_str(), specifier.as_str())),
                _ => Err(Unsupported),
            })
            .collect(),
    }
}

/// `collectTransitiveProjectDeps` for each focused project, with the focused names themselves.
fn focus_closure(focus: &[String], graph: &ProjectGraph) -> Result<BTreeSet<String>, Unsupported> {
    let mut result: BTreeSet<String> = BTreeSet::new();

    for name in focus {
        // Node would read `dependencies[name]` of a name that is no project (or is `constructor`).
        if !graph.projects.contains_key(name) {
            return Err(Unsupported);
        }

        result.insert(name.clone());

        let mut visited: HashSet<&str> = HashSet::from([name.as_str()]);
        let mut queue: Vec<&str> = vec![name.as_str()];
        let mut head = 0;

        while let Some(&current) = queue.get(head) {
            head += 1;

            for edge in graph.projects.get(current).into_iter().flat_map(|project| &project.edges) {
                if visited.insert(edge.target.as_str()) {
                    result.insert(edge.target.clone());
                    queue.push(edge.target.as_str());
                }
            }
        }
    }

    Ok(result)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Required,
    Optional,
}

struct Walk<'a> {
    by_ref: HashMap<String, &'a Entry>,
    index: &'a Index,
    reachable: HashMap<String, Scope>,
    edges: HashMap<String, BTreeSet<String>>,
    optional_seed: Vec<String>,
}

impl Walk<'_> {
    /// One breadth of `walk` in the Node code: required edges upgrade an optional entry, optional ones never
    /// downgrade a required one.
    fn run(&mut self, seeds: Vec<String>, scope: Scope) -> Result<(), Unsupported> {
        let mut queue = seeds;

        while let Some(reference) = queue.pop() {
            let existing = self.reachable.get(&reference).copied();

            if existing == Some(Scope::Required) || (existing == Some(Scope::Optional) && scope == Scope::Optional) {
                continue;
            }

            self.reachable.insert(reference.clone(), scope);

            let Some(entry) = self.by_ref.get(&reference).copied() else {
                continue;
            };

            let mut outgoing = self.edges.remove(&reference).unwrap_or_default();

            for map in [&entry.dependencies, &entry.peer_dependencies] {
                for (name, specifiers) in map {
                    for specifier in specifiers {
                        if let Some(version) = self.index.resolve(name, specifier)? {
                            outgoing.insert(npm_purl(ascii(name)?, ascii(&version)?));
                            queue.push(format!("{name}@{version}"));
                        }
                    }
                }
            }

            for (name, specifiers) in &entry.optional_dependencies {
                for specifier in specifiers {
                    if let Some(version) = self.index.resolve(name, specifier)? {
                        outgoing.insert(npm_purl(ascii(name)?, ascii(&version)?));
                        self.optional_seed.push(format!("{name}@{version}"));
                    }
                }
            }

            if !outgoing.is_empty() {
                self.edges.insert(reference, outgoing);
            }
        }

        Ok(())
    }
}

/// Builds the BOM of the workspace at `root`, or says it cannot do so exactly.
pub(super) fn build(root: &Path, graph: &ProjectGraph, options: &Options) -> Result<Bom, Unsupported> {
    let focused = !options.focus.is_empty();
    let mut project_names: Vec<String> = if focused {
        focus_closure(options.focus, graph)?.into_iter().collect()
    } else {
        graph.projects.keys().cloned().collect()
    };

    project_names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));

    let in_scope: HashSet<&str> = project_names.iter().map(String::as_str).collect();
    let mut manifests: Vec<(&str, Manifest)> = Vec::new();
    let mut project_components: Vec<Component> = Vec::new();
    let mut project_refs: HashMap<&str, String> = HashMap::new();

    for name in &project_names {
        let project = graph.projects.get(name).ok_or(Unsupported)?;
        let manifest = read_manifest(&root.join(&project.directory).join("package.json"))?.ok_or(Unsupported)?;
        let version = string_or(manifest.version.as_ref(), "0.0.0")?.to_owned();
        let bom_ref = npm_purl(ascii(name)?, &version);

        project_refs.insert(name, bom_ref.clone());
        project_components.push(Component {
            bom_ref,
            name: name.clone(),
            scope: None,
            kind: if project.project_type == ProjectType::Application { "application" } else { "library" },
            version,
            hash: None,
            decoration: decorate(&manifest)?,
        });
        manifests.push((name, manifest));
    }

    let lockfile = match fs::read(root.join("pnpm-lock.yaml")) {
        Ok(bytes) => lock::parse(&bytes).ok_or(Unsupported)?,
        Err(_) => return Err(Unsupported),
    };

    let index = Index::new(&lockfile);
    let mut required_seed: Vec<String> = Vec::new();
    let mut optional_seed: Vec<String> = Vec::new();
    let mut direct_edges: Vec<(&str, BTreeSet<String>)> = Vec::new();

    for (name, manifest) in &manifests {
        let mut edges: BTreeSet<String> = BTreeSet::new();
        let mut maps = vec![pairs(&manifest.dependencies)?, pairs(&manifest.peer_dependencies)?];

        if options.include_dev {
            maps.push(pairs(&manifest.dev_dependencies)?);
        }

        maps.push(pairs(&manifest.optional_dependencies)?);

        for (position, map) in maps.iter().enumerate() {
            let optional = position == maps.len() - 1;

            for (dependency, specifier) in map {
                if in_scope.contains(dependency) {
                    if let Some(reference) = project_refs.get(dependency) {
                        edges.insert(reference.clone());
                    }

                    continue;
                }

                if let Some(version) = index.resolve(dependency, specifier)? {
                    edges.insert(npm_purl(ascii(dependency)?, ascii(&version)?));
                    (if optional { &mut optional_seed } else { &mut required_seed })
                        .push(format!("{dependency}@{version}"));
                }
            }
        }

        direct_edges.push((name, edges));
    }

    let mut walk = Walk {
        by_ref: lockfile.iter().map(|entry| (format!("{}@{}", entry.name, entry.version), entry)).collect(),
        index: &index,
        reachable: HashMap::new(),
        edges: HashMap::new(),
        optional_seed,
    };

    walk.run(required_seed, Scope::Required)?;

    // The optional pass starts from the seeds the required pass collected; edges it finds itself are not walked.
    let seeds = walk.optional_seed.clone();

    walk.run(seeds, Scope::Optional)?;

    let installed = Installed::new(root);
    let mut sorted_refs: Vec<&String> = walk.reachable.keys().collect();

    sorted_refs.sort();

    let mut registry_components: Vec<Component> = Vec::new();
    let mut dependencies: Vec<(String, Vec<String>)> = Vec::new();

    for (name, edges) in &direct_edges {
        if let Some(reference) = project_refs.get(name) {
            dependencies.push((reference.clone(), edges.iter().cloned().collect()));
        }
    }

    for reference in sorted_refs {
        let Some(entry) = walk.by_ref.get(reference).copied() else {
            continue;
        };

        let purl = npm_purl(ascii(&entry.name)?, ascii(&entry.version)?);

        registry_components.push(Component {
            bom_ref: purl.clone(),
            name: entry.name.clone(),
            scope: Some(if walk.reachable[reference] == Scope::Required { "required" } else { "optional" }),
            kind: "library",
            version: entry.version.clone(),
            hash: entry.hash.as_ref().map(|hash| lock::Hash { algorithm: hash.algorithm, hex: hash.hex.clone() }),
            decoration: installed.decoration(&entry.name, &entry.version)?.unwrap_or_default(),
        });

        dependencies
            .push((purl, walk.edges.get(reference).map(|edges| edges.iter().cloned().collect()).unwrap_or_default()));
    }

    // `Array.prototype.sort` is stable, and `localeCompare` orders these ASCII purls like `collate`.
    dependencies.sort_by(|a, b| collate(&a.0, &b.0));

    let root_manifest = read_manifest(&root.join("package.json"))?;
    let metadata = match options.focus {
        [only] => {
            let found = project_components.iter().find(|component| component.name == *only).ok_or(Unsupported)?;

            Component {
                bom_ref: found.bom_ref.clone(),
                name: found.name.clone(),
                scope: None,
                kind: found.kind,
                version: found.version.clone(),
                hash: None,
                decoration: Decoration::default(),
            }
        }
        _ => {
            let name =
                string_or(root_manifest.as_ref().and_then(|manifest| manifest.name.as_ref()), "workspace")?.to_owned();
            let version =
                string_or(root_manifest.as_ref().and_then(|manifest| manifest.version.as_ref()), "0.0.0")?.to_owned();

            Component {
                bom_ref: npm_purl(&name, &version),
                name,
                scope: None,
                kind: "application",
                version,
                hash: None,
                decoration: root_manifest.as_ref().map(decorate).transpose()?.unwrap_or_default(),
            }
        }
    };

    // A project that is the metadata component is not listed twice.
    project_components.retain(|component| component.bom_ref != metadata.bom_ref);
    project_components.extend(registry_components);

    if dependencies.iter().any(|(reference, _)| !reference.bytes().all(|byte| byte.is_ascii_graphic())) {
        return Err(Unsupported);
    }

    Ok(Bom { components: project_components, dependencies, metadata })
}
