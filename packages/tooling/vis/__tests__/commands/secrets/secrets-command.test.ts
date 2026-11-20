import { createCerebro } from "@visulima/cerebro";
import { describe, expect, it } from "vitest";

import secretsCommand from "../../../src/commands/secrets";

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
            expect.arrayContaining(["config", "format", "baseline", "redact", "no-redact", "include-hidden", "no-gitignore", "max-size", "update-baseline"]),
        );
    });

    it("provides usage examples", () => {
        expect.assertions(1);

        expect((secretsCommand.examples ?? []).length).toBeGreaterThan(0);
    });

    it("parses --no-redact as false, --redact as true and leaves redact unset by default", async () => {
        expect.assertions(1);

        const seen: unknown[] = [];

        for (const argv of [[], ["--no-redact"], ["--redact"]]) {
            const cli = createCerebro("vis-test", { argv: ["secrets", ...argv] });

            cli.addCommand({
                ...secretsCommand,
                execute: ({ options }: { options: { redact?: boolean } }) => {
                    seen.push(options.redact);
                },
                loader: undefined,
            });

            await cli.run({ shouldExitProcess: false });
        }

        expect(seen).toStrictEqual([undefined, false, true]);
    });
});
