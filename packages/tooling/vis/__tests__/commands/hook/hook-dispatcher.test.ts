import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { installHooks } from "../../../src/commands/hook/install";
import { stageScriptBody } from "../../../src/commands/hook/prek";
import { nativeTarget } from "../../../src/util/native-target";
import { createTemporaryGitRepo } from "./hook-test-helpers";

describe.skipIf(process.platform === "win32")("generated dispatcher (behaviour)", () => {
    const STOCK_STAGE = stageScriptBody;

    /** A repo with the dispatcher installed, a stage script, and (optionally) a fake native binary that logs its argv + env. */
    const target = nativeTarget();

    const setup = (options: { binary?: "binding" | "other-binding" | "package" | false; stage?: string; stageBody?: string } = {}): { cleanup: () => void; log: string; root: string } => {
        const { cleanup, root } = createTemporaryGitRepo();
        const stage = options.stage ?? "pre-commit";

        installHooks(".vis/hooks");
        writeFileSync(join(root, ".vis/hooks", stage), options.stageBody ?? STOCK_STAGE(stage), { mode: 0o755 });

        const log = join(root, "native.log");
        const fake = `#!/bin/sh\necho "native $* fallback=$VIS_FALLBACK_ENTRY" >> "${log}"\nexit \${FAKE_EXIT:-0}\n`;
        const pkg = join(root, "node_modules/@visulima/vis");

        mkdirSync(join(pkg, "dist"), { recursive: true });
        writeFileSync(join(pkg, "dist/bin.js"), "");

        if (options.binary === "package" || options.binary === undefined) {
            writeFileSync(join(pkg, "vis-native-cli"), fake, { mode: 0o755 });
        } else if (options.binary === "binding" || options.binary === "other-binding") {
            const slug = options.binary === "binding" ? target : "some-other-target";

            mkdirSync(join(root, "node_modules/@visulima", `vis-binding-${slug}`), { recursive: true });
            writeFileSync(join(root, "node_modules/@visulima", `vis-binding-${slug}`, "vis-native-cli"), fake, { mode: 0o755 });
        }

        // The slow path resolves `vis` from node_modules/.bin; make it observable too.
        mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
        writeFileSync(join(root, "node_modules/.bin/vis"), `#!/bin/sh\necho "node-launcher $*" >> "${log}"\n`, { mode: 0o755 });

        return { cleanup, log, root };
    };

    const fire = (root: string, hook: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): { code: number; out: string } => {
        try {
            const out = execFileSync(join(root, ".vis/hooks/_", hook), args, { cwd: root, encoding: "utf8", env: { ...process.env, VIS_GIT_HOOKS: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });

            return { code: 0, out };
        } catch (error) {
            const failure = error as { status: number; stdout: string };

            return { code: failure.status, out: failure.stdout };
        }
    };

    it("runs the native binary directly for a stock stage script", () => {
        expect.assertions(2);

        const { cleanup, log, root } = setup();

        try {
            expect(fire(root, "pre-commit", ["a", "b"]).code).toBe(0);
            expect(readFileSync(log, "utf8")).toBe(`native hook run pre-commit a b fallback=${join(root, "node_modules/@visulima/vis/dist/bin.js")}\n`);
        } finally {
            cleanup();
        }
    });

    it.skipIf(target === undefined)("finds the binary in this platform's sibling binding package (pnpm / npm layouts)", () => {
        expect.assertions(1);

        const { cleanup, log, root } = setup({ binary: "binding" });

        try {
            fire(root, "pre-commit");

            expect(readFileSync(log, "utf8")).toContain("native hook run pre-commit");
        } finally {
            cleanup();
        }
    });

    it("ignores binding packages built for another platform", () => {
        expect.assertions(1);

        const { cleanup, log, root } = setup({ binary: "other-binding" });

        try {
            fire(root, "pre-commit");

            expect(readFileSync(log, "utf8")).toBe("node-launcher hook run pre-commit\n");
        } finally {
            cleanup();
        }
    });

    it("honours the VIS_NATIVE_BIN override and pins the Node the native runner delegates to", () => {
        expect.assertions(2);

        const { cleanup, log, root } = setup({ binary: false });

        try {
            const override = join(root, "override-bin");

            writeFileSync(override, `#!/bin/sh\necho "native $* node=$VIS_NODE" >> "${log}"\n`, { mode: 0o755 });

            expect(fire(root, "pre-commit", [], { VIS_NATIVE_BIN: override, VIS_NODE: "/inherited/node" }).code).toBe(0);
            expect(readFileSync(log, "utf8")).toBe("native hook run pre-commit node=node\n");
        } finally {
            cleanup();
        }
    });

    it("falls back to the stage script when the native binary cannot start", () => {
        expect.assertions(2);

        const { cleanup, log, root } = setup({ binary: false });

        try {
            writeFileSync(join(root, "node_modules/@visulima/vis/vis-native-cli"), "#!/nonexistent/interpreter\n", { mode: 0o755 });

            expect(fire(root, "pre-commit").code).toBe(0);
            expect(readFileSync(log, "utf8")).toBe("node-launcher hook run pre-commit\n");
        } finally {
            cleanup();
        }
    });

    it("keeps the exit code and the failure notice of the native run", () => {
        expect.assertions(2);

        const { cleanup, root } = setup();

        try {
            const result = fire(root, "pre-commit", [], { FAKE_EXIT: "3" });

            expect(result.code).toBe(3);
            expect(result.out).toContain("vis - pre-commit script failed (code 3)");
        } finally {
            cleanup();
        }
    });

    it("falls back to the stage script when there is no native binary", () => {
        expect.assertions(1);

        const { cleanup, log, root } = setup({ binary: false });

        try {
            fire(root, "pre-commit");

            expect(readFileSync(log, "utf8")).toBe("node-launcher hook run pre-commit\n");
        } finally {
            cleanup();
        }
    });

    it.each([
        ["an extra command", `#!/usr/bin/env sh\necho before\nexec vis hook run pre-commit "$@"\n`],
        ["a different stage", STOCK_STAGE("pre-push")],
        ["forwarded args dropped", "#!/usr/bin/env sh\nexec vis hook run pre-commit\n"],
    ])("does not take the native shortcut when the stage script has %s", (_name, body) => {
        expect.assertions(1);

        const { cleanup, log, root } = setup({ stageBody: body });

        try {
            fire(root, "pre-commit");

            expect(readFileSync(log, "utf8")).not.toContain("native");
        } finally {
            cleanup();
        }
    });

    it("skips every hook when VIS_GIT_HOOKS=0", () => {
        expect.assertions(2);

        const { cleanup, log, root } = setup();

        try {
            expect(fire(root, "pre-commit", [], { VIS_GIT_HOOKS: "0" }).code).toBe(0);
            expect(existsSync(log)).toBe(false);
        } finally {
            cleanup();
        }
    });

    it("exits quietly when the stage has no script", () => {
        expect.assertions(2);

        const { cleanup, log, root } = setup();

        try {
            expect(fire(root, "commit-msg", ["msg"]).code).toBe(0);
            expect(existsSync(log)).toBe(false);
        } finally {
            cleanup();
        }
    });

    it("resolves the repo root from a relative invocation path too", () => {
        expect.assertions(1);

        const { cleanup, log, root } = setup();

        try {
            // git hands the hook a path relative to the repo root when core.hooksPath is relative.
            execFileSync(".vis/hooks/_/pre-commit", ["x"], { cwd: root, env: { ...process.env, VIS_GIT_HOOKS: "1" } });

            // ...and the path handed to the binary (and inherited by hook commands) must not be relative.
            expect(readFileSync(log, "utf8")).toBe(`native hook run pre-commit x fallback=${join(realpathSync(root), "node_modules/@visulima/vis/dist/bin.js")}\n`);
        } finally {
            cleanup();
        }
    });

    it("works for a custom hooks directory with a different depth", () => {
        expect.assertions(1);

        const { cleanup, root } = createTemporaryGitRepo();

        try {
            installHooks(".config/husky");
            writeFileSync(join(root, ".config/husky/pre-commit"), STOCK_STAGE("pre-commit"), { mode: 0o755 });
            mkdirSync(join(root, "node_modules/@visulima/vis/dist"), { recursive: true });
            writeFileSync(join(root, "node_modules/@visulima/vis/dist/bin.js"), "");
            writeFileSync(join(root, "node_modules/@visulima/vis/vis-native-cli"), `#!/bin/sh\necho ran > "${join(root, "ran")}"\n`, { mode: 0o755 });
            execFileSync(".config/husky/_/pre-commit", [], { cwd: root, env: { ...process.env, VIS_GIT_HOOKS: "1" } });

            expect(existsSync(join(root, "ran"))).toBe(true);
        } finally {
            cleanup();
        }
    });
});
