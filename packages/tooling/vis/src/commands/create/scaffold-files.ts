/**
 * Editor and AI-agent scaffolding shared by `vis create` and `vis init`.
 *
 * Both writers merge into existing files rather than overwrite them, so re-running
 * `vis init --editor vscode` on a repo that already has settings keeps the user's values.
 */

import { ensureDirSync, isAccessibleSync, readJsonSync, writeFileSync } from "@visulima/fs";
import { join } from "@visulima/path";

import { VisUserError } from "../../errors/vis-user-error";
import { pail } from "../../io/logger";
import { readRootPackageJson } from "../../lint-fmt/detect";

/**
 * Create or merge `.vscode/settings.json` and `.vscode/extensions.json`.
 *
 * Existing values take precedence over defaults. Creates the `.vscode` directory if missing.
 * @param projectDir Absolute path to the project.
 * @param oxcFormatter Set the oxc formatter as the default and enable format-on-save. Pass `false`
 * when the project does not use oxfmt: the settings would then do nothing, so nothing is written.
 */
export const generateVscodeConfig = (projectDir: string, oxcFormatter: boolean = true): void => {
    if (!oxcFormatter) {
        pail.notice("Skipped .vscode: the project does not use oxfmt, so there is no editor setting to add.");

        return;
    }

    const vscodeDir = join(projectDir, ".vscode");

    ensureDirSync(vscodeDir);

    const settingsPath = join(vscodeDir, "settings.json");
    const defaultSettings = {
        "editor.defaultFormatter": "oxc.oxc-vscode",
        "editor.formatOnSave": true,
    };

    if (isAccessibleSync(settingsPath)) {
        try {
            const existing = readJsonSync(settingsPath) as Record<string, unknown>;

            writeFileSync(settingsPath, `${JSON.stringify({ ...defaultSettings, ...existing }, null, 4)}\n`);
            pail.success("Merged .vscode/settings.json");
        } catch {
            pail.warn("Could not merge .vscode/settings.json, skipping");
        }
    } else {
        writeFileSync(settingsPath, `${JSON.stringify(defaultSettings, null, 4)}\n`);
        pail.success("Created .vscode/settings.json");
    }

    const extensionsPath = join(vscodeDir, "extensions.json");
    const defaultExtensions = { recommendations: ["oxc.oxc-vscode"] };

    if (isAccessibleSync(extensionsPath)) {
        try {
            const existing = readJsonSync(extensionsPath) as { recommendations?: string[] };

            writeFileSync(
                extensionsPath,
                `${JSON.stringify(
                    {
                        ...existing,
                        recommendations: [...new Set([...(existing.recommendations || []), ...defaultExtensions.recommendations])],
                    },
                    null,
                    4,
                )}\n`,
            );
            pail.success("Merged .vscode/extensions.json");
        } catch {
            pail.warn("Could not merge .vscode/extensions.json, skipping");
        }
    } else {
        writeFileSync(extensionsPath, `${JSON.stringify(defaultExtensions, null, 4)}\n`);
        pail.success("Created .vscode/extensions.json");
    }
};

/**
 * Rejects an editor name that has no scaffold, rather than silently generating nothing.
 * @param editor Value of the `--editor` flag.
 */
export const assertSupportedEditor = (editor: string | undefined): void => {
    if (editor !== undefined && editor !== "vscode") {
        throw new VisUserError(`Unknown editor "${editor}". Supported editors: vscode.`);
    }
};

/**
 * Create `.ai/instructions` for AI coding agents. Skipped when the template already provided one.
 *
 * A new project from `vis create` gets the full scaffold text. An existing repo (`vis init`) gets only
 * the run commands its root `package.json` actually defines, because the repo's own conventions are
 * not known.
 * @param projectDir Absolute path to the project.
 * @param pmName Package manager name used in the run commands.
 * @param options Options for the instructions file.
 * @param options.existingProject `true` when the repo was not scaffolded by vis.
 */
export const generateAiInstructions = (projectDir: string, pmName: string, options: { existingProject?: boolean } = {}): void => {
    const aiDir = join(projectDir, ".ai");

    ensureDirSync(aiDir);

    const instructionsPath = join(aiDir, "instructions");

    // Skip if the template already provided AI instructions
    if (isAccessibleSync(instructionsPath)) {
        return;
    }

    const content = options.existingProject ? existingProjectInstructions(projectDir, pmName) : scaffoldedInstructions(pmName);

    writeFileSync(instructionsPath, content);
    pail.success("Created .ai/instructions");
};

const scaffoldedInstructions = (pmName: string): string => `# Project Instructions

This project was scaffolded with vis create.

## Development

- Package manager: ${pmName}
- Build: \`${pmName} run build\`
- Test: \`${pmName} run test\`
- Lint: \`${pmName} run lint\`

## Conventions

- Use TypeScript strict mode
- ESM modules (\`"type": "module"\`)
- Follow Angular-style conventional commits
`;

const existingProjectInstructions = (projectDir: string, pmName: string): string => {
    const scripts = (readRootPackageJson(projectDir).scripts ?? {}) as Record<string, unknown>;
    const commands = ["build", "test", "lint"].filter((name) => typeof scripts[name] === "string");
    const lines = commands.map((name) => `- ${name.charAt(0).toUpperCase()}${name.slice(1)}: \`${pmName} run ${name}\``);

    return `# Project Instructions

## Development

- Package manager: ${pmName}${lines.length > 0 ? `\n${lines.join("\n")}` : ""}
`;
};
