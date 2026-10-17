import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lint = vi.hoisted(() => vi.fn());
const fmt = vi.hoisted(() => vi.fn());

vi.mock(import("../../../src/commands/lint/handler"), () => { return { default: lint }; });
vi.mock(import("../../../src/commands/fmt/handler"), () => { return { default: fmt }; });

const { default: checkExecute } = await import("../../../src/commands/check/handler");

let root: string;

const toolbox = (options: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({
        argument: [],
        fs: { access },
        logger: { info: vi.fn(), warn: vi.fn() },
        options: { fix: false, since: undefined, staged: false, ...options },
        visConfig: undefined,
        workspaceRoot: root,
        ...extra,
    }) as never;

const writeTypeScriptWorkspace = async (): Promise<void> => {
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.0.0" } }));
    await writeFile(join(root, "tsconfig.json"), "{}");
};

describe("vis check", () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "vis-check-gate-"));
        lint.mockReset();
        fmt.mockReset();
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    it("enables the type check when TypeScript is detected", async () => {
        expect.assertions(1);

        await writeTypeScriptWorkspace();
        await checkExecute(toolbox({}));

        expect(lint.mock.calls[0][0].visConfig.lint.adapters.typecheck.enabled).toBe(true);
    });

    it("leaves the type check off when TypeScript is not detected", async () => {
        expect.assertions(1);

        await checkExecute(toolbox({}));

        expect(lint.mock.calls[0][0].visConfig.lint.adapters.typecheck.enabled).toBe(false);
    });

    it("respects an explicit typecheck opt-out in config", async () => {
        expect.assertions(1);

        await writeTypeScriptWorkspace();
        await checkExecute(toolbox({}, { visConfig: { lint: { adapters: { typecheck: { enabled: false } } } } }));

        expect(lint.mock.calls[0][0].visConfig.lint.adapters.typecheck.enabled).toBe(false);
    });

    it("runs fmt in check mode by default and in fix mode with --fix", async () => {
        expect.assertions(3);

        await checkExecute(toolbox({}));
        await checkExecute(toolbox({ fix: true }));

        expect(fmt.mock.calls[0][0].options.check).toBe(true);
        expect(fmt.mock.calls[1][0].options.check).toBe(false);
        expect(lint.mock.calls[1][0].options.fix).toBe(true);
    });

    it("forwards file arguments and git scope to both tools", async () => {
        expect.assertions(2);

        await mkdir(join(root, "src"));
        await writeFile(join(root, "src", "foo.ts"), "");
        await checkExecute(toolbox({ staged: true }, { argument: ["src/foo.ts"] }));

        expect(lint.mock.calls[0][0].options).toMatchObject({ _: ["src/foo.ts"], staged: true });
        expect(fmt.mock.calls[0][0].options).toMatchObject({ _: ["src/foo.ts"], staged: true });
    });

    it("rejects a dependency name passed as a path, pointing at vis outdated", async () => {
        expect.assertions(2);

        const run = checkExecute(toolbox({}, { argument: ["react"] }));

        await expect(run).rejects.toThrow("Dependency checks moved to `vis outdated`.");
        expect(lint).not.toHaveBeenCalled();
    });
});
