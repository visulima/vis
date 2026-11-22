/**
 * Non-JavaScript toolchains a generated CI workflow has to install, detected
 * from the manifests in the workspace root and the project roots. vis itself
 * always needs Node.js, which the renderers set up regardless.
 */

export type Ecosystem = "dart" | "dotnet" | "elixir" | "go" | "gradle" | "maven" | "php" | "python" | "ruby" | "rust" | "swift" | "zig";

export interface DetectedEcosystem {
    /** Workspace-relative paths of the manifests that matched, e.g. `crates/core/Cargo.toml`. */
    manifests: string[];
    name: Ecosystem;
}

const MANIFESTS: ReadonlyArray<[Ecosystem, (file: string) => boolean]> = [
    ["dart", (file) => file === "pubspec.yaml"],
    ["dotnet", (file) => /\.(?:cs|fs|vb)proj$|\.sln$/u.test(file) || file === "global.json"],
    ["elixir", (file) => file === "mix.exs"],
    ["go", (file) => file === "go.mod"],
    ["gradle", (file) => /^(?:build|settings)\.gradle(?:\.kts)?$/u.test(file)],
    ["maven", (file) => file === "pom.xml"],
    ["php", (file) => file === "composer.json"],
    ["python", (file) => ["Pipfile", "pyproject.toml", "requirements.txt", "setup.py"].includes(file)],
    ["ruby", (file) => file === "Gemfile" || file.endsWith(".gemspec")],
    ["rust", (file) => file === "Cargo.toml"],
    ["swift", (file) => file === "Package.swift"],
    ["zig", (file) => file === "build.zig"],
];

/**
 * The ecosystems whose manifests appear in `directories` (the workspace root
 * plus every project root, each with the names of the files directly in it),
 * sorted by name.
 */
export const detectEcosystems = (directories: ReadonlyArray<{ files: ReadonlyArray<string>; path: string }>): DetectedEcosystem[] => {
    const found = new Map<Ecosystem, string[]>();

    for (const { files, path } of directories) {
        for (const file of files) {
            for (const [name, matches] of MANIFESTS) {
                if (matches(file)) {
                    found.set(name, [...(found.get(name) ?? []), path === "." || path === "" ? file : `${path}/${file}`]);
                }
            }
        }
    }

    return [...found]
        .map(([name, manifests]) => {
            return { manifests: [...new Set(manifests)].toSorted(), name };
        })
        .toSorted((a, b) => a.name.localeCompare(b.name));
};
