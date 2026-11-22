import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyContext, buildContext, publishContext } from "../../../src/release/core/orchestrator";
import type { PublishResult } from "../../../src/release/core/package-managers/interface";
import type { PublishContext } from "../../../src/release/core/version-actions/interface";
import { VersionActions } from "../../../src/release/core/version-actions/interface";

class CapturingVersionActions extends VersionActions {
    public readonly id = "stub";

    public readonly manifests = new Map<string, Record<string, unknown>>();

    public async readPublishedVersion(): Promise<string | undefined> {
        return undefined;
    }

    public async publish(context: PublishContext): Promise<PublishResult> {
        this.manifests.set(context.pkg.name, context.versionedManifestByName.get(context.pkg.name) as Record<string, unknown>);

        return { alreadyPublished: false, output: "ok", published: true };
    }
}

const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
};

const writePackage = (cwd: string, dir: string, manifest: Record<string, unknown>): void => {
    mkdirSync(join(cwd, "packages", dir), { recursive: true });
    writeJson(join(cwd, "packages", dir, "package.json"), manifest);
};

/** `b` depends on `a` through a literal range, and both are released together. */
const setupFixture = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "vis-orch-published-manifest-"));

    writeJson(join(cwd, "package.json"), { name: "fixture-root", packageManager: "pnpm@10.0.0", private: true, version: "0.0.0", workspaces: ["packages/*"] });
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writePackage(cwd, "a", { name: "@scope/a", version: "1.0.0" });
    writePackage(cwd, "b", { dependencies: { "@scope/a": "^1.0.0" }, name: "@scope/b", version: "1.0.0" });

    mkdirSync(join(cwd, ".vis", "release"), { recursive: true });
    writeFileSync(join(cwd, ".vis", "release", "fix.md"), '---\n"@scope/a": patch\n"@scope/b": patch\n---\nbody\n');
    writeFileSync(join(cwd, "vis.config.cjs"), `module.exports = ${JSON.stringify({ release: { acknowledgeUnstable: true, defaultManaged: true, verifyLockfile: false } }, null, 4)};\n`);

    execFileSync("git", ["init", "-q"], { cwd });

    return cwd;
};

describe("orchestrator: the published manifest is the one the version step wrote", () => {
    let cwd: string;

    afterEach(async () => {
        await rm(cwd, { force: true, recursive: true });
    });

    it("carries the dependency range the version step raised, not the one the graph loaded", async () => {
        expect.hasAssertions();

        cwd = setupFixture();

        const ctx = await buildContext({ cwd, firstRelease: true });

        // The version step rewrites every released package's package.json on disk after the graph was loaded.
        await applyContext(ctx, { dryRun: false });

        const raised = JSON.parse(readFileSync(join(cwd, "packages", "b", "package.json"), "utf8")) as { dependencies: Record<string, string> };

        expect(raised.dependencies["@scope/a"]).not.toBe("^1.0.0");

        const actions = new CapturingVersionActions();

        await publishContext(ctx, { noPush: true, noTag: true, publishActionsOverride: actions });

        expect(actions.manifests.get("@scope/b")).toStrictEqual(expect.objectContaining({ dependencies: raised.dependencies, version: "1.0.1" }));
    });

    it("fails a package whose manifest is gone from disk, and skips its dependents, instead of shipping the stale one", async () => {
        expect.hasAssertions();

        cwd = setupFixture();

        const ctx = await buildContext({ cwd, firstRelease: true });

        await rm(join(cwd, "packages", "a", "package.json"));

        const actions = new CapturingVersionActions();
        const result = await publishContext(ctx, { noPush: true, noTag: true, publishActionsOverride: actions });

        expect(result.failed).toStrictEqual([expect.objectContaining({ name: "@scope/a", reason: expect.stringMatching(/package\.json/u) })]);
        expect(result.skipped).toStrictEqual([expect.objectContaining({ name: "@scope/b", reason: expect.stringContaining("dependency-failed") })]);
        expect([...actions.manifests.keys()]).toStrictEqual([]);
    });
});
