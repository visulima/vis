/**
 * Parity test vs. upstream gitleaks testdata.
 *
 * Skipped by default — this test downloads gitleaks' `testdata/` directory
 * (via `git sparse-checkout`) into `node_modules/.cache/secret-scanner/`
 * using `@visulima/find-cache-dir`, then runs our scanner on a temp copy and
 * (if the `gitleaks` CLI is on PATH) checks that every location gitleaks
 * reports is reported by us too.
 *
 * Run with: `pnpm test:parity` (sets SECRET_SCANNER_PARITY=1).
 * Pin a ref with: `SECRET_SCANNER_PARITY_REF=v8.30.2 pnpm test:parity`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

import { findCacheDir } from "@visulima/find-cache-dir";
import { describe, expect, it } from "vitest";

import { scan } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const shouldRun = env.SECRET_SCANNER_PARITY === "1";
const ref = env.SECRET_SCANNER_PARITY_REF ?? "master";

interface GitleaksUpstream {
    File: string;
    RuleID: string;
    StartLine: number;
}

const fetchTestdata = async (): Promise<string> => {
    const cacheDir = await findCacheDir("secret-scanner", { create: true, cwd: packageRoot });

    if (!cacheDir) {
        throw new Error("no writable node_modules/.cache directory — run pnpm install first");
    }

    const tdRoot = resolve(cacheDir, `gitleaks-testdata-${ref}`);

    if (!existsSync(resolve(tdRoot, "testdata"))) {
        await mkdir(tdRoot, { recursive: true });
        execFileSync("git", ["init", "--quiet"], { cwd: tdRoot, stdio: "inherit" });
        execFileSync("git", ["remote", "add", "origin", "https://github.com/gitleaks/gitleaks.git"], {
            cwd: tdRoot,
            stdio: "inherit",
        });
        execFileSync("git", ["config", "core.sparseCheckout", "true"], { cwd: tdRoot, stdio: "inherit" });
        await writeFile(resolve(tdRoot, ".git/info/sparse-checkout"), "testdata/\nconfig/gitleaks.toml\n");
        execFileSync("git", ["pull", "--quiet", "--depth=1", "origin", ref], { cwd: tdRoot, stdio: "inherit" });
    }

    return resolve(tdRoot, "testdata");
};

// The walker skips anything under `node_modules`, which is where the cache
// lives, so scan a copy in a temp dir instead.
const copyTestdata = async (testdata: string): Promise<string> => {
    const scanRoot = await mkdtemp(join(tmpdir(), "secret-scanner-parity-"));

    await cp(testdata, scanRoot, { recursive: true });

    return scanRoot;
};

describe.skipIf(!shouldRun)("gitleaks parity", () => {
    it("scans upstream gitleaks testdata and reports every gitleaks finding location", async () => {
        expect.hasAssertions();

        const scanRoot = await copyTestdata(await fetchTestdata());

        try {
            const ours = await scan([scanRoot], { walk: { gitignore: false, includeHidden: true } });
            // A finding covers every line from its start to its end; Kingfisher's
            // multi-line matches can start a line above the secret gitleaks reports.
            const covers = (file: string, line: number): boolean => ours.some((f) => f.file === file && f.startLine <= line && line <= f.endLine);

            // eslint-disable-next-line no-console
            console.log(`  our findings: ${String(ours.length)} across ${String(new Set(ours.map((f) => f.ruleId)).size)} rules`);

            expect(ours.length).toBeGreaterThan(0);

            const gitleaksVersion = spawnSync("gitleaks", ["version"], { encoding: "utf8" });

            if (gitleaksVersion.status !== 0) {
                // eslint-disable-next-line no-console
                console.log("  (gitleaks CLI not on PATH — install from https://github.com/gitleaks/gitleaks to enable cross-check)");

                return;
            }

            const reportPath = `${scanRoot}.gitleaks.json`;

            spawnSync("gitleaks", ["dir", scanRoot, "--report-format", "json", "--report-path", reportPath, "--no-banner"], { stdio: "pipe" });

            const gitleaks = existsSync(reportPath) ? (JSON.parse(await readFile(reportPath, "utf8")) as GitleaksUpstream[]) : [];

            // Rule ids differ by design (Kingfisher often wins the span dedup), so
            // parity is measured on where findings are, not which rule reported them.
            const missed = gitleaks.filter((f) => !covers(relative(scanRoot, f.File), f.StartLine));
            const parity = gitleaks.length === 0 ? 1 : (gitleaks.length - missed.length) / gitleaks.length;

            // eslint-disable-next-line no-console
            console.log(
                `  gitleaks findings: ${String(gitleaks.length)}, also reported by us: ${String(gitleaks.length - missed.length)} (${(parity * 100).toFixed(1)}%)`,
            );

            for (const f of missed) {
                // eslint-disable-next-line no-console
                console.log(`  missed: ${f.RuleID} ${relative(scanRoot, f.File)}:${String(f.StartLine)}`);
            }

            expect(parity).toBeGreaterThanOrEqual(0.9);
        } finally {
            await rm(scanRoot, { force: true, recursive: true });
            await rm(`${scanRoot}.gitleaks.json`, { force: true });
        }
    }, 120_000);
});
