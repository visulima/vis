import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateGitleaks } from "../../../src/commands/migrate/gitleaks";
import { createMigrationReport } from "../../../src/commands/migrate/types";
import { cleanupTemporaryDirectory, createMockLogger, createTemporaryDirectory } from "../../test-helpers";

describe("migrate-gitleaks-ignore", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = createTemporaryDirectory("vis-migrate-gl-ignore-");
    });

    afterEach(() => {
        cleanupTemporaryDirectory(tmpDir);
    });

    describe(".gitleaksignore", () => {
        it("keeps the ignore file untouched because vis secrets reads it directly", () => {
            expect.assertions(3);

            const content = ["# skip known leaks", "src/app.env:aws-access-token:42", "secret:not-a-real-token", "src/gen/*:generic-api-key:*", ""].join("\n");

            writeFileSync(join(tmpDir, ".gitleaksignore"), content);

            const logger = createMockLogger();

            migrateGitleaks(tmpDir, { dryRun: false }, logger, createMigrationReport());

            expect(readFileSync(join(tmpDir, ".gitleaksignore"), "utf8")).toBe(content);
            expect(existsSync(join(tmpDir, ".secrets-baseline.json"))).toBe(false);
            expect(logger.infoMessages.some((message) => message.includes("reads it directly"))).toBe(true);
        });
    });
});
