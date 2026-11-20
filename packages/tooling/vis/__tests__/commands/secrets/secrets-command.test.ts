import { describe, expect, it } from "vitest";

import secretsCommand from "../../../src/commands/secrets";
import { resolveScanOptions } from "../../../src/commands/secrets/flags";

describe("secrets command", () => {
    it("declares its name", () => {
        expect.assertions(1);
        expect(secretsCommand.name).toBe("secrets");
    });

    it("is grouped under Security", () => {
        expect.assertions(1);
        expect(secretsCommand.group).toBe("Security");
    });

    it("accepts paths as a variadic argument", () => {
        expect.assertions(2);
        expect(secretsCommand.argument?.name).toBe("paths");
        expect(secretsCommand.argument?.type).toBe(String);
    });

    it("exposes the expected flags", () => {
        expect.assertions(1);

        // Options are declared as a record keyed by name.
        const names = Object.keys(secretsCommand.options ?? {});

        expect(names).toStrictEqual(
            expect.arrayContaining([
                "config",
                "format",
                "baseline",
                "redact",
                "secretlintignore",
                "no-secretlintignore",
                "include-hidden",
                "no-gitignore",
                "max-size",
                "stdin",
                "update-baseline",
            ]),
        );
    });

    it("resolves --secretlintignore and --no-secretlintignore", () => {
        expect.assertions(3);

        expect(resolveScanOptions({ secretlintignore: ["extra.ignore"] }, undefined, "/repo").secretlintIgnore).toStrictEqual(["/repo/extra.ignore"]);
        expect(resolveScanOptions({ secretlintignore: false }, { secretlintIgnore: ["config.ignore"] }, "/repo").secretlintIgnore).toBe(false);
        expect(resolveScanOptions({}, { secretlintIgnore: ["config.ignore"] }, "/repo").secretlintIgnore).toStrictEqual(["/repo/config.ignore"]);
    });

    it("provides usage examples", () => {
        expect.assertions(1);

        expect((secretsCommand.examples ?? []).length).toBeGreaterThan(0);
    });
});
