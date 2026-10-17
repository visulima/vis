type PrettierModule = {
    format: (source: string, options: Record<string, unknown>) => Promise<string>;
    getFileInfo: (file: string) => Promise<{ ignored: boolean; inferredParser: null | string }>;
    resolveConfig: (file: string) => Promise<Record<string, unknown> | null>;
};

/**
 * Run the project's Prettier over the version step's written files (RFC §14
 * step 7). Scoped to those files only; resolves the *project's* Prettier from
 * `cwd` (not vis's own). Soft-fails entirely when Prettier isn't installed,
 * and skips any file Prettier ignores or can't infer a parser for. Never
 * throws — formatting must not fail a release.
 */
export const formatChangedFiles = async (files: string[], cwd: string): Promise<void> => {
    if (files.length === 0) {
        return;
    }

    const { join } = await import("node:path");

    let prettier: PrettierModule;

    try {
        const { createRequire } = await import("node:module");
        const { pathToFileURL } = await import("node:url");
        const requireFromProject = createRequire(join(cwd, "package.json"));

        prettier = (await import(pathToFileURL(requireFromProject.resolve("prettier")).href)) as PrettierModule;
    } catch {
        // Prettier not installed in the target project — skip silently.
        return;
    }

    const fsp = await import("node:fs/promises");

    for (const file of files) {
        try {
            const info = await prettier.getFileInfo(file);

            if (info.ignored || !info.inferredParser) {
                continue;
            }

            const source = await fsp.readFile(file, "utf8");
            const config = await prettier.resolveConfig(file);
            const formatted = await prettier.format(source, { ...config, filepath: file });

            if (formatted !== source) {
                await fsp.writeFile(file, formatted);
            }
        } catch {
            // Per-file soft-fail — never break a release on a formatting error.
        }
    }
};
