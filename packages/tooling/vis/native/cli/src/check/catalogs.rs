//! `readCatalogs` of `src/util/catalog.ts` for a workspace whose dependencies are plain version ranges in the
//! `package.json` files: the root's and those of the workspace directories, each `<directory>:<dependency field>`
//! one catalog, in the order Node builds them.
//!
//! Node also reads the package manager's own catalogs (`pnpm-workspace.yaml`, the `catalog` of bun's manifest). This
//! crate does not parse them, so a workspace that has any is Node's: the text `catalog` in `pnpm-workspace.yaml` or a
//! `catalog`/`catalogs` key at the top of the manifest or of its `workspaces` object.

use std::fs;
use std::path::Path;

use crate::json::{self, Json};
use crate::workspace::{directories_for_patterns, workspace_yaml};

/// One catalog: `<directory>:<field>` and its dependencies in the order the manifest lists them.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Catalog {
    pub(super) name: String,
    pub(super) dependencies: Vec<(String, String)>,
}

/// What `--dev`, `--prod` and `--peer` ask of `getDepTypesToInclude`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Fields {
    pub(super) dev: bool,
    pub(super) peer: bool,
    pub(super) prod: bool,
}

impl Fields {
    fn dependency_fields(self) -> Vec<&'static str> {
        if self.dev {
            vec!["devDependencies"]
        } else if self.prod {
            vec!["dependencies"]
        } else if self.peer {
            vec!["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
        } else {
            vec!["dependencies", "devDependencies", "optionalDependencies"]
        }
    }
}

fn read_manifest(path: &Path) -> Result<Json, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("{} is unreadable: {error}", path.display()))?;

    json::parse(&text).ok_or_else(|| format!("{} is not JSON this crate reads the way JavaScript does", path.display()))
}

/// The workspace patterns Node resolves: the workspace YAML's `packages` list, else the manifest's `workspaces`.
fn patterns(root: &Path, manifest: &Json) -> Result<Vec<String>, String> {
    match workspace_yaml(root) {
        Err(_) => return Err("the workspace file is not one this crate reads".to_owned()),
        Ok(Some(yaml)) => return Ok(yaml.patterns),
        Ok(None) => {}
    }

    let listed = match manifest.get("workspaces") {
        None | Some(Json::Null) => return Ok(Vec::new()),
        Some(Json::Array(entries)) => entries,
        Some(Json::Object(_)) => match manifest.get("workspaces").and_then(|workspaces| workspaces.get("packages")) {
            None | Some(Json::Null) => return Ok(Vec::new()),
            Some(Json::Array(entries)) => entries,
            Some(_) => return Err("`workspaces.packages` is not a list".to_owned()),
        },
        Some(_) => return Err("`workspaces` is neither a list nor an object".to_owned()),
    };

    listed
        .iter()
        .map(|entry| entry.as_str().map(str::to_owned).ok_or_else(|| "a workspace pattern is not text".to_owned()))
        .collect()
}

/// The name of a package that counts as a workspace-owned one: `name` when it is text (`None` when it is falsy).
fn owned_name(manifest: &Json) -> Result<Option<String>, String> {
    match manifest.get("name") {
        None | Some(Json::Null | Json::Bool(false)) => Ok(None),
        Some(Json::Str(name)) if name.is_empty() => Ok(None),
        Some(Json::Str(name)) => Ok(Some(name.clone())),
        Some(_) => Err("a `name` is not text".to_owned()),
    }
}

/// `filterExternalDeps` of one dependency field, or the reason Node does something this crate cannot reproduce.
fn external(field: &Json, owned: &[String]) -> Result<Vec<(String, String)>, String> {
    let entries = match field {
        Json::Object(entries) => entries,
        // `!deps` and `typeof deps !== "object"` skip the field; an array is walked by index in Node.
        Json::Array(_) => return Err("a dependency field is a list".to_owned()),
        _ => return Ok(Vec::new()),
    };
    let mut kept = Vec::new();

    for (name, value) in entries {
        if owned.contains(name) {
            continue;
        }

        // `?` in a filter matches one UTF-16 unit in Node and one byte here, so only ASCII names are compared.
        if !name.is_ascii() {
            return Err(format!("the name {name:?} is not ASCII"));
        }

        let Json::Str(range) = value else {
            return Err(format!("the range of {name:?} is not text"));
        };

        if ["workspace:", "file:", "link:", "catalog:", "$"].iter().any(|prefix| range.starts_with(prefix)) {
            continue;
        }

        kept.push((name.clone(), range.clone()));
    }

    Ok(kept)
}

/// The catalogs of the workspace at `root`, or the reason to hand the run to Node.
pub(super) fn read(root: &Path, fields: Fields) -> Result<Vec<Catalog>, String> {
    let manifest_path = root.join("package.json");

    if !manifest_path.exists() {
        return Err("the workspace root has no package.json".to_owned());
    }

    let manifest = read_manifest(&manifest_path)?;

    for key in ["catalog", "catalogs"] {
        if manifest.get(key).is_some()
            || manifest.get("workspaces").and_then(|workspaces| workspaces.get(key)).is_some()
        {
            return Err("the manifest holds catalogs".to_owned());
        }
    }

    for yaml in ["pnpm-workspace.yaml", "aube-workspace.yaml"] {
        if fs::read_to_string(root.join(yaml)).is_ok_and(|text| text.contains("catalog")) {
            return Err(format!("{yaml} holds catalogs"));
        }
    }

    let patterns = patterns(root, &manifest)?;
    let directories =
        directories_for_patterns(root, &patterns).ok_or("the workspace patterns are not ones this crate reads")?;

    let mut manifests: Vec<(String, Json)> = vec![(".".to_owned(), manifest)];

    for directory in directories {
        let path = root.join(&directory).join("package.json");

        manifests.push((directory, read_manifest(&path)?));
    }

    let mut owned = Vec::new();

    for (_, manifest) in &manifests {
        if let Some(name) = owned_name(manifest)? {
            owned.push(name);
        }
    }

    let mut catalogs = Vec::new();

    for (directory, manifest) in &manifests {
        for field in fields.dependency_fields() {
            let Some(value) = manifest.get(field) else { continue };
            let dependencies = external(value, &owned)?;

            if !dependencies.is_empty() {
                catalogs.push(Catalog { name: format!("{directory}:{field}"), dependencies });
            }
        }
    }

    Ok(catalogs)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn scratch(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vis-check-catalogs-{}-{name}", std::process::id()));

        fs::remove_dir_all(&root).ok();

        for (path, text) in files {
            let path = root.join(path);

            fs::create_dir_all(path.parent().expect("a parent")).expect("create a directory");
            fs::write(path, text).expect("write a file");
        }

        root
    }

    fn names(catalogs: &[Catalog]) -> Vec<String> {
        catalogs.iter().map(|catalog| catalog.name.clone()).collect()
    }

    const WORKSPACE: &str = "packages:\n  - \"packages/*\"\n";

    #[test]
    fn every_dependency_field_of_every_workspace_directory_is_a_catalog() {
        let root = scratch(
            "fields",
            &[
                (
                    "package.json",
                    r#"{"name":"root","dependencies":{"a":"^1.0.0","b":"workspace:*","c":"catalog:","d":"$e","f":"file:../f"},"devDependencies":{"g":"~2.0.0"},"optionalDependencies":{},"peerDependencies":{"h":"^3"}}"#,
                ),
                ("pnpm-workspace.yaml", WORKSPACE),
                (
                    "packages/app/package.json",
                    r#"{"name":"app","dependencies":{"a":"^1.1.0","root":"^0.1.0","app":"^1.0.0"}}"#,
                ),
                ("packages/none/readme.md", "x"),
            ],
        );
        let catalogs = read(&root, Fields::default()).expect("reads");

        assert_eq!(names(&catalogs), [".:dependencies", ".:devDependencies", "packages/app:dependencies"]);
        assert_eq!(catalogs[0].dependencies, [("a".to_owned(), "^1.0.0".to_owned())]);
        assert_eq!(catalogs[2].dependencies, [("a".to_owned(), "^1.1.0".to_owned())]);
        assert_eq!(
            names(&read(&root, Fields { dev: true, ..Fields::default() }).expect("reads")),
            [".:devDependencies"]
        );
        assert_eq!(
            names(&read(&root, Fields { prod: true, ..Fields::default() }).expect("reads")),
            [".:dependencies", "packages/app:dependencies"]
        );
        assert_eq!(
            names(&read(&root, Fields { peer: true, ..Fields::default() }).expect("reads")),
            [".:dependencies", ".:devDependencies", ".:peerDependencies", "packages/app:dependencies"]
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn workspaces_of_the_manifest_apply_when_no_yaml_lists_packages() {
        let root = scratch(
            "workspaces",
            &[
                ("package.json", r#"{"workspaces":{"packages":["libs/*"]},"dependencies":{"x":"^1.0.0"}}"#),
                ("libs/a/package.json", r#"{"name":"a","devDependencies":{"y":"^2.0.0"}}"#),
            ],
        );

        assert_eq!(
            names(&read(&root, Fields::default()).expect("reads")),
            [".:dependencies", "libs/a:devDependencies"]
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn what_node_reads_differently_is_left_to_it() {
        for (name, files) in [
            (
                "yaml-catalog",
                vec![
                    ("package.json", r#"{"dependencies":{"a":"^1.0.0"}}"#),
                    ("pnpm-workspace.yaml", "packages: []\ncatalog:\n  a: ^1\n"),
                ],
            ),
            ("manifest-catalog", vec![("package.json", r#"{"catalog":{"a":"^1"}}"#)]),
            ("workspaces-catalog", vec![("package.json", r#"{"workspaces":{"packages":[],"catalogs":{}}}"#)]),
            ("no-manifest", vec![("pnpm-workspace.yaml", WORKSPACE)]),
            ("broken-manifest", vec![("package.json", "{")]),
            ("number-range", vec![("package.json", r#"{"dependencies":{"a":1}}"#)]),
            ("list-field", vec![("package.json", r#"{"dependencies":["a"]}"#)]),
            ("odd-pattern", vec![("package.json", r#"{"workspaces":["!x"]}"#)]),
            ("number-name", vec![("package.json", r#"{"name":5}"#)]),
            ("non-ascii-name", vec![("package.json", r#"{"dependencies":{"réact":"^1.0.0"}}"#)]),
            (
                "broken-member",
                vec![("package.json", "{}"), ("pnpm-workspace.yaml", WORKSPACE), ("packages/a/package.json", "{")],
            ),
        ] {
            let root = scratch(name, &files);

            assert!(read(&root, Fields::default()).is_err(), "{name}");

            fs::remove_dir_all(root).ok();
        }
    }

    #[test]
    fn a_workspace_owned_range_that_is_not_text_does_not_matter() {
        let root = scratch("owned", &[("package.json", r#"{"name":"root","dependencies":{"root":5,"a":"^1.0.0"}}"#)]);

        assert_eq!(
            read(&root, Fields::default()).expect("reads")[0].dependencies,
            [("a".to_owned(), "^1.0.0".to_owned())]
        );

        fs::remove_dir_all(root).ok();
    }
}
