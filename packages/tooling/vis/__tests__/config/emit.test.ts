import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { schemaOutputPath, SCHEMAS } from "../../scripts/generate-schemas";
import { emitConfig } from "../../src/config/emit";

// Which modules a config imports is tracked by the loader hook, which vitest's own module runner
// bypasses; that part is covered against the built CLI in `__tests__/native/config-cache.test.ts`.
describe(emitConfig, () => {
    let scratch: string;

    beforeEach(() => {
        scratch = mkdtempSync(join(realpathSync(tmpdir()), "vis-emit-"));
        mkdirSync(join(scratch, "node_modules"), { recursive: true });
        writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "fixture-root", private: true }));
    });

    afterEach(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    const write = (name: string, body: string): string => {
        const path = join(scratch, name);

        writeFileSync(path, body);

        return path;
    };

    it("emits the merged user config without the secure defaults", async () => {
        expect.assertions(3);

        write("base.ts", `export default { install: { backend: "pnpm" }, tasks: { build: { cache: true } } };\n`);

        const emitted = await emitConfig(write("vis.config.ts", `export default { extends: "./base.ts", tasks: { test: { cache: false } } };\n`));

        expect(emitted.status).toBe("ok");
        expect(emitted.config).toStrictEqual({
            install: { backend: "pnpm" },
            tasks: { build: { cache: true }, test: { cache: false } },
        });
        expect(emitted.uncacheable).toStrictEqual([]);
    });

    it("emits a config that validates against the published schema", async () => {
        expect.assertions(2);

        const schema = JSON.parse(readFileSync(schemaOutputPath(SCHEMAS[0]), "utf8")) as object;
        const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

        write("base.ts", `export default { fileGroups: { src: ["src/**"] }, install: { backend: "pnpm" } };\n`);

        const emitted = await emitConfig(
            write("vis.config.ts", `export default { extends: "./base.ts", tasks: { build: { cache: true } }, update: { target: "minor" } };\n`),
        );

        expect(emitted.status).toBe("ok");
        expect(validate(emitted.config), JSON.stringify(validate.errors)).toBe(true);
    });

    it("marks a config that globs as not reusable", async () => {
        expect.assertions(1);

        const emitted = await emitConfig(
            write("vis.config.ts", `import { globSync } from "node:fs";\nglobSync("*.json", { cwd: ${JSON.stringify(scratch)} });\nexport default {};\n`),
        );

        expect(emitted.uncacheable).toContain("reads files in a way that cannot be tracked");
    });

    it("lists the environment variables a config reads", async () => {
        expect.assertions(3);

        process.env["VIS_EMIT_TEST_BACKEND"] = "bun";

        try {
            const emitted = await emitConfig(
                write("vis.config.ts", `export default { install: { backend: process.env.VIS_EMIT_TEST_BACKEND } };\n`),
            );

            expect(emitted.config).toStrictEqual({ install: { backend: "bun" } });
            expect(emitted.env).toContain("VIS_EMIT_TEST_BACKEND");
            expect(emitted.uncacheable).toStrictEqual([]);
        } finally {
            delete process.env["VIS_EMIT_TEST_BACKEND"];
        }
    });

    it("lists the files and directories a config reads while it runs", async () => {
        expect.assertions(3);

        write("data.txt", "x");

        const emitted = await emitConfig(
            write(
                "vis.config.ts",
                `import { readFileSync, readdirSync } from "node:fs";\n`
                + `const names = readdirSync(${JSON.stringify(scratch)});\n`
                + `export default { install: { backend: readFileSync(${JSON.stringify(join(scratch, "data.txt"))}, "utf8") === "x" && names.length > 0 ? "npm" : "pnpm" } };\n`,
            ),
        );

        expect(emitted.config).toStrictEqual({ install: { backend: "npm" } });
        expect(emitted.files.find((file) => file.path.endsWith("data.txt"))?.kind).toBe("file");
        expect(emitted.files.find((file) => file.path === scratch)?.kind).toBe("dir");
    });

    it("reports values that are not data and leaves the config out", async () => {
        expect.assertions(3);

        const emitted = await emitConfig(
            write("vis.config.ts", `export default { install: { backend: "npm" }, plugins: [{ name: "p", hooks: { x() {} } }] };\n`),
        );

        expect(emitted.status).toBe("node-only");
        expect(emitted.config).toBeUndefined();
        expect(emitted.nonData).toStrictEqual(["$.plugins[0].hooks.x"]);
    });

    it("marks a config that starts a process or prints output as not reusable", async () => {
        expect.assertions(2);

        const emitted = await emitConfig(
            write(
                "vis.config.ts",
                `import { execSync } from "node:child_process";\nexecSync("true");\nprocess.stderr.write("");\nexport default {};\n`,
            ),
        );

        expect(emitted.uncacheable).toContain("starts a process");
        expect(emitted.uncacheable).toContain("prints output");
    });

    it("restores the process after the config has been evaluated", async () => {
        expect.assertions(2);

        const { env } = process;

        await emitConfig(write("vis.config.ts", `export default {};\n`));

        expect(process.env).toBe(env);
        expect(Object.keys(process.env).length).toBeGreaterThan(0);
    });

    it("fails like the loader does when the config throws", async () => {
        expect.assertions(1);

        await expect(emitConfig(write("vis.config.ts", `throw new Error("boom");\nexport default {};\n`))).rejects.toThrow(/boom/u);
    });
});
