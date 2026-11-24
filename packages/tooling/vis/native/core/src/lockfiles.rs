//! The lockfiles Node's package-manager lookup recognises (`lockfile-candidates`), with the manager each one names.

/// The lockfile names and their managers, in the order the Node handlers check them. Rows of one manager are
/// adjacent, which callers that collapse them with `dedup` rely on. `node-ignores-config`, the install family's root
/// search and `vis clean --lockfile` all read this one table.
pub const LOCKFILES: [(&str, &str); 6] = [
    ("pnpm-lock.yaml", "pnpm"),
    ("package-lock.json", "npm"),
    ("npm-shrinkwrap.json", "npm"),
    ("yarn.lock", "yarn"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rows_of_one_manager_are_adjacent() {
        let managers: Vec<&str> = LOCKFILES.iter().map(|(_, manager)| *manager).collect();
        let mut collapsed = managers.clone();

        collapsed.dedup();

        let mut unique = collapsed.clone();

        unique.sort_unstable();
        unique.dedup();

        assert_eq!(collapsed.len(), unique.len(), "{managers:?}");
    }

    #[test]
    fn the_names_are_the_order_vis_clean_removes_them_in() {
        assert_eq!(
            LOCKFILES.map(|(file, _)| file),
            ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"]
        );
    }
}
