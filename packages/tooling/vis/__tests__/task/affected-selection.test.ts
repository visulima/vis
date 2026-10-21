import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectConfiguration, ProjectGraph } from "@visulima/task-runner";
import { describe, expect, it, vi } from "vitest";

import { VisUserError } from "../../src/errors/vis-user-error";
import { invalidateExternalInputState, parsePorcelainStatus, persistExternalInputHashes, selectAffectedProjects } from "../../src/task/affected-selection";

const { getAffectedProjectsMock } = vi.hoisted(() => {
    return { getAffectedProjectsMock: vi.fn() };
});

vi.mock(import("@visulima/task-runner"), async (importOriginal) => {
    return {
        ...(await importOriginal<Record<string, unknown>>()),
        getAffectedProjects: getAffectedProjectsMock,
    };
});

const projects: Record<string, ProjectConfiguration> = {
    api: { root: "packages/api" },
    web: { root: "packages/web" },
};

const projectGraph: ProjectGraph = { dependencies: {}, nodes: {} };
const workspace = { projectGraph, projects, workspaceRoot: "/repo" };

const emptyResult = {
    affectedProjects: [],
    changedFiles: [],
    changedProjects: [],
    downstreamProjects: [],
    ignoredFiles: [],
    upstreamProjects: [],
};

describe(parsePorcelainStatus, () => {
    it("should extract paths from NUL-delimited status entries", () => {
        expect.assertions(1);

        expect(parsePorcelainStatus(" M packages/web/src/app.ts\0?? packages/api/new.ts\0")).toStrictEqual([
            "packages/web/src/app.ts",
            "packages/api/new.ts",
        ]);
    });

    it("should keep paths containing spaces intact", () => {
        expect.assertions(1);

        expect(parsePorcelainStatus(" M packages/web/my file.ts\0")).toStrictEqual(["packages/web/my file.ts"]);
    });

    it("should return both sides of a rename so the old project is affected too", () => {
        expect.assertions(1);

        // Rename entries carry the destination in the status field and the
        // origin as a separate NUL-terminated field.
        expect(parsePorcelainStatus("R  packages/api/new.ts\0packages/web/old.ts\0")).toStrictEqual(["packages/api/new.ts", "packages/web/old.ts"]);
    });

    it("should ignore a trailing empty field", () => {
        expect.assertions(1);

        expect(parsePorcelainStatus("")).toStrictEqual([]);
    });
});

describe(selectAffectedProjects, () => {
    it("should reject an invalid downstream scope", async () => {
        expect.assertions(1);

        await expect(selectAffectedProjects({ downstream: "sideways" }, workspace)).rejects.toThrow(/Invalid --downstream value/);
    });

    it("should reject an invalid upstream scope", async () => {
        expect.assertions(1);

        await expect(selectAffectedProjects({ upstream: "sideways" }, workspace)).rejects.toThrow(/Invalid --upstream value/);
    });

    it("should fall back when base or head is an explicitly empty string", async () => {
        expect.assertions(2);

        getAffectedProjectsMock.mockResolvedValueOnce(emptyResult);

        // `--base=` reaches the resolver as "", which `??` would preserve and
        // hand to git as an empty ref.
        const result = await selectAffectedProjects({ base: "", head: "", uncommitted: false }, workspace);

        const call = getAffectedProjectsMock.mock.calls.at(-1)?.[0];

        expect(call.base).not.toBe("");
        expect(result.notes.join("\n")).toMatch(/Resolved affected refs/);
    });

    it("should reject an invalid scope as a user error, not a crash", async () => {
        expect.assertions(1);

        await expect(selectAffectedProjects({ downstream: "sideways" }, workspace)).rejects.toThrow(VisUserError);
    });

    it("should pass an explicit base and head straight through without resolving", async () => {
        expect.assertions(3);

        getAffectedProjectsMock.mockResolvedValueOnce(emptyResult);

        const result = await selectAffectedProjects({ base: "HEAD~3", head: "HEAD", uncommitted: false }, workspace);

        expect(getAffectedProjectsMock).toHaveBeenCalledWith(expect.objectContaining({ base: "HEAD~3", head: "HEAD" }));
        // Nothing was auto-resolved, so there is no provenance note.
        expect(result.notes).toStrictEqual([]);
        expect(result.uncommittedFileCount).toBe(0);
    });

    it("should fold working-tree changes into the changed-file set for local runs", async () => {
        expect.assertions(2);

        getAffectedProjectsMock.mockResolvedValueOnce(emptyResult);

        const result = await selectAffectedProjects({ base: "HEAD~1", head: "HEAD" }, workspace, {
            readWorkingTreeChanges: () => ["packages/web/src/dirty.ts"],
            runningInCi: false,
        });

        expect(getAffectedProjectsMock).toHaveBeenCalledWith(expect.objectContaining({ additionalChangedFiles: ["packages/web/src/dirty.ts"] }));
        expect(result.uncommittedFileCount).toBe(1);
    });

    it("should drop uncommitted paths outside every project", async () => {
        expect.assertions(2);

        getAffectedProjectsMock.mockResolvedValueOnce(emptyResult);

        // `git status` reports untracked scratch too. Any path mapping to no
        // project makes getAffectedProjects mark EVERY project affected, so
        // `--affected` would silently become "build everything".
        const result = await selectAffectedProjects({ base: "HEAD~1", head: "HEAD" }, workspace, {
            readWorkingTreeChanges: () => ["plans/", "notes.md", ".vis/last-summary.json", "packages/web/src/a.ts"],
            runningInCi: false,
        });

        expect(getAffectedProjectsMock).toHaveBeenCalledWith(expect.objectContaining({ additionalChangedFiles: ["packages/web/src/a.ts"] }));
        expect(result.notes.join("\n")).toMatch(/ignoring 3 uncommitted path\(s\) outside any project/);
    });

    it("should keep an uncommitted root file that has owners, and forward the owners with affectedIgnore", async () => {
        expect.assertions(1);

        getAffectedProjectsMock.mockResolvedValueOnce(emptyResult);

        const fileOwners = { "Cargo.lock": ["api"] };

        await selectAffectedProjects(
            { base: "HEAD~1", head: "HEAD" },
            { ...workspace, fileOwners },
            {
                affectedIgnore: ["*.md"],
                readWorkingTreeChanges: () => ["Cargo.lock", "packages/api/src/index.ts", "notes.md"],
                runningInCi: false,
            },
        );

        expect(getAffectedProjectsMock).toHaveBeenCalledWith(
            expect.objectContaining({ additionalChangedFiles: ["Cargo.lock", "packages/api/src/index.ts"], fileOwners, ignoredFiles: ["*.md"] }),
        );
    });

    it("should ignore the working tree in CI, where the checkout is the whole truth", async () => {
        expect.assertions(2);

        getAffectedProjectsMock.mockResolvedValueOnce(emptyResult);

        const readWorkingTreeChanges = vi.fn(() => ["packages/web/src/dirty.ts"]);
        const result = await selectAffectedProjects({ base: "HEAD~1", head: "HEAD" }, workspace, { readWorkingTreeChanges, runningInCi: true });

        expect(readWorkingTreeChanges).not.toHaveBeenCalled();
        expect(result.uncommittedFileCount).toBe(0);
    });

    it("should honor an explicit --uncommitted even in CI", async () => {
        expect.assertions(1);

        getAffectedProjectsMock.mockResolvedValueOnce(emptyResult);

        const result = await selectAffectedProjects({ base: "HEAD~1", head: "HEAD", uncommitted: true }, workspace, {
            readWorkingTreeChanges: () => ["packages/api/x.ts"],
            runningInCi: true,
        });

        expect(result.uncommittedFileCount).toBe(1);
    });

    it("should explain rather than silently drop --uncommitted when --head pins a commit", async () => {
        expect.assertions(2);

        getAffectedProjectsMock.mockResolvedValueOnce(emptyResult);

        const readWorkingTreeChanges = vi.fn(() => ["packages/api/x.ts"]);
        const result = await selectAffectedProjects({ base: "HEAD~3", head: "abc1234", uncommitted: true }, workspace, {
            readWorkingTreeChanges,
            runningInCi: false,
        });

        expect(readWorkingTreeChanges).not.toHaveBeenCalled();
        expect(result.notes.join("\n")).toMatch(/ignoring --uncommitted/);
    });

    it("should forward affectedIgnore and note the changed paths it skipped", async () => {
        expect.assertions(2);

        getAffectedProjectsMock.mockResolvedValueOnce({ ...emptyResult, ignoredFiles: ["api-snapshots/a.api.md", "README.md"] });

        const result = await selectAffectedProjects({ base: "HEAD~1", head: "HEAD", uncommitted: false }, workspace, {
            affectedIgnore: ["api-snapshots/**", "*.md"],
        });

        expect(getAffectedProjectsMock).toHaveBeenCalledWith(expect.objectContaining({ ignoredFiles: ["api-snapshots/**", "*.md"] }));
        expect(result.notes).toStrictEqual(["ignoring 2 changed path(s) outside any project matching affectedIgnore"]);
    });
});

describe("selectAffectedProjects external inputs", () => {
    it("defaults the external-input snapshot to the workspace cache directory", async () => {
        expect.assertions(1);

        const root = await mkdtemp(join(tmpdir(), "vis-affected-external-default-"));
        const externalDirectory = await mkdtemp(join(tmpdir(), "vis-affected-shared-default-"));
        const externalFile = join(externalDirectory, "shared.ts");

        await mkdir(join(root, "packages/api"), { recursive: true });
        await writeFile(externalFile, "export const shared = 1;\n");

        const externalProjects: Record<string, ProjectConfiguration> = {
            api: { root: "packages/api", targets: { build: { inputs: [`file://${externalFile}`] } } },
        };

        try {
            getAffectedProjectsMock.mockResolvedValueOnce({
                ...emptyResult,
                changedExternalInputs: [externalFile],
                changedProjects: ["api"],
                externalInputHashes: { [externalFile]: "hash-default" },
            });

            await selectAffectedProjects(
                { base: "HEAD", head: "HEAD", uncommitted: false },
                {
                    projectGraph,
                    projects: externalProjects,
                    workspaceRoot: root,
                },
            );

            const snapshotPath = join(root, "node_modules", ".cache", "vis", "external-inputs.json");

            expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toStrictEqual({ [externalFile]: "hash-default" });
        } finally {
            await rm(root, { force: true, recursive: true });
            await rm(externalDirectory, { force: true, recursive: true });
        }
    });

    it("does not advance the snapshot when persistence is deferred", async () => {
        expect.assertions(1);

        const root = await mkdtemp(join(tmpdir(), "vis-affected-external-deferred-"));
        const externalDirectory = await mkdtemp(join(tmpdir(), "vis-affected-shared-deferred-"));
        const externalFile = join(externalDirectory, "shared.ts");
        const statePath = join(root, "external-inputs.json");

        await mkdir(join(root, "packages/api"), { recursive: true });
        await writeFile(externalFile, "export const shared = 1;\n");

        const externalProjects: Record<string, ProjectConfiguration> = {
            api: { root: "packages/api", targets: { build: { inputs: [`file://${externalFile}`] } } },
        };

        try {
            getAffectedProjectsMock.mockResolvedValueOnce({
                ...emptyResult,
                changedExternalInputs: [externalFile],
                changedProjects: ["api"],
                externalInputHashes: { [externalFile]: "hash-deferred" },
            });

            await selectAffectedProjects(
                { base: "HEAD", head: "HEAD", uncommitted: false },
                { projectGraph, projects: externalProjects, workspaceRoot: root },
                { externalInputStatePath: statePath, persistExternalInputState: false },
            );

            await expect(readFile(statePath, "utf8")).rejects.toThrow(/ENOENT/);
        } finally {
            await rm(root, { force: true, recursive: true });
            await rm(externalDirectory, { force: true, recursive: true });
        }
    });

    it("ignores a snapshot that is not a plain object", async () => {
        expect.assertions(1);

        const root = await mkdtemp(join(tmpdir(), "vis-affected-external-shape-"));
        const externalDirectory = await mkdtemp(join(tmpdir(), "vis-affected-shared-shape-"));
        const externalFile = join(externalDirectory, "shared.ts");
        const statePath = join(root, "external-inputs.json");

        await mkdir(join(root, "packages/api"), { recursive: true });
        await writeFile(externalFile, "export const shared = 1;\n");
        await writeFile(statePath, "null");

        const externalProjects: Record<string, ProjectConfiguration> = {
            api: { root: "packages/api", targets: { build: { inputs: [`file://${externalFile}`] } } },
        };

        try {
            getAffectedProjectsMock.mockResolvedValueOnce({ ...emptyResult, externalInputHashes: {} });

            await selectAffectedProjects(
                { base: "HEAD", head: "HEAD", uncommitted: false },
                { projectGraph, projects: externalProjects, workspaceRoot: root },
                { externalInputStatePath: statePath, persistExternalInputState: false },
            );

            const call = getAffectedProjectsMock.mock.calls.at(-1)?.[0];

            expect(call.previousExternalInputHashes).toBeUndefined();
        } finally {
            await rm(root, { force: true, recursive: true });
            await rm(externalDirectory, { force: true, recursive: true });
        }
    });

    it("passes the shared external-input ownership map and persists its hashes", async () => {
        expect.assertions(6);

        const root = await mkdtemp(join(tmpdir(), "vis-affected-external-"));
        const externalDirectory = await mkdtemp(join(tmpdir(), "vis-affected-shared-"));
        const externalFile = join(externalDirectory, "shared.ts");
        const statePath = join(root, ".vis", "external-inputs.json");

        await mkdir(join(root, "packages/api"), { recursive: true });
        await writeFile(externalFile, "export const shared = 1;\n");

        const externalProjects: Record<string, ProjectConfiguration> = {
            api: { root: "packages/api", targets: { build: { inputs: [`file://${externalFile}`] } } },
        };

        try {
            getAffectedProjectsMock.mockResolvedValueOnce({
                ...emptyResult,
                changedExternalInputs: [externalFile],
                changedProjects: ["api"],
                externalInputHashes: { [externalFile]: "hash-1" },
            });

            const first = await selectAffectedProjects(
                { base: "HEAD", head: "HEAD", uncommitted: false },
                {
                    projectGraph,
                    projects: externalProjects,
                    workspaceRoot: root,
                },
                { externalInputStatePath: statePath },
            );

            const firstCall = getAffectedProjectsMock.mock.calls.at(-1)?.[0];

            expect(firstCall.externalInputs).toStrictEqual([{ pattern: externalFile, projects: ["api"] }]);
            expect(firstCall.previousExternalInputHashes).toBeUndefined();
            expect(first.changedProjects).toStrictEqual(["api"]);
            expect(JSON.parse(await readFile(statePath, "utf8"))).toStrictEqual({ [externalFile]: "hash-1" });

            getAffectedProjectsMock.mockResolvedValueOnce({
                ...emptyResult,
                changedExternalInputs: [],
                externalInputHashes: { [externalFile]: "hash-1" },
            });

            await selectAffectedProjects(
                { base: "HEAD", head: "HEAD", uncommitted: false },
                {
                    projectGraph,
                    projects: externalProjects,
                    workspaceRoot: root,
                },
                { externalInputStatePath: statePath },
            );

            const secondCall = getAffectedProjectsMock.mock.calls.at(-1)?.[0];

            expect(secondCall.previousExternalInputHashes).toStrictEqual({ [externalFile]: "hash-1" });
            expect(first.notes.join("\n")).toMatch(/changed external input/);
        } finally {
            await rm(root, { force: true, recursive: true });
            await rm(externalDirectory, { force: true, recursive: true });
        }
    });
});

describe("external input snapshot persistence", () => {
    it("writes the snapshot atomically and can invalidate it after a failure", async () => {
        expect.assertions(3);

        const root = await mkdtemp(join(tmpdir(), "vis-affected-snapshot-"));
        const statePath = join(root, "external-inputs.json");

        try {
            await persistExternalInputHashes(statePath, { pattern: "hash-1" });

            expect(JSON.parse(await readFile(statePath, "utf8"))).toStrictEqual({ pattern: "hash-1" });
            await expect(readFile(`${statePath}.${process.pid}.tmp`, "utf8")).rejects.toThrow(/ENOENT/);

            await invalidateExternalInputState(statePath);

            await expect(readFile(statePath, "utf8")).rejects.toThrow(/ENOENT/);
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});
