import { describe, expect, it, vi } from "vitest";

import { chooseTool, installDevDependency } from "../../src/util/tool-choice";

const choices = [
    { hint: "vis add -D vitest", label: "Vitest", value: "vitest" },
    { hint: "vis add -D @rstest/core", label: "Rstest", value: "@rstest/core" },
];

const answer = (text: string) => vi.fn(async () => text);

describe(chooseTool, () => {
    it("returns the option picked by number", async () => {
        expect.assertions(2);

        await expect(chooseTool("Pick", choices, { isInteractive: () => true, readline: answer("1") })).resolves.toStrictEqual(choices[0]);
        await expect(chooseTool("Pick", choices, { isInteractive: () => true, readline: answer(" 2 ") })).resolves.toStrictEqual(choices[1]);
    });

    it("cancels on empty input, q, or a number out of range", async () => {
        expect.assertions(4);

        await expect(chooseTool("Pick", choices, { isInteractive: () => true, readline: answer("") })).resolves.toBeUndefined();
        await expect(chooseTool("Pick", choices, { isInteractive: () => true, readline: answer("Q") })).resolves.toBeUndefined();
        await expect(chooseTool("Pick", choices, { isInteractive: () => true, readline: answer("9") })).resolves.toBeUndefined();
        await expect(chooseTool("Pick", choices, { isInteractive: () => true, readline: answer("vitest") })).resolves.toBeUndefined();
    });

    it("throws outside an interactive terminal, without reading input", async () => {
        expect.assertions(3);

        const readline = vi.fn(async () => "1");

        await expect(chooseTool("No runner.", choices, { isInteractive: () => false, readline })).rejects.toThrow("vis add -D vitest");
        await expect(chooseTool("No runner.", choices, { isInteractive: () => false, readline })).rejects.toThrow("vis add -D @rstest/core");
        expect(readline).not.toHaveBeenCalled();
    });
});

describe(installDevDependency, () => {
    it("installs through the given installer and reports its exit code", () => {
        expect.assertions(3);

        const install = vi.fn(() => 0);
        const logger = { info: vi.fn() };

        expect(installDevDependency("vitest", "/tmp/app", logger, install)).toBe(0);
        expect(install).toHaveBeenCalledWith("vitest", "/tmp/app");
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("vitest"));
    });
});
