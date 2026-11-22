//! Non-JavaScript toolchains a generated workflow has to install, detected from the manifests in the
//! workspace root and the project roots (`src/util/ci-workflow/ecosystems.ts`).

use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Ecosystem {
    Dart,
    Dotnet,
    Elixir,
    Go,
    Gradle,
    Maven,
    Php,
    Python,
    Ruby,
    Rust,
    Swift,
    Zig,
}

impl Ecosystem {
    pub fn name(self) -> &'static str {
        match self {
            Ecosystem::Dart => "dart",
            Ecosystem::Dotnet => "dotnet",
            Ecosystem::Elixir => "elixir",
            Ecosystem::Go => "go",
            Ecosystem::Gradle => "gradle",
            Ecosystem::Maven => "maven",
            Ecosystem::Php => "php",
            Ecosystem::Python => "python",
            Ecosystem::Ruby => "ruby",
            Ecosystem::Rust => "rust",
            Ecosystem::Swift => "swift",
            Ecosystem::Zig => "zig",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Detected {
    /// Workspace-relative paths of the manifests that matched, sorted.
    pub manifests: Vec<String>,
    pub name: Ecosystem,
}

/// `/\.(?:cs|fs|vb)proj$|\.sln$/u`
fn is_dotnet(file: &str) -> bool {
    [".csproj", ".fsproj", ".vbproj", ".sln"].iter().any(|suffix| file.ends_with(suffix)) || file == "global.json"
}

/// `/^(?:build|settings)\.gradle(?:\.kts)?$/u`
fn is_gradle(file: &str) -> bool {
    ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].contains(&file)
}

fn matching(file: &str) -> Vec<Ecosystem> {
    let mut found = Vec::new();
    let mut push_if = |condition: bool, ecosystem: Ecosystem| {
        if condition {
            found.push(ecosystem);
        }
    };

    push_if(file == "pubspec.yaml", Ecosystem::Dart);
    push_if(is_dotnet(file), Ecosystem::Dotnet);
    push_if(file == "mix.exs", Ecosystem::Elixir);
    push_if(file == "go.mod", Ecosystem::Go);
    push_if(is_gradle(file), Ecosystem::Gradle);
    push_if(file == "pom.xml", Ecosystem::Maven);
    push_if(file == "composer.json", Ecosystem::Php);
    push_if(["Pipfile", "pyproject.toml", "requirements.txt", "setup.py"].contains(&file), Ecosystem::Python);
    push_if(file == "Gemfile" || file.ends_with(".gemspec"), Ecosystem::Ruby);
    push_if(file == "Cargo.toml", Ecosystem::Rust);
    push_if(file == "Package.swift", Ecosystem::Swift);
    push_if(file == "build.zig", Ecosystem::Zig);

    found
}

/// The ecosystems whose manifests appear in `directories` (the workspace root plus every project root,
/// each with the names of the files directly in it), sorted by name. `directories` come sorted by path.
pub fn detect(directories: &[(String, Vec<String>)]) -> Vec<Detected> {
    let mut found: BTreeMap<Ecosystem, Vec<String>> = BTreeMap::new();

    for (path, files) in directories {
        for file in files {
            for ecosystem in matching(file) {
                let manifest = if path == "." || path.is_empty() { file.clone() } else { format!("{path}/{file}") };

                found.entry(ecosystem).or_default().push(manifest);
            }
        }
    }

    // The enum is declared in alphabetical order of its names, so the map's order is `localeCompare`'s.
    found
        .into_iter()
        .map(|(name, mut manifests)| {
            manifests.sort();
            manifests.dedup();

            Detected { manifests, name }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(path: &str, files: &[&str]) -> (String, Vec<String>) {
        (path.to_owned(), files.iter().map(|file| (*file).to_owned()).collect())
    }

    #[test]
    fn detects_manifests_in_the_root_and_project_roots() {
        let found = detect(&[
            directory(".", &["package.json", "Cargo.toml", "global.json"]),
            directory("crates/core", &["Cargo.toml"]),
            directory("tools", &["requirements.txt", "app.gemspec", "build.gradle.kts", "App.csproj"]),
        ]);
        let names: Vec<&str> = found.iter().map(|detected| detected.name.name()).collect();

        assert_eq!(names, ["dotnet", "gradle", "python", "ruby", "rust"]);
        assert_eq!(found[0].manifests, ["global.json", "tools/App.csproj"]);
        assert_eq!(found[4].manifests, ["Cargo.toml", "crates/core/Cargo.toml"]);
    }

    #[test]
    fn nothing_detected_in_a_plain_js_workspace() {
        assert!(detect(&[
            directory(".", &["package.json"]),
            directory("packages/a", &["package.json", "tsconfig.json"])
        ])
        .is_empty());
    }
}
