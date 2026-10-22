import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rslintAdapter } from "../../../src/lint-fmt/adapters/rslint";
import type { RunResult, ToolPresence } from "../../../src/lint-fmt/config-types";

let workspaceRoot: string;

const stubResult = (overrides: Partial<RunResult>): RunResult => {
    return { durationMs: 1, exitCode: 0, stderr: "", stdout: "", ...overrides };
};

const presence = (): ToolPresence => {
    return { adapter: "rslint", declared: true, declaredVersion: "0.9.5", root: workspaceRoot };
};

// Captured from `rslint --format jsonline --rule 'no-var: error' src/a.ts src/c.ts` (@rslint/core 0.9.5).
const TWO_FILES_OUTPUT = [
    "{\"ruleName\":\"no-var\",\"message\":\"Unexpected var, use let or const instead.\",\"filePath\":\"src/a.ts\",\"range\":{\"start\":{\"line\":1,\"column\":1},\"end\":{\"line\":1,\"column\":11}},\"severity\":\"error\"}",
    "{\"ruleName\":\"no-unused-vars\",\"message\":\"'c' is assigned a value but never used.\",\"filePath\":\"src/c.ts\",\"range\":{\"start\":{\"line\":1,\"column\":5},\"end\":{\"line\":1,\"column\":6}},\"severity\":\"error\"}",
    "",
].join("\n");

// Captured from `rslint --format jsonline --rule 'no-var: warn' src/a.ts`: the severity is "warn".
const WARNING_OUTPUT = "{\"ruleName\":\"no-var\",\"message\":\"Unexpected var, use let or const instead.\",\"filePath\":\"src/a.ts\",\"range\":{\"start\":{\"line\":1,\"column\":1},\"end\":{\"line\":1,\"column\":11}},\"severity\":\"warn\"}\n";

describe("rslint adapter", () => {
    beforeEach(() => {
        workspaceRoot = mkdtempSync(join(tmpdir(), "vis-rslint-"));
    });

    afterEach(() => {
        rmSync(workspaceRoot, { force: true, recursive: true });
    });

    it("parses each JSON line into a finding, resolving the path against the workspace", () => {
        expect.assertions(2);

        const findings = rslintAdapter.parse(stubResult({ exitCode: 1, stdout: TWO_FILES_OUTPUT }), presence());

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            adapter: "rslint",
            column: 1,
            endColumn: 11,
            endLine: 1,
            file: join(workspaceRoot, "src/a.ts"),
            line: 1,
            ruleId: "no-var",
            severity: "error",
        });
    });

    it("maps the warn severity to warning", () => {
        expect.assertions(1);

        const [finding] = rslintAdapter.parse(stubResult({ exitCode: 0, stdout: WARNING_OUTPUT }), presence());

        expect(finding?.severity).toBe("warning");
    });

    it("skips lines that are not JSON, so a summary line does not become a finding", () => {
        expect.assertions(1);

        const findings = rslintAdapter.parse(stubResult({ exitCode: 1, stdout: `some banner\n${TWO_FILES_OUTPUT}\nsummary: 2 problems\n` }), presence());

        expect(findings).toHaveLength(2);
    });

    it("returns nothing for a clean run", () => {
        expect.assertions(1);

        expect(rslintAdapter.parse(stubResult({ exitCode: 0, stdout: "" }), presence())).toStrictEqual([]);
    });

    it("reports a crash as an error with the first stderr line when a non-zero exit has no findings", () => {
        expect.assertions(2);

        // Captured from a config with a syntax error: exit 1, nothing on stdout, the reason on stderr.
        const findings = rslintAdapter.parse(
            stubResult({
                exitCode: 1,
                stderr: "Warning: skipping config /repo/rslint.config.js: Unexpected token ';'\nerror: all discovered JavaScript configs failed to load",
                stdout: "",
            }),
            presence(),
        );

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ message: "Warning: skipping config /repo/rslint.config.js: Unexpected token ';'", severity: "error" });
    });

    it("detects rslint only when a config file exists, not from the dependency alone", () => {
        expect.assertions(2);

        const packageJson = { devDependencies: { "@rslint/core": "^0.9.5" } };

        expect(rslintAdapter.detect(workspaceRoot, packageJson)).toBeUndefined();

        writeFileSync(join(workspaceRoot, "rslint.config.ts"), "export default [];\n");

        expect(rslintAdapter.detect(workspaceRoot, packageJson)).toMatchObject({ adapter: "rslint", configFile: join(workspaceRoot, "rslint.config.ts"), declared: true });
    });

    it("builds check and fix arguments with jsonline output and the max-warnings form that works", () => {
        expect.assertions(2);

        expect(rslintAdapter.argsCheck(["."], { maxWarnings: 0, quiet: true })).toStrictEqual(["--format", "jsonline", "--quiet", "--max-warnings=0", "."]);
        expect(rslintAdapter.argsFix(["src"], {})).toStrictEqual(["--format", "jsonline", "--fix", "src"]);
    });
});
