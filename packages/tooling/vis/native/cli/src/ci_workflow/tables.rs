//! The action pins and package-manager commands, read from `ci-tables.json`, which is generated from
//! `src/util/github-actions.ts` and `src/pm/ci-commands.ts` (`__tests__/native/ci-tables.test.ts` fails on drift).

use std::collections::BTreeMap;

use serde::Deserialize;

const TABLES_JSON: &str = include_str!("../ci-tables.json");

/// A GitHub Action pinned to a commit; `version` is the trailing comment dependency bots read.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Action {
    pub name: String,
    pub sha: String,
    pub version: String,
}

/// What a generated workflow runs for one package manager.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackageManager {
    pub exec: String,
    pub github_action: Option<String>,
    pub github_node_cache: Option<String>,
    pub install: String,
    pub setup: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Tables {
    actions: BTreeMap<String, Action>,
    #[serde(rename = "packageManagers")]
    package_managers: BTreeMap<String, PackageManager>,
}

impl Tables {
    pub fn load() -> Tables {
        serde_json::from_str(TABLES_JSON).expect("ci-tables.json is valid")
    }

    pub fn action(&self, key: &str) -> &Action {
        self.actions.get(key).unwrap_or_else(|| panic!("ci-tables.json has no action {key}"))
    }

    pub fn package_manager(&self, name: &str) -> &PackageManager {
        self.package_managers.get(name).unwrap_or_else(|| panic!("ci-tables.json has no package manager {name}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_package_manager_action_is_pinned() {
        let tables = Tables::load();

        for manager in ["aube", "bun", "npm", "pnpm", "yarn"] {
            if let Some(key) = &tables.package_manager(manager).github_action {
                assert!(!tables.action(key).sha.is_empty(), "{manager}");
            }
        }
    }
}
