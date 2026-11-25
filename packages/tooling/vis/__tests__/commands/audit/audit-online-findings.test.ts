import { mkdtempSync, promises as fsPromises, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real lock file, real reader, real handler. Only the OSV querybatch endpoint (global `fetch`) and the
// stdout sink are stubbed. The bug this guards against: the online catalog keys findings per
// `name@version` but the handler read them by bare `name`, so an online audit never listed anything.

const NPM_LOCK = {
    lockfileVersion: 3,
    packages: {
        "": { name: "online-app", version: "1.0.0" },
        "node_modules/clean-pkg": { version: "1.0.0" },
        "node_modules/lodash": { version: "4.17.20" },
    },
};

const OSV_URL = "https://api.osv.dev/v1/querybatch";

interface Report {
    results: { name: string; version: string; vulnerabilities: { id: string; severity: string }[] }[];
}

let workspaceRoot: string;
let stdoutChunks: string[];
let osvVulns: Record<string, unknown>[];

const stubOsv = (): void => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: { body: string }) => {
            if (url !== OSV_URL) {
                throw new Error(`unexpected network call: ${url}`);
            }

            const { queries } = JSON.parse(init.body) as { queries: { package: { name: string } }[] };
            const results = queries.map((query) => (query.package.name === "lodash" ? { vulns: osvVulns } : {}));

            return Response.json({ results });
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

describe("vis audit online findings", () => {
    beforeEach(() => {
        workspaceRoot = mkdtempSync(join(tmpdir(), "vis-audit-online-"));
        stdoutChunks = [];
        osvVulns = [{ database_specific: { severity: "HIGH" }, id: "GHSA-lodash-proto", summary: "prototype pollution" }];
        process.exitCode = undefined;
        writeFileSync(join(workspaceRoot, "package-lock.json"), JSON.stringify(NPM_LOCK));
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

    it("lists a finding returned by the online catalog", async () => {
        expect.assertions(1);

        const report = await runAudit();

        expect(report.results.map((entry) => [entry.name, entry.version, entry.vulnerabilities.map((v) => v.id)])).toStrictEqual([
            ["lodash", "4.17.20", ["GHSA-lodash-proto"]],
        ]);
    });

    it("lists nothing and exits zero when the catalog has no findings", async () => {
        expect.assertions(2);

        osvVulns = [];

        const report = await runAudit({ exitCode: true, failOn: "low" });

        expect(report.results).toStrictEqual([]);
        expect(process.exitCode).not.toBe(1);
    });

    it("hides findings below --severity", async () => {
        expect.assertions(2);

        const high = await runAudit({ severity: "high" });

        stdoutChunks = [];

        const critical = await runAudit({ severity: "critical" });

        expect(high.results).toHaveLength(1);
        expect(critical.results).toHaveLength(0);
    });

    it("exits non-zero with --exit-code when a finding is listed", async () => {
        expect.assertions(1);

        await runAudit({ exitCode: true });

        expect(process.exitCode).toBe(1);
    });

    it("exits non-zero with --exit-code in the default table format", async () => {
        expect.assertions(1);

        await execAudit({ exitCode: true });

        expect(process.exitCode).toBe(1);
    });

    it("exits zero without --exit-code when a finding is listed", async () => {
        expect.assertions(1);

        await runAudit();

        expect(process.exitCode).not.toBe(1);
    });

    it("trips --fail-on at or below the finding's severity", async () => {
        expect.assertions(1);

        await runAudit({ failOn: "high" });

        expect(process.exitCode).toBe(1);
    });

    it("does not trip --fail-on above the finding's severity", async () => {
        expect.assertions(1);

        await runAudit({ failOn: "critical" });

        expect(process.exitCode).not.toBe(1);
    });
});
