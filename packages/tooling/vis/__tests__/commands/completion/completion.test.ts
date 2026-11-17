import type { Toolbox } from "@visulima/cerebro";
import { afterEach, describe, expect, it, vi } from "vitest";

import completion from "../../../src/commands/completion/completion-command";
import { isUserError } from "../../../src/errors/vis-user-error";

const generate = async (shell: string): Promise<string> => {
    const chunks: string[] = [];

    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
        chunks.push(parts.join(" "));
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));

        return true;
    });

    await completion.execute?.({
        env: {},
        logger: console,
        options: { shell },
        runtime: { getCliName: () => "vis" },
    } as unknown as Toolbox);

    return chunks.join("\n");
};

describe("completion command", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each(["bash", "zsh", "fish", "powershell"])("generates a %s script that calls the bare vis binary", async (shell) => {
        expect.assertions(2);

        const script = await generate(shell);

        // PowerShell quotes the separator (`& vis complete '--'`).
        expect(script).toMatch(/vis complete '?--/);
        expect(script).not.toContain("node vis");
    });

    it("rejects an unknown shell with a user error instead of a stack trace", async () => {
        expect.assertions(2);

        const failure = await generate("nushell").catch((error: unknown) => error);

        expect(isUserError(failure)).toBe(true);
        expect((failure as Error).message).toContain("Invalid shell type: nushell");
    });

    it("keeps cerebro's name and options so the manifest and help are unchanged", () => {
        expect.assertions(2);

        expect(completion.name).toBe("completion");
        expect(completion.options?.map((option) => option.name)).toStrictEqual(["shell", "runtime"]);
    });
});
