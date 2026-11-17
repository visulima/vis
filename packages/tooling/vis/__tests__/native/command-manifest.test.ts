import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Command } from "@visulima/cerebro";
import { createCerebro } from "@visulima/cerebro";
import { describe, expect, it } from "vitest";

import { buildManifest } from "../../scripts/generate-command-manifest";

const MANIFEST_PATH = resolve(__dirname, "../../native/cli/src/manifest.json");

interface ManifestCommand {
    commandPath?: string[];
    description: string;
    name: string;
    options?: { name: string }[];
}

const fullPath = (command: { commandPath?: string[]; name: string }): string => [...(command.commandPath ?? []), command.name].join(" ");

describe("native command manifest", () => {
    it("is up to date with the command definitions", async () => {
        expect.assertions(1);

        expect(readFileSync(MANIFEST_PATH, "utf8")).toBe(await buildManifest());
    });

    it("lists every command registered in register-commands.ts, with the same description and options", async () => {
        expect.assertions(3);

        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { commands: ManifestCommand[] };
        const cli = createCerebro("vis", { packageName: "vis", packageVersion: "0.0.0-test" });

        // Imported lazily: loading the real command graph needs the workspace builds,
        // which the manifest-equality test above deliberately does not.
        const { default: registerCommands } = await import("../../src/register-commands");

        registerCommands(cli);

        const registered = [...new Set(cli.getCommands().values())] as Command[];
        const byPath = new Map(manifest.commands.map((command) => [fullPath(command), command]));

        const missing = registered.map((command) => fullPath(command)).filter((path) => !byPath.has(path));

        expect(missing).toStrictEqual([]);

        const descriptionDrift = registered.filter((command) => byPath.get(fullPath(command))?.description !== (command.description ?? "")).map((command) => fullPath(command));

        expect(descriptionDrift).toStrictEqual([]);

        const optionDrift = registered
            .filter((command) => {
                const recorded = (byPath.get(fullPath(command))?.options ?? []).map((option) => option.name);
                const live = ((command.options ?? []) as { name: string }[]).map((option) => option.name);

                return recorded.join(",") !== live.join(",");
            })
            .map((command) => fullPath(command));

        expect(optionDrift).toStrictEqual([]);
    });
});
