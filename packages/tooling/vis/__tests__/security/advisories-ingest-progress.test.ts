import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { advisoriesIngest } from "#native";

// An archive with no entries: the end-of-central-directory record alone.
const EMPTY_ZIP = Buffer.concat([Buffer.from([0x50, 0x4B, 0x05, 0x06]), Buffer.alloc(18)]);

describe(advisoriesIngest, () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "vis-ingest-progress-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("calls onProgress with (current, total) numbers, not an error-first pair", async () => {
        expect.hasAssertions();

        const zipPath = join(directory, "npm.zip");

        writeFileSync(zipPath, EMPTY_ZIP);

        const onProgress = vi.fn<(current: number, total: number) => void>();

        await advisoriesIngest({ dbPath: join(directory, "db.sqlite"), ecosystem: "npm", zipPath }, onProgress);
        // The native side queues the call without blocking, so wait for the event loop to deliver it.
        await vi.waitFor(() => {
            expect(onProgress).toHaveBeenCalledWith(0, 0);
        });

        expect(onProgress).toHaveBeenCalledTimes(1);
    });

    it("leaves the zip on disk for the caller to remove", async () => {
        expect.assertions(1);

        const zipPath = join(directory, "npm.zip");

        writeFileSync(zipPath, EMPTY_ZIP);

        await advisoriesIngest({ dbPath: join(directory, "db.sqlite"), ecosystem: "npm", zipPath }, () => {});

        expect(() => { rmSync(zipPath); }).not.toThrow();
    });
});
