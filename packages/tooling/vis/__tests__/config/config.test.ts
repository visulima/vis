import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { join } from "@visulima/path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyDefaults, CONFIG_FILES, defineConfig, findVisConfigFile, loadVisConfig, SECURITY_DEFAULTS } from "../../src/config/config";

describe(defineConfig, () => {
    it("should return the input config unchanged (typed-identity)", () => {
        expect.assertions(2);

        const input = { security: { blockExoticSubdeps: false } };
        const config = defineConfig(input);

        expect(config).toBe(input);
        expect(config.security?.blockExoticSubdeps).toBe(false);
    });
});

describe(applyDefaults, () => {
    it("should apply secure defaults to empty config", () => {
        expect.assertions(7);

        const config = applyDefaults({});

        expect(config.security?.policies?.firstSeen?.minutes).toBeUndefined();
        expect(config.security?.policies?.publisherChange?.mode).toBe("no-downgrade");
        expect(config.security?.policies?.publisherChange?.ignoreAfter).toBe(SECURITY_DEFAULTS.policies?.publisherChange?.ignoreAfter);
        expect(config.security?.blockExoticSubdeps).toBe(true);
        expect(config.security?.policies?.installScripts?.strict).toBe(true);
        expect(config.update?.security).toBe(true);
        expect(config.update?.target).toBe("minor");
    });

    it("should preserve user overrides over defaults", () => {
        expect.assertions(3);

        const config = applyDefaults({
            security: {
                policies: {
                    firstSeen: { minutes: 1440 },
                    installScripts: { strict: false },
                },
            },
            update: { target: "patch" },
        });

        expect(config.security?.policies?.firstSeen?.minutes).toBe(1440);
        expect(config.security?.policies?.installScripts?.strict).toBe(false);
        expect(config.update?.target).toBe("patch");
    });

    it("should merge user installScripts.allow with defaults", () => {
        expect.assertions(2);

        const config = applyDefaults({
            security: {
                policies: {
                    installScripts: { allow: { esbuild: true } },
                },
            },
        });

        expect(config.security?.policies?.installScripts?.allow).toStrictEqual({ esbuild: true });
        expect(config.security?.policies?.publisherChange?.mode).toBe("no-downgrade");
    });

    it("should support all config sections", () => {
        expect.assertions(2);

        const config = applyDefaults({
            ai: { priority: { claude: 100 }, provider: "claude" },
            update: { exclude: ["@types/*"], format: "json", install: false, prerelease: true, security: true, target: "patch" },
        });

        expect(config.ai?.provider).toBe("claude");
        expect(config.update?.target).toBe("patch");
    });

    it("should allow user to explicitly disable a default", () => {
        expect.assertions(2);

        const config = applyDefaults({
            security: {
                blockExoticSubdeps: false,
                policies: { publisherChange: { mode: "off" } },
            },
        });

        expect(config.security?.blockExoticSubdeps).toBe(false);
        expect(config.security?.policies?.publisherChange?.mode).toBe("off");
    });
});

describe("cONFIG_FILES", () => {
    it("should list all supported extensions", () => {
        expect.assertions(6);

        expect(CONFIG_FILES).toContain("vis.config.ts");
        expect(CONFIG_FILES).toContain("vis.config.js");
        expect(CONFIG_FILES).toContain("vis.config.mjs");
        expect(CONFIG_FILES).toContain("vis.config.cjs");
        expect(CONFIG_FILES).toContain("vis.config.mts");
        expect(CONFIG_FILES).toContain("vis.config.cts");
    });

    it("should check .ts first", () => {
        expect.assertions(1);

        expect(CONFIG_FILES[0]).toBe("vis.config.ts");
    });
});

describe(findVisConfigFile, () => {
    it("should find vis.config.ts", () => {
        expect.assertions(1);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));

        writeFileSync(join(temporaryDirectory, "vis.config.ts"), "export default {};");

        expect(findVisConfigFile(temporaryDirectory)).toBe(join(temporaryDirectory, "vis.config.ts"));
    });

    it("should find vis.config.js", () => {
        expect.assertions(1);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));

        writeFileSync(join(temporaryDirectory, "vis.config.js"), "module.exports = {};");

        expect(findVisConfigFile(temporaryDirectory)).toBe(join(temporaryDirectory, "vis.config.js"));
    });

    it("should prefer .ts over .js", () => {
        expect.assertions(1);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));

        writeFileSync(join(temporaryDirectory, "vis.config.ts"), "export default {};");
        writeFileSync(join(temporaryDirectory, "vis.config.js"), "module.exports = {};");

        expect(findVisConfigFile(temporaryDirectory)).toBe(join(temporaryDirectory, "vis.config.ts"));
    });

    it("should return undefined when no config found", () => {
        expect.assertions(1);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));

        expect(findVisConfigFile(temporaryDirectory)).toBeUndefined();
    });
});

describe(loadVisConfig, () => {
    it("should return secure defaults when no file exists", async () => {
        expect.assertions(3);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));
        const config = await loadVisConfig(temporaryDirectory);

        expect(config.security?.policies?.firstSeen?.minutes).toBeUndefined();
        expect(config.security?.policies?.publisherChange?.mode).toBe("no-downgrade");
        expect(config.security?.blockExoticSubdeps).toBe(true);
    });

    it("should load a JavaScript config file and apply defaults", async () => {
        expect.assertions(2);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));

        writeFileSync(join(temporaryDirectory, "vis.config.mjs"), "export default { update: { target: \"minor\" } };");

        const config = await loadVisConfig(temporaryDirectory);

        expect(config.update?.target).toBe("minor");
        expect(config.security?.policies?.publisherChange?.mode).toBe("no-downgrade");
    });

    it("should load a TypeScript config file and apply defaults", async () => {
        expect.assertions(2);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));

        writeFileSync(
            join(temporaryDirectory, "vis.config.ts"),
            `
interface Config { update?: { target?: string } }
const config: Config = { update: { target: "patch" } };
export default config;
`,
        );

        const config = await loadVisConfig(temporaryDirectory);

        expect(config.update?.target).toBe("patch");
        expect(config.security?.blockExoticSubdeps).toBe(true);
    });

    it("should support function-based config", async () => {
        expect.assertions(1);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));

        writeFileSync(join(temporaryDirectory, "vis.config.mjs"), "export default () => ({ update: { security: true } });");

        const config = await loadVisConfig(temporaryDirectory);

        expect(config.update?.security).toBe(true);
    });

    it("should support async function-based config", async () => {
        expect.assertions(1);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));

        writeFileSync(join(temporaryDirectory, "vis.config.mjs"), "export default async () => ({ ai: { provider: \"gemini\" } });");

        const config = await loadVisConfig(temporaryDirectory);

        expect(config.ai?.provider).toBe("gemini");
    });

    it("should load CJS config file", async () => {
        expect.assertions(1);

        const temporaryDirectory = mkdtempSync(join(tmpdir(), "vis-test-"));

        writeFileSync(join(temporaryDirectory, "vis.config.cjs"), "module.exports = { update: { format: \"json\" } };");

        const config = await loadVisConfig(temporaryDirectory);

        expect(config.update?.format).toBe("json");
    });
});

describe("config loading (no stale cache)", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "vis-config-test-"));
        mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { force: true, recursive: true });
    });

    it("should keep plugin functions on repeated loads", async () => {
        expect.assertions(4);

        writeFileSync(join(tmpDir, "vis.config.ts"), "export default { plugins: [{ name: \"marker\", hooks: { \"task:before\": () => {} }, setup: () => {} }] };");

        const first = await loadVisConfig(tmpDir);

        expect(first.plugins?.[0]?.setup).toBeTypeOf("function");
        expect(first.plugins?.[0]?.hooks?.["task:before"]).toBeTypeOf("function");

        const second = await loadVisConfig(tmpDir);

        expect(second.plugins?.[0]?.setup).toBeTypeOf("function");
        expect(second.plugins?.[0]?.hooks?.["task:before"]).toBeTypeOf("function");
    });

    it("should reflect env var changes on repeated loads", async () => {
        expect.assertions(2);

        writeFileSync(join(tmpDir, "vis.config.ts"), "export default { tasks: { build: { cache: process.env.VIS_TEST_FLAG === \"on\" } } };");

        const originalValue = process.env.VIS_TEST_FLAG;

        try {
            process.env.VIS_TEST_FLAG = "off";

            const off = await loadVisConfig(tmpDir);

            expect(off.tasks?.build?.cache).toBe(false);

            process.env.VIS_TEST_FLAG = "on";

            const on = await loadVisConfig(tmpDir);

            expect(on.tasks?.build?.cache).toBe(true);
        } finally {
            if (originalValue === undefined) {
                delete process.env.VIS_TEST_FLAG;
            } else {
                process.env.VIS_TEST_FLAG = originalValue;
            }
        }
    });

    it("should pick up edits to the config file on reload", async () => {
        expect.assertions(2);

        writeFileSync(join(tmpDir, "vis.config.ts"), "export default { update: { target: \"patch\" } };");

        const first = await loadVisConfig(tmpDir);

        expect(first.update?.target).toBe("patch");

        writeFileSync(join(tmpDir, "vis.config.ts"), "export default { update: { target: \"latest\" } };");

        const second = await loadVisConfig(tmpDir);

        expect(second.update?.target).toBe("latest");
    });
});
