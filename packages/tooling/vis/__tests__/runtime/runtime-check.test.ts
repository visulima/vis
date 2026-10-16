import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkRuntimeVersions } from "../../src/runtime/runtime-check";

describe("runtime-check", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "vis-runtime-check-"));
    });

    afterEach(() => {
        rmSync(tmpDir, { force: true, recursive: true });
    });

    describe(checkRuntimeVersions, () => {
        it("should return empty findings when no package.json exists", () => {
            expect.assertions(1);

            const findings = checkRuntimeVersions(tmpDir);

            expect(findings).toHaveLength(0);
        });

        it("should return no findings when engines.node is satisfied by the current runtime", () => {
            expect.assertions(1);

            const actualMajor = Number.parseInt(process.versions.node.split(".")[0]!, 10);

            writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ engines: { node: `>=${actualMajor}` } }));

            const findings = checkRuntimeVersions(tmpDir);

            expect(findings).toHaveLength(0);
        });

        it("should report an error when engines.node is not satisfied", () => {
            expect.assertions(4);

            writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ engines: { node: ">=999" } }));

            const findings = checkRuntimeVersions(tmpDir);

            expect(findings).toHaveLength(1);
            expect(findings[0]!.kind).toBe("node");
            expect(findings[0]!.severity).toBe("error");
            expect(findings[0]!.message).toContain("engines.node requires >=999");
        });

        it("should report a warning when .nvmrc major version mismatches", () => {
            expect.assertions(4);

            writeFileSync(join(tmpDir, "package.json"), JSON.stringify({}));

            const actualMajor = Number.parseInt(process.versions.node.split(".")[0]!, 10);
            const mismatchedMajor = actualMajor + 10;

            writeFileSync(join(tmpDir, ".nvmrc"), `v${mismatchedMajor}.0.0`);

            const findings = checkRuntimeVersions(tmpDir);

            expect(findings).toHaveLength(1);
            expect(findings[0]!.kind).toBe("node");
            expect(findings[0]!.severity).toBe("warning");
            expect(findings[0]!.message).toContain(".nvmrc pins Node");
        });

        it("should not warn when .nvmrc matches the current major.minor", () => {
            expect.assertions(1);

            writeFileSync(join(tmpDir, "package.json"), JSON.stringify({}));

            const [major, minor] = process.versions.node.split(".");

            writeFileSync(join(tmpDir, ".nvmrc"), `v${major}.${minor}.0`);

            const findings = checkRuntimeVersions(tmpDir);

            expect(findings).toHaveLength(0);
        });

        it("should detect packageManager name mismatch from npm_config_user_agent", () => {
            expect.assertions(4);

            writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0" }));

            const originalAgent = process.env["npm_config_user_agent"];

            try {
                process.env["npm_config_user_agent"] = "yarn/4.1.0 node/22.0.0";

                const findings = checkRuntimeVersions(tmpDir);

                const pmFinding = findings.find((f) => f.kind === "packageManager");

                expect(pmFinding).toBeDefined();
                expect(pmFinding!.severity).toBe("error");
                expect(pmFinding!.expected).toBe("pnpm");
                expect(pmFinding!.actual).toBe("yarn");
            } finally {
                if (originalAgent === undefined) {
                    delete process.env["npm_config_user_agent"];
                } else {
                    process.env["npm_config_user_agent"] = originalAgent;
                }
            }
        });

        it("should detect packageManager version mismatch from npm_config_user_agent", () => {
            expect.assertions(4);

            writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0" }));

            const originalAgent = process.env["npm_config_user_agent"];

            try {
                process.env["npm_config_user_agent"] = "pnpm/9.5.0 node/22.0.0";

                const findings = checkRuntimeVersions(tmpDir);

                const pmFinding = findings.find((f) => f.kind === "packageManager");

                expect(pmFinding).toBeDefined();
                expect(pmFinding!.severity).toBe("warning");
                expect(pmFinding!.expected).toBe("10.0.0");
                expect(pmFinding!.actual).toBe("9.5.0");
            } finally {
                if (originalAgent === undefined) {
                    delete process.env["npm_config_user_agent"];
                } else {
                    process.env["npm_config_user_agent"] = originalAgent;
                }
            }
        });

        describe("devEngines", () => {
            it.each([
                [{ name: "node", onFail: "error", version: "<1" }, "error"],
                [{ name: "node", version: "<1" }, "warning"],
                [{ name: "node", onFail: "warn", version: "<1" }, "warning"],
                [{ name: "node", onFail: "download", version: "<1" }, "warning"],
            ])("reports an unsatisfied runtime with the severity its onFail picks: %j", (entry, severity) => {
                expect.assertions(2);

                writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ devEngines: { runtime: entry } }));

                const finding = checkRuntimeVersions(tmpDir).find((f) => f.kind === "node");

                expect(finding?.severity).toBe(severity);
                expect(finding?.expected).toBe("<1");
            });

            it("reports nothing when onFail is ignore", () => {
                expect.assertions(1);

                writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ devEngines: { runtime: { name: "node", onFail: "ignore", version: "<1" } } }));

                expect(checkRuntimeVersions(tmpDir)).toHaveLength(0);
            });

            it("reports nothing when one entry of an alternatives array is satisfied", () => {
                expect.assertions(1);

                const actualMajor = Number.parseInt(process.versions.node.split(".")[0]!, 10);

                writeFileSync(
                    join(tmpDir, "package.json"),
                    JSON.stringify({ devEngines: { runtime: [{ name: "node", onFail: "error", version: "<1" }, { name: "node", version: `>=${actualMajor}` }] } }),
                );

                expect(checkRuntimeVersions(tmpDir)).toHaveLength(0);
            });

            it("reports a running package manager that the devEngines entry does not allow", () => {
                expect.assertions(2);

                const originalAgent = process.env["npm_config_user_agent"];

                process.env["npm_config_user_agent"] = "pnpm/9.5.0 node/v24.0.0";

                try {
                    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ devEngines: { packageManager: { name: "pnpm", onFail: "error", version: "10.0.0" } } }));

                    const finding = checkRuntimeVersions(tmpDir).find((f) => f.kind === "packageManager");

                    expect(finding?.severity).toBe("error");
                    expect(finding?.message).toContain("requires pnpm@10.0.0");
                } finally {
                    if (originalAgent === undefined) {
                        delete process.env["npm_config_user_agent"];
                    } else {
                        process.env["npm_config_user_agent"] = originalAgent;
                    }
                }
            });

            it("does not judge a launcher that the devEngines entries do not name (npx under npm)", () => {
                expect.assertions(1);

                const originalAgent = process.env["npm_config_user_agent"];

                process.env["npm_config_user_agent"] = "npm/10.0.0 node/v24.0.0";

                try {
                    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ devEngines: { packageManager: { name: "pnpm", onFail: "error", version: "^9" } } }));

                    expect(checkRuntimeVersions(tmpDir).filter((f) => f.kind === "packageManager")).toHaveLength(0);
                } finally {
                    if (originalAgent === undefined) {
                        delete process.env["npm_config_user_agent"];
                    } else {
                        process.env["npm_config_user_agent"] = originalAgent;
                    }
                }
            });

            it("skips the package-manager check when a top-level packageManager already pins the tool", () => {
                expect.assertions(1);

                const originalAgent = process.env["npm_config_user_agent"];

                process.env["npm_config_user_agent"] = "pnpm/9.5.0 npm/? node/v24.0.0";

                try {
                    writeFileSync(
                        join(tmpDir, "package.json"),
                        JSON.stringify({ devEngines: { packageManager: { name: "pnpm", onFail: "error", version: "10.0.0" } }, packageManager: "pnpm@9.5.0" }),
                    );

                    expect(checkRuntimeVersions(tmpDir).filter((f) => f.kind === "packageManager")).toHaveLength(0);
                } finally {
                    if (originalAgent === undefined) {
                        delete process.env["npm_config_user_agent"];
                    } else {
                        process.env["npm_config_user_agent"] = originalAgent;
                    }
                }
            });
        });
    });
});
