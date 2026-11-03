import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeBaseline } from "../src/baseline";

// Spy on the real fs calls so the test can check their order.
vi.mock(import("node:fs/promises"), async (importOriginal) => {
    const original = await importOriginal();

    return { ...original, chmod: vi.fn<typeof original.chmod>(original.chmod), writeFile: vi.fn<typeof original.writeFile>(original.writeFile) };
});

const permissions = async (path: string): Promise<number> => {
    const stats = await stat(path);

    return stats.mode % 0o1000;
};

let tmp: string;

beforeEach(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), "secret-scanner-baseline-write-"));
});

afterEach(async () => {
    vi.clearAllMocks();
    await rm(tmp, { force: true, recursive: true });
});

describe(writeBaseline, () => {
    it("restricts an existing world-readable file before writing secrets into it", async () => {
        expect.assertions(3);

        const path = resolve(tmp, "baseline.json");

        await writeFile(path, "[]\n", { mode: 0o644 });
        await chmod(path, 0o644);
        vi.clearAllMocks();

        await writeBaseline(path, []);

        const chmodOrder = vi.mocked(chmod).mock.invocationCallOrder;
        const writeOrder = vi.mocked(writeFile).mock.invocationCallOrder;

        expect(writeOrder).toHaveLength(1);
        expect(Math.min(...chmodOrder)).toBeLessThan(writeOrder[0]!);
        await expect(permissions(path)).resolves.toBe(0o600);
    });

    it("creates a new file owner-only", async () => {
        expect.assertions(1);

        const path = resolve(tmp, "new.json");

        await writeBaseline(path, []);

        await expect(permissions(path)).resolves.toBe(0o600);
    });
});
