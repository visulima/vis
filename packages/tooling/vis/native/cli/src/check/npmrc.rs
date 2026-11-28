//! `loadNpmrc` and `getRegistryForPackage` of `src/util/catalog/npmrc.ts`: which registry each package is asked.
//!
//! Node merges `~/.npmrc` under the workspace's `.npmrc` and reads three kinds of line: `registry=`, `@scope:registry=`
//! and `//host/:_authToken=`. A file this module cannot read the same way is the reason to hand the run to Node:
//!
//! - any credential (a key with `_auth` or `_password` in it): a private registry's requests carry a bearer token
//!   this port does not send;
//! - a `${VAR}` in a registry value, which Node expands from its environment;
//! - a file that exists and cannot be read as UTF-8 text, which makes Node throw.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::Path;

const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";

/// What `parseNpmrc` finds: the default registry and the one of each scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Npmrc {
    default: String,
    scopes: BTreeMap<String, String>,
}

impl Default for Npmrc {
    fn default() -> Self {
        Self { default: DEFAULT_REGISTRY.to_owned(), scopes: BTreeMap::new() }
    }
}

impl Npmrc {
    /// `getRegistryForPackage(name).url`.
    pub(super) fn registry_for(&self, package: &str) -> &str {
        if package.starts_with('@') {
            if let Some(url) = package.split('/').next().and_then(|scope| self.scopes.get(scope)) {
                return url;
            }
        }

        &self.default
    }
}

/// `parseNpmrc(content)`, or the reason Node's reading of it is not this module's.
pub(super) fn parse(content: &str) -> Result<Npmrc, String> {
    let mut config = Npmrc::default();

    for line in content.split('\n') {
        let trimmed = crate::js::trim(line);

        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }

        let Some((key, value)) = trimmed.split_once('=') else { continue };
        let (key, value) = (crate::js::trim(key), crate::js::trim(value));

        if key.contains("_auth") || key.contains("_password") {
            return Err("an .npmrc holds a credential".to_owned());
        }

        let scope = key
            .strip_suffix(":registry")
            .filter(|scope| scope.starts_with('@') && scope.len() > 1 && !scope[1..].contains(':'));

        if scope.is_some() || key == "registry" {
            if value.contains("${") {
                return Err("an .npmrc registry holds an environment reference".to_owned());
            }

            match scope {
                Some(scope) => {
                    config.scopes.insert(scope.to_owned(), value.to_owned());
                }
                None => config.default = value.to_owned(),
            }
        }
    }

    Ok(config)
}

/// `mergeNpmrcConfigs(base, override)`.
fn merge(base: Npmrc, over: Npmrc) -> Npmrc {
    let mut scopes = base.scopes;

    scopes.extend(over.scopes);

    Npmrc { default: if over.default == DEFAULT_REGISTRY { base.default } else { over.default }, scopes }
}

/// `loadNpmrc(root)`: `$HOME/.npmrc` (or `USERPROFILE`) under `<root>/.npmrc`.
pub(super) fn load(root: &Path) -> Result<Npmrc, String> {
    let home = env::var("HOME").or_else(|_| env::var("USERPROFILE")).unwrap_or_default();
    let mut config = Npmrc::default();

    if !home.is_empty() {
        let user = Path::new(&home).join(".npmrc");

        if user.exists() {
            config = parse(
                &fs::read_to_string(&user).map_err(|error| format!("{} is unreadable: {error}", user.display()))?,
            )?;
        }
    }

    let project = root.join(".npmrc");

    if project.exists() {
        let text =
            fs::read_to_string(&project).map_err(|error| format!("{} is unreadable: {error}", project.display()))?;

        config = merge(config, parse(&text)?);
    }

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registries_are_read_per_scope_and_by_default() {
        let config = parse("# comment\n; other\nregistry=http://127.0.0.1:20000/\n@acme:registry = http://127.0.0.1:20001\r\nsave-exact=true\nnoequals\n").expect("reads");

        assert_eq!(config.registry_for("calm"), "http://127.0.0.1:20000/");
        assert_eq!(config.registry_for("@acme/pkg"), "http://127.0.0.1:20001");
        assert_eq!(config.registry_for("@other/pkg"), "http://127.0.0.1:20000/");
    }

    #[test]
    fn the_project_file_wins_unless_it_names_the_public_registry() {
        let user = parse("registry=http://user.test/\n@a:registry=http://a-user.test/\n").unwrap();
        let project = parse("registry=http://project.test/\n").unwrap();
        let merged = merge(user.clone(), project);

        assert_eq!(merged.registry_for("x"), "http://project.test/");
        assert_eq!(merged.registry_for("@a/x"), "http://a-user.test/");
        // `registry=https://registry.npmjs.org` is what an unset registry is, so it does not override.
        assert_eq!(
            merge(user, parse("registry=https://registry.npmjs.org\n").unwrap()).registry_for("x"),
            "http://user.test/"
        );
    }

    #[test]
    fn what_node_expands_or_authenticates_is_left_to_node() {
        for text in [
            "//registry.test/:_authToken=abc\n",
            "//registry.test/:_authToken=${TOKEN}\n",
            "_auth=abc\n",
            "//r.test/:_password=x\n",
            "registry=${REGISTRY}\n",
            "@a:registry=${REGISTRY:-http://x.test}\n",
        ] {
            assert!(parse(text).is_err(), "{text:?}");
        }

        // An environment reference in a line Node does not read for a registry changes nothing.
        assert!(parse("cache=${HOME}/.cache\n").is_ok());
    }
}
