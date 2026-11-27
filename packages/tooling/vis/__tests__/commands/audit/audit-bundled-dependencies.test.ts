import { mkdirSync, mkdtempSync, promises as fsPromises, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real lock file, real reader, real handler, a real `node_modules` tree. Only the OSV querybatch endpoint (global
// `fetch`) and the output sinks are stubbed. The lock file lists `host` alone; `host` ships `bundled-dep` inside itself
// (`bundleDependencies`), so the dependency is known only from disk, and the advisory source reports a finding for it.

const OSV_URL = "https://api.osv.dev/v1/querybatch";

interface Report {
    packages: number;
    results: { dependencyPaths: { name: string; version: string }[][]; name: string; version: string; vulnerabilities: { id: string }[] }[];
}

let workspaceRoot: string;
let stdoutChunks: string[];
let queried: string[];

const write = (relative: string, content: unknown): void => {
    mkdirSync(dirname(join(workspaceRoot, relative)), { recursive: true });
    writeFileSync(join(workspaceRoot, relative), typeof content === "string" ? content : JSON.stringify(content));
};

const layout = (dependencyField: "dependencies" | "devDependencies" = "dependencies"): void => {
    const other = dependencyField === "dependencies" ? "devDependencies" : "dependencies";

    // `plain` keeps one production package in the scan when `host` is dev-only.
    write("package.json", { [dependencyField]: { host: "1.0.0" }, name: "bundled-app", [other]: { plain: "1.0.0" }, version: "1.0.0", workspaces: ["packages/*"] });
    write("package-lock.json", {
        lockfileVersion: 3,
        packages: { "": { name: "bundled-app", version: "1.0.0" }, "node_modules/host": { version: "1.0.0" }, "node_modules/plain": { version: "1.0.0" } },
    });
    write("node_modules/plain/package.json", { name: "plain", version: "1.0.0" });
    write("node_modules/host/package.json", { bundleDependencies: ["bundled-dep"], name: "host", version: "1.0.0" });
    write("node_modules/host/node_modules/bundled-dep/package.json", { name: "bundled-dep", version: "2.5.0" });
};

const stubOsv = (): void => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: { body: string }) => {
            if (url !== OSV_URL) {
                throw new Error(`unexpected network call: ${url}`);
            }

            const { queries } = JSON.parse(init.body) as { queries: { package: { name: string }; version: string }[] };

            queried = queries.map((query) => `${query.package.name}@${query.version}`);

            return Response.json({
                results: queries.map((query) =>
                    (query.package.name === "bundled-dep" ? { vulns: [{ database_specific: { severity: "HIGH" }, id: "GHSA-bundled-0001", summary: "prototype pollution" }] } : {}),
                ),
            });
        }),
    );
};

const execAudit = async (options: Record<string, unknown>): Promise<void> => {
    const { default: execute } = await import("../../../src/commands/audit/handler");

    await execute({
        fs: fsPromises,
        logger: console,
        options: { backend: "vis", ...options },
        visConfig: undefined,
        workspaceRoot,
    } as unknown as Parameters<typeof execute>[0]);
};

const runAudit = async (options: Record<string, unknown> = {}): Promise<Report> => {
    await execAudit({ format: "json", ...options });

    return JSON.parse(stdoutChunks.join(""));
};

describe("vis audit with a package that bundles a dependency", () => {
    beforeEach(() => {
        workspaceRoot = mkdtempSync(join(tmpdir(), "vis-audit-bundled-"));
        stdoutChunks = [];
        queried = [];
        process.exitCode = undefined;
        layout();
        stubOsv();
        vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            stdoutChunks.push(String(chunk));

            return true;
        });
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        process.exitCode = undefined;
        rmSync(workspaceRoot, { force: true, recursive: true });
    });

    it("asks the advisory source about the bundled package and counts it as scanned", async () => {
        expect.assertions(2);

        const report = await runAudit();

        expect(queried.toSorted()).toStrictEqual(["bundled-dep@2.5.0", "host@1.0.0", "plain@1.0.0"]);
        expect(report.packages).toBe(3);
    });

    it("lists a finding in the bundled package with the host in its path", async () => {
        expect.assertions(1);

        const report = await runAudit();

        expect(report.results.map((entry) => [entry.name, entry.version, entry.vulnerabilities.map((v) => v.id), entry.dependencyPaths])).toStrictEqual([
            [
                "bundled-dep",
                "2.5.0",
                ["GHSA-bundled-0001"],
                [
                    [
                        { name: "host", version: "1.0.0" },
                        { name: "bundled-dep", version: "2.5.0" },
                    ],
                ],
            ],
        ]);
    });

    it("fails --exit-code on a finding in a bundled package like on any other", async () => {
        expect.assertions(1);

        await runAudit({ exitCode: true });

        expect(process.exitCode).toBe(1);
    });

    it("leaves the bundled copies of a dev-only host out under --prod-only", async () => {
        expect.assertions(3);

        layout("devDependencies");

        const report = await runAudit({ prodOnly: true });

        expect(queried).toStrictEqual(["plain@1.0.0"]);
        expect(report.results).toStrictEqual([]);
        expect(report.packages).toBe(1);
    });

    it("under --usage keeps a bundled finding when the workspace imports the host, not the bundled name", async () => {
        expect.assertions(2);

        // `host` is a transitive package here: the reachability scan also counts every name a package.json declares.
        write("package.json", { name: "bundled-app", version: "1.0.0", workspaces: ["packages/*"] });
        write("src/index.js", 'import "host";\n');

        const imported = await runAudit({ usage: true });

        expect(imported.results.map((entry) => entry.name)).toStrictEqual(["bundled-dep"]);

        stdoutChunks = [];
        write("src/index.js", "export {};\n");

        const unused = await runAudit({ usage: true });

        expect(unused.results).toStrictEqual([]);
    });

    it("leaves a bundled finding out of --fix and says why", async () => {
        expect.assertions(2);

        const logged: string[] = [];

        vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
            logged.push(parts.join(" "));
        });
        vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            logged.push(String(chunk));

            return true;
        });

        await execAudit({ fix: true, format: "json", yes: true });

        const text = logged.join("\n") + stdoutChunks.join("");

        expect(text).toContain("bundled inside other packages");
        expect(text).toContain("Upgrade the package that ships it: host@1.0.0");
    });

    it("names the host in SARIF and JUnit text", async () => {
        expect.assertions(2);

        await execAudit({ format: "sarif" });

        const sarif = JSON.parse(stdoutChunks.join("")) as { runs: { results: { message: { text: string } }[] }[] };

        expect(sarif.runs[0]?.results[0]?.message.text).toContain("(bundled in host@1.0.0 > bundled-dep@2.5.0)");

        stdoutChunks = [];

        await execAudit({ format: "junit" });

        expect(stdoutChunks.join("")).toContain("Bundled in: host@1.0.0 > bundled-dep@2.5.0");
    });

    it("adds the bundled package to the CycloneDX BOM so the VEX reference resolves", async () => {
        expect.assertions(3);

        await execAudit({ format: "cyclonedx-vex" });

        const vex = JSON.parse(stdoutChunks.join("")) as {
            components: { "bom-ref": string }[];
            dependencies: { dependsOn?: string[]; ref: string }[];
            vulnerabilities: { affects: { ref: string }[] }[];
        };
        const refs = new Set(vex.components.map((component) => component["bom-ref"]));
        const affected = vex.vulnerabilities.flatMap((vulnerability) => vulnerability.affects.map((affect) => affect.ref));

        expect(affected).toStrictEqual(["pkg:npm/bundled-dep@2.5.0"]);
        expect(affected.every((ref) => refs.has(ref))).toBe(true);
        expect(vex.dependencies.find((dependency) => dependency.ref === "pkg:npm/host@1.0.0")?.dependsOn).toContain("pkg:npm/bundled-dep@2.5.0");
    });
});
