import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { runHookStage } from "../../src/commands/hook/run";

/**
 * `vis hook run` exists twice: the Node runner (`src/commands/hook`) and the native fast path
 * (`native/cli/src/hook`). The native one promises to be indistinguishable from the Node one for
 * every config it accepts, and to hand the rest to Node. This table is the contract: each case runs
 * through both and the observable result must match — exit status, the lines logged, every file
 * the hooks rewrote, and what each hook command was handed.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);

interface Case {
    args?: string[];
    config: Record<string, unknown>;
    files: Record<string, string>;
    /** Extra `hook run` flags. */
    flags?: string[];
    /** `false` ⇒ the native runner must decline and delegate to Node. */
    native?: boolean;
    stage?: string;
}

const REC = "./rec.sh";
const hook = (id: string, fields: Record<string, unknown>): Record<string, unknown> => { return { id, ...fields }; };
const cfg = (...hooks: Record<string, unknown>[]): Record<string, unknown> => { return { stages: { "pre-commit": hooks }, version: 1 }; };

const MESSY = { "a.ts": "a  \nb\t\n", "b.md": "hard break  \nnext\n   \nlast  ", "c.txt": "no newline", "d.txt": "x\r\n\r\n", "e.txt": "\n\n\n" };
const MIXED = { "m1.txt": "x\ny\r\nz\r\nw\n", "m2.txt": "x\r\ny\r\nz\nw", "m3.txt": "x\r\ry" };
const TREE = { "data/d.json": "{}\n", "docs/n.md": "# n\n", "run.py": "#!/usr/bin/env python3\nprint(1)\n", "src/a.ts": "a\n", "src/b.ts": "b\n", "x.txt": "x\n" };

const CASES: Record<string, Case> = {
    "--all-files": { config: cfg(hook("t", { entry: REC })), files: TREE, flags: ["--all-files"] },
    "alwaysRun without matching files": { config: cfg(hook("t", { alwaysRun: true, entry: REC, files: "nomatch" })), files: TREE },
    "args are appended before the files": { config: cfg(hook("t", { args: ["--flag", "it's"], entry: REC })), files: TREE },
    "check-json is delegated": { config: cfg(hook("j", { builtin: "check-json" })), files: { "a.json": "{}\n" }, native: false },
    "check-merge-conflict --assume-in-merge": {
        config: cfg(hook("c", { args: ["--assume-in-merge"], builtin: "check-merge-conflict" })),
        files: { "k.txt": "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> br\n", "ok.txt": "fine\n" },
    },
    "check-merge-conflict outside a merge": { config: cfg(hook("c", { builtin: "check-merge-conflict" })), files: { "k.txt": "<<<<<<< HEAD\n" } },
    "exit codes OR-fold": { config: cfg(hook("a", { entry: "./fail.sh" }), hook("b", { entry: REC })), files: TREE },
    "fail entry": { config: cfg(hook("t", { fail: "do not use this" })), files: TREE },
    "failFast stops at the first failure": { config: { ...cfg(hook("a", { entry: "./fail.sh" }), hook("b", { entry: REC })), failFast: true }, files: TREE },
    "failing entry": { config: cfg(hook("t", { entry: "./fail.sh" })), files: TREE },
    "files + exclude": { config: cfg(hook("t", { entry: REC, exclude: "^docs/", files: String.raw`^(src|docs)/` })), files: TREE },

    "files regex": { config: cfg(hook("t", { entry: REC, files: String.raw`\.ts$` })), files: TREE },
    "git-arg stage: entry reads \"$1\" itself": {
        args: ["MSGFILE"],
        config: { stages: { "commit-msg": [hook("t", { entry: `${REC} "$1"` })] }, version: 1 },
        files: TREE,
        stage: "commit-msg",
    },
    "git-arg stage forwards its arguments": {
        args: ["MSGFILE", "other"],
        config: { stages: { "commit-msg": [hook("t", { entry: REC })] }, version: 1 },
        files: TREE,
        stage: "commit-msg",
    },
    "lazy quantifier": { config: cfg(hook("t", { entry: REC, files: String.raw`^s.*?c/` })), files: TREE },
    "mixed-line-ending --fix=lf": { config: cfg(hook("m", { args: ["--fix=lf"], builtin: "mixed-line-ending" })), files: MIXED },
    "mixed-line-ending --fix=no": { config: cfg(hook("m", { args: ["--fix=no"], builtin: "mixed-line-ending" })), files: MIXED },
    "mixed-line-ending -f crlf": { config: cfg(hook("m", { args: ["-f", "crlf"], builtin: "mixed-line-ending" })), files: MIXED },
    "mixed-line-ending auto": { config: cfg(hook("m", { builtin: "mixed-line-ending" })), files: MIXED },

    "mixed-line-ending bad value": { config: cfg(hook("m", { args: ["--fix=bogus"], builtin: "mixed-line-ending" })), files: MIXED },
    "newline-separated commands run through the shell": { config: cfg(hook("t", { entry: `${REC}\n./fail.sh`, passFilenames: false })), files: TREE },
    "no hooks for the stage": { config: cfg(hook("t", { entry: REC })), files: TREE, stage: "pre-push" },
    "no matching files skips the hook": { config: cfg(hook("t", { entry: REC, files: "nomatch" })), files: TREE },

    "passFilenames false": { config: cfg(hook("t", { entry: REC, passFilenames: false })), files: TREE },
    "regex with a non-ASCII path is delegated": { config: cfg(hook("t", { entry: REC, files: String.raw`\.txt$` })), files: { "ünï.txt": "x\n" }, native: false },
    "shell entries still go through sh": { config: cfg(hook("t", { entry: `${REC} one && ${REC} two` })), files: TREE },
    "trailing-whitespace + end-of-file-fixer": { config: cfg(hook("a", { builtin: "trailing-whitespace" }), hook("b", { builtin: "end-of-file-fixer" })), files: MESSY },
    types: { config: cfg(hook("t", { entry: REC, types: ["python"] })), files: TREE },

    "types: text + executable": { config: cfg(hook("t", { entry: REC, types: ["text"] })), files: TREE },
    "typesOr + excludeTypes": { config: cfg(hook("t", { entry: REC, excludeTypes: ["json"], typesOr: ["json", "markdown", "ts"] })), files: TREE },
    "unknown builtin is delegated": { config: cfg(hook("j", { builtin: "nope" })), files: { "a.ts": "a\n" }, native: false },
    "unsupported regex (brace with space) is delegated": { config: cfg(hook("t", { entry: REC, files: "a{ 2}" })), files: TREE, native: false },

    "unsupported regex (lookahead) is delegated": { config: cfg(hook("t", { entry: REC, files: "(?=src)" })), files: TREE, native: false },
    "unsupported regex (stacked quantifier) is delegated": { config: cfg(hook("t", { entry: REC, files: String.raw`\.ts?+$` })), files: TREE, native: false },
    "verbose prints the hook name": { config: cfg(hook("t", { entry: REC, name: "Recorder", verbose: true })), files: TREE },
    "vis-only tag is delegated": { config: cfg(hook("t", { entry: REC, types: ["vis-config"] })), files: { "vis.config.ts": "export default {};\n" }, native: false },
    "word boundary and class": { config: cfg(hook("t", { entry: REC, files: String.raw`\bsrc/[a-z]+\.ts$` })), files: TREE },
};

interface Outcome {
    files: Record<string, string>;
    lines: string[];
    ok: boolean;
}

const sh = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
};

const build = (spec: Case): string => {
    const root = mkdtempSync(join(tmpdir(), "vis-hook-parity-"));

    sh(root, "init", "-q", ".");
    sh(root, "config", "user.email", "t@example.com");
    sh(root, "config", "user.name", "t");
    mkdirSync(join(root, ".vis/hooks"), { recursive: true });
    writeFileSync(join(root, ".vis/hooks/config.json"), JSON.stringify(spec.config));
    writeFileSync(join(root, "rec.sh"), '#!/bin/sh\necho "$# $*" >> .rec\n', { mode: 0o755 });
    writeFileSync(join(root, "fail.sh"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });

    return root;
};

/** Every file under `root` except git internals, as path → content. */
const snapshot = (root: string, directory = root): Record<string, string> => {
    const out: Record<string, string> = {};

    for (const name of readdirSync(directory)) {
        const full = join(directory, name);

        if (name === ".git") {
            continue;
        }

        if (statSync(full).isDirectory()) {
            Object.assign(out, snapshot(root, full));
        } else {
            out[full.slice(root.length + 1)] = readFileSync(full, "utf8");
        }
    }

    return out;
};

const stage = (root: string, spec: Case): void => {
    for (const [path, content] of Object.entries(spec.files)) {
        const full = join(root, path);

        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, { mode: path.endsWith(".py") ? 0o755 : 0o644 });
        sh(root, "add", path);
    }
};

const runNode = (root: string, spec: Case): Outcome => {
    const lines: string[] = [];
    const previous = process.cwd();

    process.chdir(root);

    try {
        const code = runHookStage(
            root,
            ".vis/hooks",
            { allFiles: spec.flags?.includes("--all-files"), extraArgs: spec.args ?? [], stage: spec.stage },
            { error: (message) => lines.push(`err: ${message}`), info: (message) => lines.push(`out: ${message}`) },
        );

        return { files: snapshot(root), lines, ok: code === 0 };
    } finally {
        process.chdir(previous);
    }
};

const runNative = (root: string, spec: Case): Outcome & { delegated: boolean } => {
    const stub = join(root, "..", `delegate-${process.pid}.sh`);

    writeFileSync(stub, 'echo "DELEGATED"\n');

    const result = spawnSync(binary as string, ["hook", "run", spec.stage ?? "pre-commit", ...(spec.args ?? []), ...(spec.flags ?? [])], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, VIS_FALLBACK_ENTRY: stub, VIS_FALLBACK_ENTRY_OVERRIDE: stub, VIS_HOOK_TRACE: "1", VIS_NODE: "sh" },
    });

    rmSync(stub, { force: true });

    const tag = (prefix: string, text: string): string[] =>
        text
            .split("\n")
            .filter((line) => line !== "" && !line.startsWith("vis[native]") && !line.startsWith("Error: Hook stage exited with code"))
            .map((line) => `${prefix}: ${line}`);

    return {
        delegated: result.stdout.includes("DELEGATED"),
        files: snapshot(root),
        lines: [...tag("out", result.stdout), ...tag("err", result.stderr)],
        ok: result.status === 0,
    };
};

const matching = Object.entries(CASES).filter(([, spec]) => spec.native !== false);
const declined = Object.entries(CASES).filter(([, spec]) => spec.native === false);

/** Two identical repos with the case staged: one for each runner. */
const repos = (spec: Case, roots: string[]): { nativeRoot: string; nodeRoot: string } => {
    const nodeRoot = build(spec);
    const nativeRoot = build(spec);

    roots.push(nodeRoot, nativeRoot);
    stage(nodeRoot, spec);
    stage(nativeRoot, spec);

    return { nativeRoot, nodeRoot };
};

describe.skipIf(!binary || process.platform === "win32")("vis hook run: native runner vs Node runner", () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    // Each case builds two git repos and spawns git a dozen times; the slowest take a few seconds.
    it.each(matching)("%s", { timeout: 60_000 }, (_name, spec) => {
        expect.assertions(3);

        const { nativeRoot, nodeRoot } = repos(spec, roots);
        const native = runNative(nativeRoot, spec);
        const node = runNode(nodeRoot, spec);

        expect(native.delegated).toBe(false);
        expect(native.lines).toStrictEqual(node.lines);
        expect({ files: native.files, ok: native.ok }).toStrictEqual({ files: node.files, ok: node.ok });
    });

    // Declined before any hook ran: Node takes over, and nothing has touched the staged files.
    it.each(declined)("%s", { timeout: 60_000 }, (_name, spec) => {
        expect.assertions(1);

        const { nativeRoot } = repos(spec, roots);
        const native = runNative(nativeRoot, spec);
        const untouched = Object.entries(spec.files).every(([path, content]) => native.files[path] === content);

        expect({ delegated: native.delegated, untouched }).toStrictEqual({ delegated: true, untouched: true });
    });
});
