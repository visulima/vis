//! Pins which entry of the binary answers an invocation (`tests::routes_match_the_snapshot`), so that the
//! dispatch in `main` can be reorganised without a route changing by accident.

#[cfg(test)]
mod tests {
    /// Every command path the routes name. A new route is a new line here, and in the snapshot.
    const COMMAND_PATHS: &[&[&str]] = &[
        &["hook", "run"],
        &["hook", "list"],
        &["hook", "validate"],
        &["advisories", "bloom", "status"],
        &["ignore"],
        &["clean"],
        &["implode"],
        &["cache", "list"],
        &["cache", "size"],
        &["cache", "clean"],
        &["cache", "prune"],
        &["cache", "hash"],
        &["cache", "why"],
        &["list"],
        &["replay"],
        &["task-why"],
        &["affected"],
        &["sbom"],
        &["secrets"],
        &["sort-package-json"],
        &["optimize"],
        &["sync", "ci-workflow"],
        &["security", "list"],
        &["security", "keys-refresh"],
        &["shim", "status"],
        &["deps"],
        &["self-update"],
        &["add"],
        &["install"],
        &["i"],
        &["dlx"],
        &["info"],
        &["view"],
        &["exec"],
        &["pm"],
        &["x"],
        &["remove"],
        &["dedupe"],
        &["link"],
        &["unlink"],
        &["outdated"],
        &["why"],
    ];

    use std::collections::BTreeSet;

    use crate::manifest::Manifest;
    use crate::surface;

    /// Every argument list the snapshot covers: the shared fixture's, each manifest command and its
    /// aliases, and every command word of the table, each alone and with a subcommand, a positional,
    /// a help flag and a leading global flag.
    fn invocations() -> BTreeSet<Vec<String>> {
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            args: Vec<String>,
        }

        let fixture: Fixture =
            serde_json::from_str(include_str!("../tests/fixtures/routing.json")).expect("routing fixture parses");
        let mut found: BTreeSet<Vec<String>> = fixture.cases.into_iter().map(|case| case.args).collect();
        let mut words: BTreeSet<Vec<String>> = BTreeSet::new();
        let manifest = Manifest::load();

        for command in &manifest.commands {
            words.insert(command.command_path.clone());
            words.insert(command.name.split(' ').map(str::to_owned).collect());

            for alias in &command.alias {
                words.insert(vec![alias.clone()]);
            }
        }

        for path in COMMAND_PATHS {
            words.insert(path.iter().map(|word| (*word).to_owned()).collect());
            words.insert(vec![path[0].to_owned()]);
        }

        for word in [
            "__native-info",
            "__pm-shim",
            "--version",
            "-V",
            "complete",
            "run",
            "frobnicate",
            "help",
            "--no-color",
            "-v",
            "cache",
            "hook",
            "advisories",
            "security",
            "sync",
            "shim",
        ] {
            words.insert(vec![word.to_owned()]);
        }

        for path in words {
            let owned =
                |extra: &[&str]| path.iter().cloned().chain(extra.iter().map(|word| (*word).to_owned())).collect();

            for extra in [
                &[][..],
                &["--help"],
                &["-h"],
                &["--"],
                &["--", "--help"],
                &["target"],
                &["target", "--help"],
                &["target", "other"],
                &["bloom", "status"],
                &["bloom", "status", "--help"],
                &["list"],
                &["status", "--help"],
                &["--format", "json"],
                &["--no-color", "-h"],
                &["--version"],
                &["--version", "--help"],
            ] {
                found.insert(owned(extra));
            }

            for lead in ["--no-color", "--color", "--quiet"] {
                found.insert(std::iter::once(lead.to_owned()).chain(path.iter().cloned()).collect());
            }
        }

        for extra in
            [&["--version", "--help"][..], &["-V", "-h"], &["-V", "x"], &["--version", "x"], &["--help", "--version"]]
        {
            found.insert(extra.iter().map(|word| (*word).to_owned()).collect());
        }

        found
    }

    /// Which entry the dispatch `match` of `main` handed an invocation to, as it was written before the routing
    /// table: the arms in their order, each guarded by "help is not asked for" unless it says otherwise.
    fn legacy(args: &[String]) -> String {
        let first = args.first().map(String::as_str).unwrap_or("");
        let second = args.get(1).map(String::as_str);
        let third = args.get(2).map(String::as_str);
        let help = surface::asks_for_help(args);
        let unix = cfg!(unix);

        match first {
            "__native-info" => "native-info".into(),
            "--version" | "-V" if !help => "version".into(),
            "complete" if second == Some("--") => "complete".into(),
            "__pm-shim" => "pm-shim".into(),
            "exec" => "exec".into(),
            "hook" if second == Some("run") && !help => "hook run".into(),
            "hook" if second == Some("list") && !help => "hook list".into(),
            "hook" if unix && second == Some("validate") && !help => "hook validate".into(),
            "advisories" if second == Some("bloom") && third == Some("status") && !help => {
                "advisories bloom status".into()
            }
            "ignore" if !help => "ignore".into(),
            "clean" if !help => "clean".into(),
            "implode" if unix && !help => "implode".into(),
            "cache" if matches!(second, Some("list" | "size")) && !help => {
                format!("cache {}", second.unwrap_or_default())
            }
            "cache" if unix && second == Some("clean") && !help => "cache clean".into(),
            "cache" if unix && second == Some("prune") && !help => "cache prune".into(),
            "run" if args.len() == 2 && !help => "run".into(),
            "list" if !help => "list".into(),
            "cache" if second == Some("hash") && !help => "cache hash".into(),
            "cache" if second == Some("why") && !help => "cache why".into(),
            "replay" if !help => "replay".into(),
            "task-why" if !help => "task-why".into(),
            "affected" if !help => "affected".into(),
            "sbom" if !help => "sbom".into(),
            "secrets" if !help => "secrets".into(),
            "sort-package-json" if !help => "sort-package-json".into(),
            "optimize" if !help => "optimize".into(),
            "sync" if second == Some("ci-workflow") && !help => "sync ci-workflow".into(),
            "security" if second == Some("list") && !help => "security list".into(),
            "security" if second == Some("keys-refresh") && !help => "security keys-refresh".into(),
            "shim" if second == Some("status") && !help => "shim status".into(),
            "deps" if !help => "deps".into(),
            "self-update" if !help => "self-update".into(),
            "add" if !help => "add".into(),
            "install" | "i" if !help => first.into(),
            "dlx" if !help => "dlx".into(),
            "info" | "view" if !help => first.into(),
            "pm" | "x" | "remove" | "dedupe" | "link" | "unlink" | "outdated" | "why" => first.into(),
            _ => "surface".into(),
        }
    }

    /// One line per invocation, `["args"] => entry`: where the dispatch took it. A change here is a change of
    /// routing, and has to be a decision.
    const SNAPSHOT: &str = include_str!("../tests/fixtures/native-routes.snap");

    fn render() -> String {
        invocations()
            .into_iter()
            .map(|args| format!("{} => {}\n", serde_json::to_string(&args).expect("args serialise"), legacy(&args)))
            .collect()
    }

    #[test]
    fn routes_match_the_snapshot() {
        let rendered = render();

        let changed: Vec<String> = rendered
            .lines()
            .zip(SNAPSHOT.lines())
            .filter(|(now, before)| now != before)
            .map(|(now, before)| format!("was {before}\n now {now}"))
            .collect();

        assert!(
            rendered.lines().count() == SNAPSHOT.lines().count() && changed.is_empty(),
            "routing changed:\n{}",
            changed.join("\n")
        );
    }
}
