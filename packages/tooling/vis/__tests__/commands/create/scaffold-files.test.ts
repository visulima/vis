import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateAiInstructions, generateVscodeConfig } from "../../../src/commands/create/scaffold-files";

describe("scaffold-files", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = mkdtempSync(join(tmpdir(), "vis-scaffold-"));
    });

    afterEach(() => {
        rmSync(projectDir, { force: true, recursive: true });
    });

    describe(generateVscodeConfig, () => {
        it("writes the oxc formatter defaults when oxfmt is in use", () => {
            expect.assertions(2);

            generateVscodeConfig(projectDir);

            expect(JSON.parse(readFileSync(join(projectDir, ".vscode", "settings.json"), "utf8"))).toStrictEqual({
                "editor.defaultFormatter": "oxc.oxc-vscode",
                "editor.formatOnSave": true,
            });
            expect(JSON.parse(readFileSync(join(projectDir, ".vscode", "extensions.json"), "utf8"))).toStrictEqual({
                recommendations: ["oxc.oxc-vscode"],
            });
        });

        it("writes nothing when the project does not use oxfmt", () => {
            expect.assertions(1);

            generateVscodeConfig(projectDir, false);

            expect(existsSync(join(projectDir, ".vscode"))).toBe(false);
        });

        it("keeps existing user values when merging into settings that already exist", () => {
            expect.assertions(1);

            mkdirSync(join(projectDir, ".vscode"));
            writeFileSync(join(projectDir, ".vscode", "settings.json"), JSON.stringify({ "editor.formatOnSave": false }));

            generateVscodeConfig(projectDir);

            expect(JSON.parse(readFileSync(join(projectDir, ".vscode", "settings.json"), "utf8"))).toStrictEqual({
                "editor.defaultFormatter": "oxc.oxc-vscode",
                "editor.formatOnSave": false,
            });
        });
    });

    describe(generateAiInstructions, () => {
        it("writes .ai/instructions with the package manager commands", () => {
            expect.assertions(1);

            generateAiInstructions(projectDir, "pnpm");

            expect(readFileSync(join(projectDir, ".ai", "instructions"), "utf8")).toContain("- Build: `pnpm run build`");
        });

        it("lists only the run commands an existing repo defines, without vis-specific conventions", () => {
            expect.assertions(3);

            writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "legacy", scripts: { build: "tsc", test: "vitest" } }));

            generateAiInstructions(projectDir, "npm", { existingProject: true });

            const content = readFileSync(join(projectDir, ".ai", "instructions"), "utf8");

            expect(content).toContain("- Build: `npm run build`");
            expect(content).not.toContain("scaffolded with vis create");
            expect(content).not.toContain("- Lint:");
        });

        it("leaves instructions that a template already provided untouched", () => {
            expect.assertions(1);

            mkdirSync(join(projectDir, ".ai"));
            writeFileSync(join(projectDir, ".ai", "instructions"), "from the template");

            generateAiInstructions(projectDir, "pnpm");

            expect(readFileSync(join(projectDir, ".ai", "instructions"), "utf8")).toBe("from the template");
        });
    });
});
