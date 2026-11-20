import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `vis advisories bloom status --format json` exists twice: the Node command
 * (`src/commands/advisories/bloom-status.ts`) and the native fast path
 * (`native/cli/src/advisories.rs`). For every cache layout the native path accepts, both must
 * print the same bytes and exit the same way. Node needs the built CLI (`dist/bin.js`) and the
 * NAPI addon, so the whole comparison is skipped when `dist/bin.js` is missing.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");

const scratch = mkdtempSync(join(tmpdir(), "vis-advisories-parity-"));

// The scratch directory must be a pnpm workspace root. Node fails without a resolvable root, and the
// native gate only answers when the root resolves to the working directory (see `native_context`).
writeFileSync(join(scratch, "package.json"), "{}");
writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
writeFileSync(join(scratch, "pnpm-workspace.yaml"), "");

const manifest = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify(
        {
            advisory_count: 1234,
            bloom_byte_len: 380_000,
            bloom_k_hashes: 7,
            bloom_m_bits: 3_040_000,
            built_at_rfc3339: "2026-11-01T00:00:00Z",
            built_at_unix: 1_793_491_200,
            entry_count: 98_765,
            filter_sha256: "a".repeat(64),
            format_version: 1,
            set_digest_sha256: "b".repeat(64),
            source_url: "https://endevco.github.io/osv-bloom",
            target_fpr: 0.000_000_1,
            ...overrides,
        },
        undefined,
        2,
    );

const state = (overrides: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ fetchedAtIso: "2026-11-02T10:00:00.000Z", filterEtag: '"abc"', setDigestSha256: "b".repeat(64), ...overrides }, undefined, 2)}\n`;

/** Each fixture is a cache directory: the files to write, keyed by name. */
const FIXTURES: Record<string, Record<string, string>> = {
    "filter.bin without manifest": { "filter.bin": "x", "state.json": state() },
    "float target_fpr, small and large": { "filter.bin": "x", "manifest.json": manifest({ target_fpr: 0.001 }) },
    "full cache": { "filter.bin": "x", "manifest.json": manifest(), "state.json": state() },
    "huge integer count": { "filter.bin": "x", "manifest.json": manifest({ advisory_count: 1e21 }) },
    "malformed manifest": { "filter.bin": "x", "manifest.json": "{ not json", "state.json": state() },
    "manifest with a missing field": { "filter.bin": "x", "manifest.json": manifest({ target_fpr: undefined }), "state.json": state() },
    "no filter.bin": {},
    "state missing": { "filter.bin": "x", "manifest.json": manifest() },
    "state without fetchedAtIso": { "filter.bin": "x", "manifest.json": manifest(), "state.json": state({ fetchedAtIso: undefined }) },
    "unicode and escaped path": { "filter.bin": "x", "manifest.json": manifest({ source_url: "https://endevco.github.io/osv-bloom?q=\"é\"" }) },
    "unsupported format_version": { "filter.bin": "x", "manifest.json": manifest({ format_version: 2 }) },
    "very small target_fpr": { "filter.bin": "x", "manifest.json": manifest({ target_fpr: 1.5e-7 }) },
};

const cacheDirFor = (name: string, files: Record<string, string>): string => {
    const directory = join(scratch, name.replaceAll(/\W+/g, "-"));

    mkdirSync(directory, { recursive: true });

    for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(directory, file), content);
    }

    return directory;
};

/**
 * Runs one command in the scratch directory. `ci` decides whether the CI variables are set, which
 * is what Node's config notices check; they are removed (not emptied) when `ci` is false, because
 * `is-in-ci` counts an empty `CI` as set.
 */
const run = (command: string, args: string[], options: { ci: boolean; cwd?: string; extraEnv?: Record<string, string> }) => {
    // An inherited root (from a parent vis run) would make the native gate answer for another workspace.
    const env: Record<string, string | undefined> = { ...process.env };

    delete env["VIS_MONOREPO_ROOT"];
    Object.assign(env, { VIS_CLI_TEST: "1", VIS_NO_UPDATE_CHECK: "1", ...options.extraEnv });
    delete env["CI"];
    delete env["CONTINUOUS_INTEGRATION"];

    if (options.ci) {
        env["CI"] = "1";
    }

    return spawnSync(command, args, { cwd: options.cwd ?? scratch, encoding: "utf8", env });
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))(
    "vis advisories bloom status: native vs Node",
    () => {
        afterAll(() => {
            rmSync(scratch, { force: true, recursive: true });
        });

        const missingEntry = join(scratch, "missing-entry.js");
        const delegation = { VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath };
        const nativeOnly = { VIS_FALLBACK_ENTRY_OVERRIDE: missingEntry, VIS_NODE: process.execPath };

        it.each(Object.entries(FIXTURES))("prints the same JSON for %s", (name, files) => {
            expect.assertions(2);

            const cacheDir = cacheDirFor(name, files);
            const args = ["advisories", "bloom", "status", "--format", "json", "--cache-dir", cacheDir];

            const native = run(binary as string, args, { ci: true, extraEnv: delegation });
            const node = run(process.execPath, [nodeEntry, ...args], { ci: true });

            expect(native.status).toBe(node.status);
            expect(native.stdout).toBe(node.stdout);
        });

        // A delegated run cannot reach the missing entry, so these fixtures prove the binary answered itself.
        it.each(["full cache", "filter.bin without manifest", "no filter.bin"])("answers %s natively, without a Node fallback", (name) => {
            expect.assertions(3);

            const cacheDir = cacheDirFor(name, FIXTURES[name]);
            const args = ["advisories", "bloom", "status", "--format", "json", "--cache-dir", cacheDir];

            const native = run(binary as string, args, { ci: true, extraEnv: nativeOnly });
            const node = run(process.execPath, [nodeEntry, ...args], { ci: true });

            expect(native.status).toBe(0);
            expect(node.status).toBe(0);
            expect(native.stdout).toBe(node.stdout);
        });

        it("delegates when VIS_MONOREPO_ROOT names another directory, and matches Node", () => {
            expect.assertions(3);

            const cacheDir = cacheDirFor("stale root", FIXTURES["full cache"]);
            const args = ["advisories", "bloom", "status", "--format", "json", "--cache-dir", cacheDir];

            const stale = run(binary as string, args, { ci: true, extraEnv: { ...nativeOnly, VIS_MONOREPO_ROOT: dirname(scratch) } });
            const node = run(process.execPath, [nodeEntry, ...args], { ci: true, extraEnv: { VIS_MONOREPO_ROOT: dirname(scratch) } });

            expect(stale.status).not.toBe(0);
            expect(node.status).toBe(0);
            expect(stale.stdout).toBe("");
        });

        it("delegates when no workspace root resolves, and matches Node's failure", () => {
            expect.assertions(3);

            // A bare package.json is a marker, not a workspace: Node fails with "Could not determine workspace root".
            // It sits outside `scratch`, because Node's search would otherwise climb to the pnpm workspace there.
            const bare = mkdtempSync(join(tmpdir(), "vis-advisories-bare-"));

            writeFileSync(join(bare, "package.json"), "{}");

            const cacheDir = cacheDirFor("bare package root", FIXTURES["full cache"]);
            const args = ["advisories", "bloom", "status", "--format", "json", "--cache-dir", cacheDir];

            const native = run(binary as string, args, { ci: true, cwd: bare, extraEnv: delegation });
            const node = run(process.execPath, [nodeEntry, ...args], { ci: true, cwd: bare });

            expect(native.status).not.toBe(0);
            expect(native.status).toBe(node.status);
            expect(native.stdout).toBe(node.stdout);

            rmSync(bare, { force: true, recursive: true });
        });

        it("delegates outside CI and matches Node's exit status and stdout", () => {
            expect.assertions(2);

            const cacheDir = cacheDirFor("delegated outside CI", FIXTURES["full cache"]);
            const args = ["advisories", "bloom", "status", "--format", "json", "--cache-dir", cacheDir];

            const native = run(binary as string, args, { ci: false, extraEnv: delegation });
            const node = run(process.execPath, [nodeEntry, ...args], { ci: false });

            expect(native.status).toBe(node.status);
            expect(native.stdout).toBe(node.stdout);
        });
    },
);
