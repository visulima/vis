import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RegistryProbe } from "../../../src/release/core/orchestrator";
import { buildContext, findUnreleasedDependencies, publishContext } from "../../../src/release/core/orchestrator";
import type { PublishResult } from "../../../src/release/core/package-managers/interface";
import { createShellRunner } from "../../../src/release/core/shell-runner";
import type { PublishContext } from "../../../src/release/core/version-actions/interface";
import { VersionActions } from "../../../src/release/core/version-actions/interface";

class StubVersionActions extends VersionActions {
    public readonly id = "stub";

    public readonly calls: string[] = [];

    public async readPublishedVersion(): Promise<string | undefined> {
        return undefined;
    }

    public async publish(context: PublishContext): Promise<PublishResult> {
        this.calls.push(context.pkg.name);

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

/** `@scope/a` is released; it depends on `@scope/b` through `spec` and on `@scope/c` as a devDependency. */
const setupFixture = (spec: string, released: string[] = ["@scope/a"]): string => {
    const cwd = mkdtempSync(join(tmpdir(), "vis-orch-unreleased-deps-"));

    writeJson(join(cwd, "package.json"), { name: "fixture-root", packageManager: "pnpm@10.0.0", private: true, version: "0.0.0", workspaces: ["packages/*"] });
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writePackage(cwd, "a", { dependencies: { "@scope/b": spec }, devDependencies: { "@scope/c": "workspace:^" }, name: "@scope/a", version: "1.0.0" });
    writePackage(cwd, "b", { name: "@scope/b", version: "2.1.0" });
    writePackage(cwd, "c", { name: "@scope/c", version: "3.0.0" });

    mkdirSync(join(cwd, ".vis", "release"), { recursive: true });
    writeFileSync(join(cwd, ".vis", "release", "feat.md"), `---\n${released.map((name) => `"${name}": minor`).join("\n")}\n---\nbody\n`);
    writeFileSync(
        join(cwd, "vis.config.cjs"),
        `module.exports = ${JSON.stringify({ release: { acknowledgeUnstable: true, defaultManaged: true } }, null, 4)};\n`,
    );

    execFileSync("git", ["init", "-q"], { cwd });

    return cwd;
};

/** A registry that holds exactly the given `name@spec` answers; every other lookup is a miss. */
const registry = (answers: Record<string, boolean | undefined>): { asked: string[]; probe: RegistryProbe } => {
    const asked: string[] = [];

    return {
        asked,
        probe: async (pkg, spec) => {
            asked.push(`${pkg.name}@${spec}`);

            return Object.hasOwn(answers, `${pkg.name}@${spec}`) ? answers[`${pkg.name}@${spec}`] : false;
        },
    };
};

describe("orchestrator: a release never depends on an unpublished workspace version", () => {
    let cwd: string;

    afterEach(async () => {
        await rm(cwd, { force: true, recursive: true });
    });

    describe(publishContext, () => {
        beforeEach(() => {
            cwd = setupFixture("workspace:^");
        });

        it("publishes nothing when a dependency outside the wave is missing from the registry", async () => {
            expect.hasAssertions();

            const actions = new StubVersionActions();
            const ctx = await buildContext({ cwd, firstRelease: true });
            const { probe } = registry({});

            const result = await publishContext(ctx, { noPush: true, noTag: true, publishActionsOverride: actions, registryProbe: probe });

            expect(actions.calls).toStrictEqual([]);
            expect(result.published).toStrictEqual([]);
            expect(result.failed).toStrictEqual([
                expect.objectContaining({ name: "_unreleasedDependencies", reason: expect.stringContaining("@scope/a needs @scope/b@^2.1.0") }),
            ]);
        });

        it("publishes nothing when the registry cannot say whether the dependency exists", async () => {
            expect.hasAssertions();

            const actions = new StubVersionActions();
            const ctx = await buildContext({ cwd, firstRelease: true });
            const { probe } = registry({ "@scope/b@^2.1.0": undefined });

            const result = await publishContext(ctx, { noPush: true, noTag: true, publishActionsOverride: actions, registryProbe: probe });

            expect(actions.calls).toStrictEqual([]);
            expect(result.failed).toStrictEqual([expect.objectContaining({ reason: expect.stringContaining("@scope/b@^2.1.0 (registry did not answer)") })]);
        });

        it("publishes when the dependency is on the registry, and never asks about devDependencies", async () => {
            expect.hasAssertions();

            const actions = new StubVersionActions();
            const ctx = await buildContext({ cwd, firstRelease: true });
            const { asked, probe } = registry({ "@scope/b@^2.1.0": true });

            const result = await publishContext(ctx, { noPush: true, noTag: true, publishActionsOverride: actions, registryProbe: probe });

            expect(result.failed).toStrictEqual([]);
            expect(actions.calls).toStrictEqual(["@scope/a"]);
            expect(asked).toStrictEqual(["@scope/b@^2.1.0"]);
        });
    });

    it("does not ask the registry about a dependency released in the same wave", async () => {
        expect.hasAssertions();

        cwd = setupFixture("workspace:^", ["@scope/a", "@scope/b"]);

        const ctx = await buildContext({ cwd, firstRelease: true });
        const { asked, probe } = registry({});

        const found = await findUnreleasedDependencies(ctx, ctx.plan.releases, { registryProbe: probe, runner: createShellRunner() });

        expect(found.size).toBe(0);
        expect(asked).toStrictEqual([]);
    });

    it.each([
        ["workspace:*", "2.1.0"],
        ["workspace:~", "~2.1.0"],
        ["workspace:^2.0.0", "^2.0.0"],
        ["^2.1.0", "^2.1.0"],
    ])("checks %s as the published range %s", async (spec, published) => {
        expect.hasAssertions();

        cwd = setupFixture(spec);

        const ctx = await buildContext({ cwd, firstRelease: true });
        const { probe } = registry({});

        const found = await findUnreleasedDependencies(ctx, ctx.plan.releases, { registryProbe: probe, runner: createShellRunner() });

        expect(found.get("@scope/a")).toStrictEqual([{ dependency: "@scope/b", range: published, unknown: false }]);
    });
});
