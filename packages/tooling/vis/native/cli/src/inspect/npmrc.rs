//! The registry a package comes from: `loadNpmrc` and `getRegistryForPackage` of `src/util/catalog/npmrc.ts`, for the
//! part of an `.npmrc` that decides it (`registry=` and `@scope:registry=`).
//!
//! Anything that sends a credential or reads the environment is Node's: an auth token for the registry's host (even an
//! empty one), and a `${…}` reference anywhere in a file.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

use crate::js::trim;

const NPM_REGISTRY: &str = "https://registry.npmjs.org";

struct Config {
    default_registry: String,
    registries: HashMap<String, String>,
    tokens: HashMap<String, String>,
}

impl Config {
    fn empty() -> Self {
        Self { default_registry: NPM_REGISTRY.to_owned(), registries: HashMap::new(), tokens: HashMap::new() }
    }
}

/// The scope of an `@scope:registry` key.
fn scope_of(key: &str) -> Option<&str> {
    let scope = key.strip_suffix(":registry")?;

    (scope.starts_with('@') && scope.len() > 1 && !scope.contains(':')).then_some(scope)
}

/// The host of a `//host/:_authToken` key.
fn token_host(key: &str) -> Option<&str> {
    let host = key.strip_prefix("//")?.strip_suffix("/:_authToken")?;

    (!host.is_empty()).then_some(host)
}

/// `parseNpmrc`, for a file with no `${` in it.
fn parse(content: &str) -> Config {
    let mut config = Config::empty();

    for line in content.split('\n') {
        let line = trim(line);

        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (trim(key), trim(value));

        if let Some(scope) = scope_of(key) {
            config.registries.insert(scope.to_owned(), value.to_owned());
        } else if key == "registry" {
            config.default_registry = value.to_owned();
        } else if let Some(host) = token_host(key) {
            config.tokens.insert(host.to_owned(), value.to_owned());
        }
    }

    config
}

/// `mergeNpmrcConfigs`: the project file on top of the user file; its default counts only when it is not the stock one.
fn merge(base: Config, over: Config) -> Config {
    let default_registry =
        if over.default_registry == NPM_REGISTRY { base.default_registry } else { over.default_registry };
    let (mut registries, mut tokens) = (base.registries, base.tokens);

    registries.extend(over.registries);
    tokens.extend(over.tokens);

    Config { default_registry, registries, tokens }
}

/// A file's text, `None` when it does not exist, the reason for a hand-off when Node would fail or expand it.
fn read(file: &Path) -> Result<Option<Config>, String> {
    let metadata = match fs::metadata(file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{} cannot be read: {error}", file.display())),
    };

    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", file.display()));
    }

    let text =
        fs::read_to_string(file).map_err(|error| format!("{} cannot be read as text: {error}", file.display()))?;

    if text.contains("${") {
        return Err(format!("{} refers to the environment with `${{…}}`", file.display()));
    }

    Ok(Some(parse(&text)))
}

/// The registry URL for `name`, read from `~/.npmrc` and `<root>/.npmrc`, or the reason for a hand-off.
pub(super) fn registry_for(name: &str, home: &Path, root: &Path) -> Result<String, String> {
    let user = read(&home.join(".npmrc"))?;
    let project = read(&root.join(".npmrc"))?;
    let config = match (user, project) {
        (Some(user), Some(project)) => merge(user, project),
        (Some(only), None) | (None, Some(only)) => only,
        (None, None) => Config::empty(),
    };

    let scope_registry = name
        .starts_with('@')
        .then(|| name.split('/').next().and_then(|scope| config.registries.get(scope)))
        .flatten()
        .filter(|registry| !registry.is_empty());
    let url = scope_registry.unwrap_or(&config.default_registry);
    let without_scheme = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")).unwrap_or(url);
    let host = without_scheme.strip_suffix('/').unwrap_or(without_scheme);

    if config.tokens.contains_key(host) {
        return Err(format!("the registry {host} has an auth token in an .npmrc"));
    }

    Ok(url.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(name: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

        let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("vis-inspect-npmrc-{name}-{}-{count}", std::process::id()));

        fs::create_dir_all(&path).unwrap();

        path
    }

    fn registry(name: &str, user: Option<&str>, project: Option<&str>) -> Result<String, String> {
        let (home, root) = (directory("home"), directory("root"));

        for (dir, content) in [(&home, user), (&root, project)] {
            let file = dir.join(".npmrc");

            match content {
                Some(content) => fs::write(&file, content).unwrap(),
                None => drop(fs::remove_file(&file)),
            }
        }

        registry_for(name, &home, &root)
    }

    #[test]
    fn the_default_registry_is_npm() {
        assert_eq!(registry("pkg", None, None).unwrap(), "https://registry.npmjs.org");
    }

    #[test]
    fn the_project_file_wins_unless_it_names_the_stock_registry() {
        assert_eq!(registry("pkg", Some("registry=http://user.test/\n"), None).unwrap(), "http://user.test/");
        assert_eq!(
            registry("pkg", Some("registry=http://user.test/"), Some("registry=http://project.test")).unwrap(),
            "http://project.test"
        );
        assert_eq!(
            registry("pkg", Some("registry=http://user.test/"), Some("registry=https://registry.npmjs.org")).unwrap(),
            "http://user.test/"
        );
        assert_eq!(
            registry(
                "pkg",
                Some("registry=http://a.test"),
                Some("# c\n; c\nregistry = http://b.test \r\nregistry=http://c.test\n")
            )
            .unwrap(),
            "http://c.test"
        );
    }

    #[test]
    fn a_scope_has_its_own_registry() {
        let project = "registry=http://all.test\n@scope:registry=http://scoped.test\n@empty:registry=\n";

        assert_eq!(registry("@scope/pkg", None, Some(project)).unwrap(), "http://scoped.test");
        assert_eq!(registry("@other/pkg", None, Some(project)).unwrap(), "http://all.test");
        assert_eq!(registry("@empty/pkg", None, Some(project)).unwrap(), "http://all.test");
        assert_eq!(registry("scope", None, Some(project)).unwrap(), "http://all.test");
        assert_eq!(
            registry("@scope/pkg", Some("@scope:registry=http://user.test"), Some("registry=http://all.test")).unwrap(),
            "http://user.test"
        );
    }

    #[test]
    fn a_token_or_a_reference_is_handed_over() {
        assert!(registry("pkg", None, Some("registry=http://r.test/\n//r.test/:_authToken=abc\n")).is_err());
        assert!(registry("pkg", None, Some("registry=http://r.test\n//r.test/:_authToken=\n")).is_err());
        assert!(registry("pkg", Some("//registry.npmjs.org/:_authToken=abc"), None).is_err());
        assert!(registry("pkg", None, Some("registry=${REGISTRY}\n")).is_err());
        // A token for another host does not matter.
        assert!(registry("pkg", None, Some("registry=http://r.test/\n//other.test/:_authToken=abc\n")).is_ok());
    }

    #[test]
    fn a_directory_in_place_of_the_file_is_handed_over() {
        let (home, root) = (directory("home-dir"), directory("root-dir"));

        fs::create_dir_all(root.join(".npmrc")).unwrap();

        assert!(registry_for("pkg", &home, &root).is_err());
    }
}
