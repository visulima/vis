//! The three output formats of `vis deps`: `human` (the lines `printHuman` logs, in the colour the Node detection
//! gives), `json` (`printJson`) and `minimal` (`printMinimal`).

use super::data::{Package, Workspace};
use super::lint::Report;
use super::{Lint, Selection};
use crate::json::{stringify, Json};
use crate::node_context::printed_path;
use crate::term::Style;

/// The plural `s` of `count` things.
const fn s(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

/// Groups `items` by `key`, in order of first appearance (`groupBy` of the handler).
fn group_by<T>(items: &[T], key: impl Fn(&T) -> String) -> Vec<(String, Vec<&T>)> {
    let mut groups: Vec<(String, Vec<&T>)> = Vec::new();

    for item in items {
        let name = key(item);

        match groups.iter_mut().find(|group| group.0 == name) {
            Some(group) => group.1.push(item),
            None => groups.push((name, vec![item])),
        }
    }

    groups
}

/// The lines of the human report, each ending in a line feed.
pub(super) fn human(workspace: &Workspace, report: &Report, selection: &Selection, colour: bool) -> String {
    let style = Style { colour };
    let packages = &workspace.packages;
    let mut sections: Vec<Vec<String>> = Vec::new();

    if selection.has(Lint::WorkspaceProtocol) {
        sections.push(workspace_protocol(packages, report, style));
    }

    if selection.has(Lint::RedefineRoot) {
        sections.push(redefine_root(packages, report, style));
    }

    if selection.has(Lint::WorkspaceVersions) {
        sections.push(vec![style.green("\u{2713} workspace-versions: no drift")]);
    }

    if selection.has(Lint::CustomTypes) {
        sections.push(vec![style.green("\u{2713} custom-types: no engines / packageManager / volta drift")]);
    }

    if selection.has(Lint::BannedDeps) {
        sections.push(vec![style.green("\u{2713} banned-deps: no violations")]);
    }

    if selection.has(Lint::EmptyDeps) {
        sections.push(empty_deps(packages, report, style));
    }

    if selection.has(Lint::RootPrivate) {
        sections.push(root_private(packages, report, style));
    }

    if selection.has(Lint::RootPackageManager) {
        sections.push(root_package_manager(packages, report, style));
    }

    if selection.has(Lint::RootDeps) {
        sections.push(root_deps(packages, report, style));
    }

    if selection.has(Lint::MissingPackageJson) {
        sections.push(missing_package_json(report, style));
    }

    if selection.has(Lint::DeadWorkspacePatterns) {
        sections.push(dead_patterns(report, style));
    }

    if selection.has(Lint::TypesInDeps) {
        sections.push(types_in_deps(packages, report, style));
    }

    if selection.has(Lint::SimilarDeps) {
        sections.push(similar_deps(packages, report, style));
    }

    sections
        .iter()
        .map(|lines| lines.iter().map(|line| format!("{line}\n")).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn workspace_protocol(packages: &[Package], report: &Report, style: Style) -> Vec<String> {
    let issues = &report.workspace_protocol;

    if issues.is_empty() {
        return vec![style.green("\u{2713} workspace-protocol: no violations")];
    }

    let mut lines = vec![style.yellow(&style.bold(&format!(
        "Found {} workspace-protocol violation{}",
        issues.len(),
        s(issues.len())
    )))];

    for (key, group) in group_by(issues, |issue| packages[issue.package].group_key().to_owned()) {
        lines.push(format!(
            "  {} {}",
            style.bold(&key),
            style.dim(&format!("({})", packages[group[0].package].relative_path()))
        ));

        for issue in group {
            lines.push(format!(
                "    {} {}: {} {} {}",
                style.dim(issue.dep_type.name()),
                issue.dep_name,
                style.red(&issue.specifier),
                style.yellow("\u{2192}"),
                style.green("workspace:*")
            ));
        }
    }

    lines.push(style.dim("  Run with --fix to rewrite specifiers in place."));

    lines
}

fn redefine_root(packages: &[Package], report: &Report, style: Style) -> Vec<String> {
    let issues = &report.redefine_root;

    if issues.is_empty() {
        return vec![style.green("\u{2713} redefine-root: no violations")];
    }

    let mut lines = vec![style.yellow(&style.bold(&format!(
        "Found {} dep{} re-declared from root",
        issues.len(),
        s(issues.len())
    )))];

    for (key, group) in group_by(issues, |issue| packages[issue.package].group_key().to_owned()) {
        lines.push(format!(
            "  {} {}",
            style.bold(&key),
            style.dim(&format!("({})", packages[group[0].package].relative_path()))
        ));

        for issue in group {
            lines.push(format!(
                "    {} {}: {} {}",
                style.dim(issue.dep_type.name()),
                issue.dep_name,
                style.red(&issue.child_specifier),
                style.dim(&format!("(root {}: {})", issue.root_dep_type.name(), issue.root_specifier))
            ));
        }
    }

    lines.push(style.dim("  Remove these from child package.json files \u{2014} root pin will resolve."));

    lines
}

fn empty_deps(packages: &[Package], report: &Report, style: Style) -> Vec<String> {
    let issues = &report.empty_deps;

    if issues.is_empty() {
        return vec![style.green("\u{2713} empty-deps: no empty dependency blocks")];
    }

    let mut lines =
        vec![style.yellow(&style.bold(&format!("Found {} empty dependency block{}", issues.len(), s(issues.len()))))];

    for (key, group) in group_by(issues, |(package, _)| packages[*package].group_key().to_owned()) {
        lines.push(format!(
            "  {} {}",
            style.bold(&key),
            style.dim(&format!("({})", packages[group[0].0].relative_path()))
        ));

        for (_, dep_type) in group {
            lines.push(format!("    {}: {}", style.dim(dep_type.name()), style.red("{}")));
        }
    }

    lines.push(style.dim("  Run with --fix to drop empty blocks."));

    lines
}

fn root_private(packages: &[Package], report: &Report, style: Style) -> Vec<String> {
    let Some(raw) = &report.root_private else {
        return vec![style.green("\u{2713} root-private: root package.json is \"private\": true")];
    };

    let path = packages[0].relative_path();
    let seen = raw.as_ref().map_or_else(|| "absent".to_owned(), |value| stringify(value, ""));

    vec![
        style.red(&style.bold(&format!("Missing \"private\": true on root {}", style.dim(&format!("({path})"))))),
        format!("    {} {}", style.dim("current:"), style.red(&seen)),
        style.dim("  Run with --fix to set \"private\": true."),
    ]
}

fn root_package_manager(packages: &[Package], report: &Report, style: Style) -> Vec<String> {
    if !report.root_package_manager {
        return vec![style.green("\u{2713} root-package-manager: packageManager field present")];
    }

    let path = packages[0].relative_path();

    vec![
        style.red(&style.bold(&format!("Missing packageManager on root {}", style.dim(&format!("({path})"))))),
        style.dim("    no canonical specifier configured (set policy.rootPackageManager.suggested to enable --fix)"),
        style.dim("  e.g. \"packageManager\": \"pnpm@10.32.1\""),
    ]
}

fn root_deps(packages: &[Package], report: &Report, style: Style) -> Vec<String> {
    let Some(names) = &report.root_deps else {
        return vec![style.green("\u{2713} root-deps: no runtime dependencies on private root")];
    };

    let path = packages[0].relative_path();
    let mut lines = vec![style.yellow(&style.bold(&format!(
        "Found {} runtime dep{} on private root {}",
        names.len(),
        s(names.len()),
        style.dim(&format!("({path})"))
    )))];

    lines.extend(names.iter().map(|name| format!("    {}", style.red(name))));
    lines.push(style.dim("  Run with --fix to move them to devDependencies."));

    lines
}

fn missing_package_json(report: &Report, style: Style) -> Vec<String> {
    let issues = &report.missing_package_json;

    if issues.is_empty() {
        return vec![style.green("\u{2713} missing-package-json: every workspace dir has a package.json")];
    }

    let mut lines = vec![style.yellow(&style.bold(&format!(
        "Found {} workspace dir{} without a package.json",
        issues.len(),
        s(issues.len())
    )))];

    lines.extend(issues.iter().map(|directory| format!("    {}", style.red(directory))));
    lines.push(style.dim("  Either delete the directory or scaffold a package.json (vis create)."));

    lines
}

fn dead_patterns(report: &Report, style: Style) -> Vec<String> {
    let issues = &report.dead_patterns;

    if issues.is_empty() {
        return vec![
            style.green("\u{2713} dead-workspace-pattern: every workspace pattern matches at least one package")
        ];
    }

    let mut lines = vec![style.yellow(&style.bold(&format!(
        "Found {} unmatched workspace pattern{}",
        issues.len(),
        s(issues.len())
    )))];

    lines.push(format!("  {}", style.bold("pnpm-workspace.yaml")));
    lines.extend(issues.iter().map(|issue| format!("    {}", style.red(&issue.pattern))));
    lines.push(style.dim("  Run with --fix to drop dead patterns."));

    lines
}

fn types_in_deps(packages: &[Package], report: &Report, style: Style) -> Vec<String> {
    let issues = &report.types_in_deps;

    if issues.is_empty() {
        return vec![style.green("\u{2713} types-in-deps: no @types/* in dependencies of private packages")];
    }

    let mut lines = vec![style.yellow(&style.bold(&format!(
        "Found {} @types/* dep{} in dependencies",
        issues.len(),
        s(issues.len())
    )))];

    for (key, group) in group_by(issues, |issue| packages[issue.package].group_key().to_owned()) {
        lines.push(format!(
            "  {} {}",
            style.bold(&key),
            style.dim(&format!("({})", packages[group[0].package].relative_path()))
        ));

        for issue in group {
            lines.push(format!("    {} {}", style.red(&issue.dep_name), style.dim(&issue.child_specifier)));
        }
    }

    lines.push(style.dim("  Run with --fix to move them to devDependencies."));

    lines
}

fn similar_deps(packages: &[Package], report: &Report, style: Style) -> Vec<String> {
    let issues = &report.similar_deps;

    if issues.is_empty() {
        return vec![style.green("\u{2713} similar-deps: every related dep family is in sync")];
    }

    // The handler appends " families" to "family" for every count but one.
    let plural = if issues.len() == 1 { "" } else { " families" };
    let mut lines =
        vec![style.yellow(&style.bold(&format!("Found {} family{plural} with version drift", issues.len())))];

    for issue in issues {
        lines.push(format!(
            "  {} {}",
            style.bold(issue.label),
            style.dim(&format!("({})", issue.specifiers.join(", ")))
        ));

        for member in &issue.members {
            let package = &packages[member.package];

            lines.push(format!(
                "    {} {} {}: {}@{}",
                package.display_name(),
                style.dim(&format!("({})", package.relative_path())),
                style.dim(member.dep_type.name()),
                style.red(&member.dep_name),
                style.yellow(&member.specifier)
            ));
        }
    }

    lines.push(style.dim(
        "  Pick a single specifier per family and align by hand \u{2014} auto-fix is unsafe across name boundaries.",
    ));

    lines
}

/// `printMinimal`: tab-separated lines, one per issue.
pub(super) fn minimal(packages: &[Package], report: &Report, selection: &Selection) -> String {
    let mut out = String::new();
    let mut line = |fields: &[&str]| {
        out.push_str(&fields.join("\t"));
        out.push('\n');
    };

    for issue in report.workspace_protocol.iter().filter(|_| selection.has(Lint::WorkspaceProtocol)) {
        let package = &packages[issue.package];

        line(&[
            "workspace-protocol",
            &package.relative_path(),
            issue.dep_type.name(),
            &issue.dep_name,
            &format!("{} \u{2192} workspace:*", issue.specifier),
        ]);
    }

    for issue in report.redefine_root.iter().filter(|_| selection.has(Lint::RedefineRoot)) {
        line(&[
            "redefine-root",
            &packages[issue.package].relative_path(),
            issue.dep_type.name(),
            &issue.dep_name,
            &issue.child_specifier,
        ]);
    }

    for (index, dep_type) in report.empty_deps.iter().filter(|_| selection.has(Lint::EmptyDeps)) {
        line(&["empty-deps", &packages[*index].relative_path(), dep_type.name()]);
    }

    if selection.has(Lint::RootPrivate) && report.root_private.is_some() {
        line(&["root-private", &packages[0].relative_path()]);
    }

    if selection.has(Lint::RootPackageManager) && report.root_package_manager {
        line(&["root-package-manager", &packages[0].relative_path(), ""]);
    }

    for name in report.root_deps.iter().flatten().filter(|_| selection.has(Lint::RootDeps)) {
        line(&["root-deps", &packages[0].relative_path(), name]);
    }

    for directory in report.missing_package_json.iter().filter(|_| selection.has(Lint::MissingPackageJson)) {
        line(&["missing-package-json", directory]);
    }

    for issue in report.dead_patterns.iter().filter(|_| selection.has(Lint::DeadWorkspacePatterns)) {
        line(&["dead-workspace-pattern", "pnpm-workspace.yaml", &issue.pattern]);
    }

    for issue in report.types_in_deps.iter().filter(|_| selection.has(Lint::TypesInDeps)) {
        line(&["types-in-deps", &packages[issue.package].relative_path(), &issue.dep_name, &issue.child_specifier]);
    }

    for issue in report.similar_deps.iter().filter(|_| selection.has(Lint::SimilarDeps)) {
        for member in &issue.members {
            line(&[
                "similar-deps",
                issue.family,
                &packages[member.package].relative_path(),
                member.dep_type.name(),
                &member.dep_name,
                &member.specifier,
            ]);
        }
    }

    out
}

fn text(value: &str) -> Json {
    Json::Str(value.to_owned())
}

fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(name, value)| (name.to_owned(), value)).collect())
}

/// A field that `JSON.stringify` leaves out when its value is `undefined`.
fn name_field(package: &Package) -> Vec<(&'static str, Json)> {
    package.name.as_deref().map(|name| vec![("packageName", text(name))]).unwrap_or_default()
}

/// One `{ issues, total }` block.
fn block(issues: Vec<Json>) -> Json {
    let total = i64::try_from(issues.len()).unwrap_or(i64::MAX);

    object(vec![("issues", Json::Array(issues)), ("total", Json::Int(total))])
}

/// `printJson`, or `None` when a path in it is one only Node can print.
pub(super) fn json(workspace: &Workspace, report: &Report, selection: &Selection) -> Option<String> {
    let packages = &workspace.packages;
    let mut out: Vec<(&str, Json)> = vec![(
        "fixed",
        object(
            [
                "catalogProposals",
                "customTypes",
                "deadWorkspacePatterns",
                "emptyDeps",
                "rootDeps",
                "rootPackageManager",
                "rootPrivate",
                "typesInDeps",
                "workspaceProtocol",
                "workspaceVersions",
            ]
            .into_iter()
            .map(|name| (name, Json::Bool(false)))
            .collect(),
        ),
    )];

    // The fields every package issue starts with, in the order the lints build them.
    let located = |package: &Package| -> Vec<(&'static str, Json)> {
        let mut fields = vec![("packageDir", text(&package.dir)), ("packageJsonPath", text(&package.relative_path()))];

        fields.extend(name_field(package));

        fields
    };

    if selection.has(Lint::WorkspaceProtocol) {
        let issues = report.workspace_protocol.iter().map(|issue| {
            let mut fields = vec![
                ("depName", text(&issue.dep_name)),
                ("depType", text(issue.dep_type.name())),
                ("fix", text("workspace:*")),
            ];

            fields.extend(located(&packages[issue.package]));
            fields.push(("specifier", text(&issue.specifier)));

            object(fields)
        });

        out.push(("workspaceProtocol", block(issues.collect())));
    }

    if selection.has(Lint::RedefineRoot) {
        let issues = report.redefine_root.iter().map(|issue| {
            let mut fields = vec![
                ("childSpecifier", text(&issue.child_specifier)),
                ("depName", text(&issue.dep_name)),
                ("depType", text(issue.dep_type.name())),
            ];

            fields.extend(located(&packages[issue.package]));
            fields.push(("rootDepType", text(issue.root_dep_type.name())));
            fields.push(("rootSpecifier", text(&issue.root_specifier)));

            object(fields)
        });

        out.push(("redefineRoot", block(issues.collect())));
    }

    if selection.has(Lint::WorkspaceVersions) {
        out.push(("workspaceVersions", block(Vec::new())));
    }

    if selection.has(Lint::CustomTypes) {
        out.push(("customTypes", block(Vec::new())));
    }

    if selection.has(Lint::BannedDeps) {
        out.push(("bannedDeps", block(Vec::new())));
    }

    if selection.has(Lint::EmptyDeps) {
        let issues = report.empty_deps.iter().map(|(index, dep_type)| {
            let package = &packages[*index];
            let mut fields = vec![("depType", text(dep_type.name()))];

            fields.extend(located(package));

            object(fields)
        });

        out.push(("emptyDeps", block(issues.collect())));
    }

    if selection.has(Lint::RootPrivate) {
        let issues = report.root_private.iter().map(|raw| {
            let mut fields = vec![("packageJsonPath", text(&packages[0].relative_path()))];

            fields.extend(raw.clone().map(|value| ("rawValue", value)));

            object(fields)
        });

        out.push(("rootPrivate", block(issues.collect())));
    }

    if selection.has(Lint::RootPackageManager) {
        let issues =
            report.root_package_manager.then(|| object(vec![("packageJsonPath", text(&packages[0].relative_path()))]));

        out.push(("rootPackageManager", block(issues.into_iter().collect())));
    }

    if selection.has(Lint::RootDeps) {
        let issues = report.root_deps.iter().map(|names| {
            object(vec![
                ("depNames", Json::Array(names.iter().map(|name| text(name)).collect())),
                ("packageJsonPath", text(&packages[0].relative_path())),
            ])
        });

        out.push(("rootDeps", block(issues.collect())));
    }

    if selection.has(Lint::MissingPackageJson) {
        out.push((
            "missingPackageJson",
            block(
                report
                    .missing_package_json
                    .iter()
                    .map(|directory| object(vec![("packageDir", text(directory))]))
                    .collect(),
            ),
        ));
    }

    if selection.has(Lint::DeadWorkspacePatterns) {
        let source_path = printed_path(&workspace.root.join("pnpm-workspace.yaml"))?;
        let issues = report.dead_patterns.iter().map(|issue| {
            object(vec![
                ("pattern", text(&issue.pattern)),
                ("source", text("pnpm-workspace.yaml")),
                ("sourcePath", text(&source_path)),
            ])
        });

        out.push(("deadWorkspacePatterns", block(issues.collect())));
    }

    if selection.has(Lint::TypesInDeps) {
        let issues = report.types_in_deps.iter().map(|issue| {
            let mut fields = vec![("childSpecifier", text(&issue.child_specifier)), ("depName", text(&issue.dep_name))];

            fields.extend(located(&packages[issue.package]));

            object(fields)
        });

        out.push(("typesInDeps", block(issues.collect())));
    }

    if selection.has(Lint::SimilarDeps) {
        let issues = report.similar_deps.iter().map(|issue| {
            let members = issue.members.iter().map(|member| {
                let mut fields = vec![("depName", text(&member.dep_name)), ("depType", text(member.dep_type.name()))];

                fields.extend(located(&packages[member.package]));
                fields.push(("specifier", text(&member.specifier)));

                object(fields)
            });

            object(vec![
                ("family", text(issue.family)),
                ("familyLabel", text(issue.label)),
                ("members", Json::Array(members.collect())),
                ("specifiers", Json::Array(issue.specifiers.iter().map(|specifier| text(specifier)).collect())),
            ])
        });

        out.push(("similarDeps", block(issues.collect())));
    }

    Some(format!("{}\n", stringify(&object(out), "  ")))
}
