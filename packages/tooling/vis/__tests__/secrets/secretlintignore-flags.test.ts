import { createCerebro } from "@visulima/cerebro";
import type { ScanOptions } from "@visulima/secret-scanner";
import { describe, expect, it, vi } from "vitest";

import secretsCommand from "../../src/commands/secrets";
import type { SecretsFlags } from "../../src/commands/secrets/flags";
import { resolveScanOptions } from "../../src/commands/secrets/flags";

// Runs the real `secrets` option definitions through cerebro's parser and
// returns the flags the handler would receive.
const parseFlags = async (...argv: string[]): Promise<SecretsFlags> => {
    let parsed: SecretsFlags = {};
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), raw: vi.fn(), warn: vi.fn() };
    const cli = createCerebro("vis", { argv: ["secrets", ...argv], logger: logger as unknown as Console, packageName: "vis", packageVersion: "0.0.0-test" });

    cli.addCommand({
        execute: ({ options }) => {
            parsed = options;
        },
        name: "secrets",
        options: secretsCommand.options,
    });

    await cli.run({ shouldExitProcess: false });

    return parsed;
};

const secretlintIgnoreFor = async (...argv: string[]): Promise<ScanOptions["secretlintIgnore"]> => {
    const flags = await parseFlags(...argv);

    return resolveScanOptions(flags, undefined, "/repo").secretlintIgnore;
};

describe("secretlintignore flags through the cerebro parser", () => {
    it("leaves discovery on when neither flag is given", async () => {
        expect.assertions(2);

        await expect(secretlintIgnoreFor()).resolves.toBeUndefined();
        await expect(secretlintIgnoreFor("--exclude", "dist/")).resolves.toBeUndefined();
    });

    it("keeps explicit --secretlintignore paths, repeatable", async () => {
        expect.assertions(2);

        await expect(secretlintIgnoreFor("--secretlintignore", "a.ignore")).resolves.toStrictEqual(["/repo/a.ignore"]);
        await expect(secretlintIgnoreFor("--secretlintignore", "a.ignore", "--secretlintignore", "b.ignore")).resolves.toStrictEqual([
            "/repo/a.ignore",
            "/repo/b.ignore",
        ]);
    });

    it("disables discovery with --no-secretlintignore", async () => {
        expect.assertions(1);

        await expect(secretlintIgnoreFor("--no-secretlintignore")).resolves.toBe(false);
    });

    it("applies only the CLI files when config turns discovery off", async () => {
        expect.assertions(4);

        const flags = await parseFlags("--secretlintignore", "a.ignore");
        const options = resolveScanOptions(flags, { secretlintIgnore: false }, "/repo");

        expect(options.secretlintIgnore).toBe(false);
        expect(options.walk?.excludeFromFiles).toStrictEqual(["/repo/a.ignore"]);

        const withExcludeFrom = resolveScanOptions(
            await parseFlags("--secretlintignore", "a.ignore", "--exclude-from", "x.ignore"),
            { secretlintIgnore: false },
            "/repo",
        );

        expect(withExcludeFrom.walk?.excludeFromFiles).toStrictEqual(["/repo/x.ignore", "/repo/a.ignore"]);

        const disabled = resolveScanOptions(await parseFlags("--no-secretlintignore"), { secretlintIgnore: false }, "/repo");

        expect(disabled.walk?.excludeFromFiles).toBeUndefined();
    });
});
