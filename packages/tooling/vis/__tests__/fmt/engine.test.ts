import { describe, expect, it } from "vitest";

import { selectFmtEngine } from "../../src/fmt/engine";
import type { FmtEngine } from "../../src/fmt/options";
import type { FmtAdapterId } from "../../src/lint-fmt/config-types";

const select = (input: { builtin?: boolean; detected?: FmtAdapterId[]; engine?: FmtEngine; oxfmtEnabled?: boolean }) =>
    selectFmtEngine({ detected: [], oxfmtEnabled: true, ...input });

describe(selectFmtEngine, () => {
    it.each<[string, FmtAdapterId[]]>([
        ["nothing detected", []],
        ["only prettier", ["prettier"]],
        ["only oxfmt", ["oxfmt"]],
        ["prettier and oxfmt", ["oxfmt", "prettier"]],
    ])("runs the bundled oxfmt on auto when %s", (_name, detected) => {
        expect.assertions(1);

        expect(select({ detected })).toBe("bundled");
    });

    it.each<FmtAdapterId>(["biome", "dprint", "ruff-fmt"])("keeps the adapters on auto when %s is detected, even next to prettier or oxfmt", (other) => {
        expect.assertions(2);

        expect(select({ detected: [other] })).toBe("adapters");
        expect(select({ detected: ["oxfmt", "prettier", other] })).toBe("adapters");
    });

    it("keeps the adapters for engine prettier, whatever is detected", () => {
        expect.assertions(2);

        expect(select({ detected: [], engine: "prettier" })).toBe("adapters");
        expect(select({ detected: ["oxfmt"], engine: "prettier" })).toBe("adapters");
    });

    it("keeps the adapters when adapters.oxfmt.builtin is false", () => {
        expect.assertions(2);

        expect(select({ builtin: false, detected: ["oxfmt"] })).toBe("adapters");
        expect(select({ builtin: false, engine: "auto" })).toBe("adapters");
    });

    it("rejects engine oxfmt together with adapters.oxfmt.builtin: false instead of running the adapters", () => {
        expect.assertions(2);

        expect(() => select({ builtin: false, detected: ["biome"], engine: "oxfmt" })).toThrow(/builtin: false.*contradict/);
        expect(() => select({ builtin: false, engine: "oxfmt", oxfmtEnabled: false })).toThrow(/contradict/);
    });

    it("always runs the bundled oxfmt for engine oxfmt, even when biome is detected", () => {
        expect.assertions(1);

        expect(select({ detected: ["biome", "prettier"], engine: "oxfmt" })).toBe("bundled");
    });

    it("treats builtin: true like the default", () => {
        expect.assertions(1);

        expect(select({ builtin: true })).toBe("bundled");
    });

    it("turns the bundled oxfmt off with adapters.oxfmt.enabled: false", () => {
        expect.assertions(2);

        expect(select({ detected: ["prettier"], oxfmtEnabled: false })).toBe("adapters");
        expect(select({ oxfmtEnabled: false })).toBe("adapters");
    });

    it("rejects engine oxfmt together with adapters.oxfmt.enabled: false", () => {
        expect.assertions(1);

        expect(() => select({ engine: "oxfmt", oxfmtEnabled: false })).toThrow(/contradict/);
    });
});
