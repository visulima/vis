/* eslint-disable perfectionist/sort-objects -- the fixtures are deliberately unsorted: the key order is what the command changes */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { COLOUR_ENVIRONMENTS, DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";

/**
 * `vis sort-package-json` exists twice: the Node handler (`src/commands/sort-package-json/handler.ts`) and the
 * native path (`native/cli/src/sort_package_json/`). For every input the native path accepts it must write the
 * same bytes as Node and print the same text with the same exit status, and every input it declines must be
 * handed to Node unchanged. Node needs the built CLI (`dist/bin.js`) and the NAPI addon, and the native side
 * needs the `vis` binary, so the suite is skipped when either is missing.
 *
 * "Native answered" is proved by running the binary without `VIS_FALLBACK_ENTRY`: a declined invocation then
 * exits 70 ("failed to launch Node CLI") instead of printing, so a Node-vs-delegated-Node comparison cannot
 * pass vacuously. The two sides run in workspaces whose paths have the same length, because pail wraps its
 * lines by the length of the paths it prints.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repositoryRoot = resolve(packageRoot, "..", "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");

let scratch: string;
let nativeBinary: string;
let counter: number;

type Files = Record<string, Buffer | string>;

/** The files of a pnpm workspace whose projects are `packages/*`, with `files` on top. */
const workspaceFiles = (files: Files): Files => {
    return {
        "package.json": `${JSON.stringify({ name: "root", private: true }, null, 2)}\n`,
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
        "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
        ...files,
    };
};

/** A fresh directory holding `files`. `side` keeps the two sides' paths the same length. */
const materialize = (side: "node" | "native", files: Files): string => {
    counter += 1;

    const root = join(scratch, side === "node" ? "a" : "b", String(counter).padStart(6, "0"));

    for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, name)), { recursive: true });
        writeFileSync(join(root, name), content);
    }

    return realpathSync(root);
};

/** A pair of identical workspaces, for the Node side and the native side. */
const pair = (files: Files): [string, string] => {
    // `counter` advances per call, so the two paths differ only in their directory name (`a` or `b`).
    const nodeRoot = materialize("node", files);

    counter -= 1;

    return [nodeRoot, materialize("native", files)];
};

const environment = (extra: Record<string, string> = {}, ci = true): Record<string, string> => {
    return {
        HOME: process.env["HOME"] ?? "",
        PATH: process.env["PATH"] ?? "",
        VIS_NO_UPDATE_CHECK: "1",
        ...(ci ? { CI: "1" } : {}),
        ...extra,
    };
};

interface Result {
    status: number | null;
    stderr: string;
    stdout: string;
}

const runNode = (args: string[], cwd: string, extra: Record<string, string> = {}, ci = true): Result =>
    spawnSync(process.execPath, [nodeEntry, "sort-package-json", ...args], { cwd, encoding: "utf8", env: environment(extra, ci) });

const runNative = (args: string[], cwd: string, extra: Record<string, string> = {}, ci = true): Result =>
    spawnSync(nativeBinary, ["sort-package-json", ...args], { cwd, encoding: "utf8", env: environment(extra, ci) });

const delegation = (): Record<string, string> => {
    return { VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath };
};

/** Replaces the workspace root, the clock and the process id in the Node runtime's own warnings. */
const normalize = (text: string, root: string): string => text.replaceAll(root, "<ROOT>").replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS").replaceAll(/\(node:\d+\)/g, "(node:PID)");

/** Every file under `root`, relative path to hex, so a difference in any byte shows. */
const snapshot = (root: string): Record<string, string> => {
    const tree: Record<string, string> = {};

    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            const path = join(entry.parentPath, entry.name);

            tree[relative(root, path)] = readFileSync(path).toString("hex");
        }
    }

    return tree;
};

/** Everything a run produces, comparable across the two workspaces. */
const outcome = (result: Result, root: string): { status: number | null; stderr: string; stdout: string; tree: Record<string, string> } => {
    return { status: result.status, stderr: normalize(result.stderr, root), stdout: normalize(result.stdout, root), tree: snapshot(root) };
};

/** Runs both sides on identical workspaces and expects identical outcomes; the native side must have answered. */
const expectParity = (files: Files, args: string[], extra: Record<string, string> = {}): void => {
    const [nodeRoot, nativeRoot] = pair(files);
    const node = runNode(args, nodeRoot, extra);
    const native = runNative(args, nativeRoot, extra);

    expect(native.status, `native stderr: ${native.stderr}`).not.toBe(70);
    expect(outcome(native, nativeRoot)).toStrictEqual(outcome(node, nodeRoot));
};

/** The native side declines (exit 70 without the Node entry) and the delegated run matches Node. */
const expectDelegation = (files: Files, args: string[], extra: Record<string, string> = {}, ci = true): void => {
    const [nodeRoot, nativeRoot] = pair(files);
    const node = runNode(args, nodeRoot, extra, ci);
    const probe = materialize("native", files);
    const before = snapshot(probe);

    expect(runNative(args, probe, extra, ci).status).toBe(70);
    expect(snapshot(probe), "a declined run must not touch the files").toStrictEqual(before);

    const native = runNative(args, nativeRoot, { ...extra, ...delegation() }, ci);

    expect(outcome(native, nativeRoot)).toStrictEqual(outcome(node, nodeRoot));
};

const privileged = process.getuid?.() === 0;

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis sort-package-json: native vs Node", () => {
    beforeAll(() => {
        counter = 0;
        scratch = mkdtempSync(join(tmpdir(), "vis-sort-package-json-parity-"));
        nativeBinary = join(scratch, "bin", "vis");
        mkdirSync(join(scratch, "bin"));
        copyFileSync(binary as string, nativeBinary);
        chmodSync(nativeBinary, 0o755);
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    const json = (value: unknown, indent: string | number = 2, end = "\n"): string => JSON.stringify(value, null, indent) + end;

    // Cases the native path answers. Each is one file in its own project, so one Node run covers them all.
    const ACCEPTED: Record<string, string> = {
        "already-sorted": json({ name: "a", version: "1.0.0", scripts: { build: "x", test: "y" } }),
        "unsorted-basic": json({ version: "1.0.0", scripts: { test: "y", build: "x" }, name: "a", description: "d", license: "MIT" }),
        "unknown-fields": json({ zeta: 1, alpha: { b: 1, a: 2 }, name: "a", "x-custom": [3, 1, 2], version: "1.0.0" }),
        "private-field": json({ private: true, name: "a", version: "0.0.0", workspaces: ["packages/*"], scripts: { b: "1", a: "2" } }),
        dependencies: json({ name: "a", devDependencies: { z: "1", a: "2" }, dependencies: { "@b/x": "1", a: "2", "@a/y": "3" }, peerDependencies: { y: "1", x: "2" } }),
        "files-and-keywords": json({ name: "a", files: ["dist", "dist", "src", "a"], keywords: ["b", "a", "b"] }),
        "non-string-in-files": json({ name: "a", files: ["dist", 1, null, "src"], keywords: [true, "x"] }),
        "exports-conditions": json({ name: "a", exports: { ".": { default: "./d.js", require: "./r.cjs", types: "./t.d.ts", import: "./i.js", node: "./n.js", "node-addons": "./a.node", custom: "./c.js" }, "./sub": { require: "./r.cjs", import: "./i.js" } } }),
        "exports-nested-arrays": json({ name: "a", exports: { ".": [{ default: "./d.js", types: "./t.d.ts" }, "./x.js"], "./y": { import: { default: "./d.js", types: "./t.d.ts" }, require: "./r.js" } } }),
        "exports-string": json({ name: "a", exports: "./index.js" }),
        "exports-top-level-conditions": json({ name: "a", exports: { default: "./d.js", import: "./i.js", types: "./t.d.ts" } }),
        "bugs-url": json({ name: "a", bugs: { url: "https://github.com/a/b/issues" } }),
        "bugs-more": json({ name: "a", bugs: { url: "https://x", email: "a@b.c" } }),
        "bugs-url-number": json({ name: "a", bugs: { url: 5 } }),
        "bugs-string": json({ name: "a", bugs: "https://x" }),
        "repo-https-git": json({ name: "a", repository: { type: "git", url: "git+https://github.com/owner/repo.git" } }),
        "repo-https-no-git": json({ name: "a", repository: { type: "git", url: "git+https://github.com/owner/repo" } }),
        "repo-no-type": json({ name: "a", repository: { url: "git+https://github.com/owner/repo.git" } }),
        "repo-ssh": json({ name: "a", repository: { type: "git", url: "git+ssh://git@github.com/owner/repo.git" } }),
        "repo-directory": json({ name: "a", repository: { type: "git", url: "git+https://github.com/owner/repo.git", directory: "packages/a" } }),
        "repo-empty-directory": json({ name: "a", repository: { type: "git", url: "git+https://github.com/owner/repo.git", directory: "" } }),
        "repo-dotted-name": json({ name: "a", repository: { type: "git", url: "git+https://github.com/owner/re.po.git" } }),
        "repo-other-type": json({ name: "a", repository: { type: "svn", url: "git+https://github.com/owner/repo.git" } }),
        "repo-null-type": json({ name: "a", repository: { type: null, url: "git+https://github.com/owner/repo.git" } }),
        "repo-extra-key": json({ name: "a", repository: { type: "git", url: "git+https://github.com/owner/repo.git", extra: 1 } }),
        "repo-string": json({ name: "a", repository: "github:owner/repo" }),
        "repo-other-host": json({ name: "a", repository: { type: "git", url: "git+https://gitlab.com/owner/repo.git" } }),
        "repo-path-segments": json({ name: "a", repository: { type: "git", url: "git+https://github.com/owner/repo/sub" } }),
        "repo-empty-name": json({ name: "a", repository: { type: "git", url: "git+https://github.com/owner/.git" } }),
        tabs: json({ version: "1.0.0", name: "a", scripts: { b: "1", a: "2" } }, "\t"),
        "four-spaces": json({ version: "1.0.0", name: "a" }, 4),
        "three-spaces": json({ version: "1.0.0", name: "a" }, 3),
        "twelve-spaces": json({ version: "1.0.0", name: "a", nested: { x: 1 } }, 12),
        "mixed-indent": '{\n\t"version": "1.0.0",\n  "name": "a"\n}\n',
        minified: '{"version":"1.0.0","name":"a","scripts":{"b":"1","a":"2"}}',
        crlf: json({ version: "1.0.0", name: "a" }).replaceAll("\n", "\r\n"),
        "crlf-no-final-newline": json({ version: "1.0.0", name: "a" }, 2, "").replaceAll("\n", "\r\n"),
        "crlf-sorted": json({ name: "a", version: "1.0.0" }).replaceAll("\n", "\r\n"),
        "no-final-newline": json({ version: "1.0.0", name: "a" }, 2, ""),
        "sorted-no-final-newline": json({ name: "a", version: "1.0.0" }, 2, ""),
        "trailing-blank-lines": json({ version: "1.0.0", name: "a" }, 2, "\n\n\n"),
        "leading-blank-line": `\n${json({ version: "1.0.0", name: "a" })}`,
        "whitespace-only-indent-line": '{\n  \n  "version": "1.0.0",\n"name": "a"}\n',
        unicode: json({ name: "a", description: "héllo wörld 日本語 😀\u2028\u2029 \u007F", keywords: ["ключ", "钥匙"], ключ: 1, "😀": 2 }),
        escapes: json({ name: "a", description: 'quote " backslash \\ slash / \b \f \n \r \t \u0001 \u001F' }),
        "escaped-input": '{\n  "version": "1.0.0",\n  "name": "\\u0061\\/b\\ud83d\\ude00\\u00e9",\n  "description": "\\u2028\\u007f\\u001f"\n}\n',
        "empty-object": "{}\n",
        "empty-object-no-newline": "{}",
        "nested-empties": json({ name: "a", scripts: {}, files: [], nested: { a: {}, b: [] } }),
        integers: json({ name: "a", port: 3000, zero: 0, negative: -5, big: 123_456_789_012_345, list: [1, 2, 3] }),
        literals: json({ name: "a", a: null, b: true, c: false, list: [null, true, false, "x", { y: 1 }] }),
        "scripts-unsorted": json({ name: "a", scripts: { test: "t", build: "b", "pre:build": "p", postbuild: "q", prebuild: "r", lint: "l" } }),
        "publish-config": json({ publishConfig: { registry: "https://r", access: "public" }, name: "a", engines: { node: ">=20" }, config: { z: 1, a: 2 }, pnpm: { overrides: { z: "1", a: "2" } } }),
        "js-object-names": json({ name: "a", constructor: 1, hasOwnProperty: 2, toString: 3, valueOf: 4, isPrototypeOf: 5, __defineGetter__: 6 }),
        "keys-that-look-numeric": json({ name: "a", "01": 1, "-1": 2, "1a": 3, 1.5: 4 }),
        "deep-nesting": json({ name: "a", a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }),
        large: json({
            name: "large",
            version: "1.0.0",
            dependencies: Object.fromEntries(Array.from({ length: 4000 }, (_, index) => [`dep-${String((index * 7919) % 4000).padStart(5, "0")}`, `^${String(index)}.0.0`])),
            files: Array.from({ length: 2000 }, (_, index) => `dir-${String(2000 - index)}`),
        }),
    };

    // Cases the native path leaves to Node, each with the reason.
    const DECLINED: Record<string, string> = {
        // The reader of the native path leaves the byte order mark, and the rest is errors.
        bom: `\uFEFF${json({ version: "1.0.0", name: "a" })}`,
        comment: '{\n  // c\n  "name": "a"\n}\n',
        // Not the same value in JS.
        "duplicate-keys": '{\n  "name": "a",\n  "version": "1",\n  "name": "b"\n}\n',
        "empty-file": "",
        exponent: '{\n  "name": "a",\n  "big": 1e21\n}\n',
        float: '{\n  "name": "a",\n  "ratio": 0.5\n}\n',
        "integer-keys": '{\n  "name": "a",\n  "dependencies": {"2": "1", "1": "2", "b": "3"}\n}\n',
        "invalid-json": '{\n  "name": "a",\n}\n',
        "invalid-utf8": Buffer.from([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) as unknown as string,
        "lone-surrogate": '{\n  "name": "a",\n  "bad": "\\ud800"\n}\n',
        "negative-zero": '{\n  "name": "a",\n  "zero": -0\n}\n',
        "proto-key": '{\n  "name": "a",\n  "__proto__": {"x": 1}\n}\n',
        "single-quotes": "{'name': 'a'}",
        "too-deep": `{"name":"a","deep":${"[".repeat(90)}1${"]".repeat(90)}}`,
        "top-level-array": "[1, 2]\n",
        "top-level-string": '"a"\n',
        "trailing-garbage": '{"name":"a"} x',
        "unsafe-integer": '{\n  "name": "a",\n  "big": 9007199254740993\n}\n',
    };

    const projects = (cases: Record<string, string>): Files => Object.fromEntries(Object.entries(cases).map(([name, text]) => [`packages/${name}/package.json`, text]));

    // The flag sets the accepted cases run under.
    const FLAG_SETS: string[][] = [
        [],
        ["--check"],
        ["-c"],
        ["--sort-scripts"],
        ["--indent", "4"],
        ["--indent=tab"],
        ["--indent", "0"],
        ["--indent", "12"],
        ["--indent", String.raw`\t`],
        ["--indent", "   "],
        ["--line-ending", "crlf"],
        ["--line-ending=lf"],
        ["--line-ending", "auto"],
        ["--no-final-newline"],
        ["--no-editorconfig"],
        ["--no-format-bugs"],
        ["--no-format-repository"],
        ["--no-sort-exports"],
        ["--no-format-bugs", "--no-format-repository", "--no-sort-exports"],
        ["--sort-order", "name,version,license"],
        ["--sort-order", "version", "--sort-order=name"],
        ["--sort-order", "zeta,,name, version", "--check"],
        ["--sort-order", "constructor,__proto__,toString"],
        ["--unsorted", "dependencies,devDependencies"],
        ["--unsorted", "scripts", "--sort-scripts"],
        ["--unsorted", "files,exports,scripts,missing", "--unsorted=keywords"],
        ["--sort-scripts", "--indent", "tab", "--line-ending", "crlf", "--no-final-newline"],
        ["--ignore", "*.json"],
        ["--ignore", "package.json", "--check"],
        ["--ignore", "packages/unicode/package.json"],
        ["--ignore", "packages/*/package.json"],
        ["--ignore", "packages/tabs/package.json,packages/minified/package.json", "--ignore=packages/crlf/package.json"],
        ["--ignore", "packages/t*/package.json"],
        ["--ignore", "packages/????/package.json"],
        ["--ignore", "nothing"],
    ];

    describe("accepted cases", () => {
        it("are answered natively, one by one", () => {
            expect.hasAssertions();

            for (const [name, text] of Object.entries(ACCEPTED)) {
                const root = materialize("native", workspaceFiles(projects({ [name]: text })));
                const native = runNative(["--check"], root);

                expect(native.status, `${name}: ${native.stderr}`).not.toBe(70);
            }
        });

        it("rewrites most of the fixtures, so the write path is what the parity runs exercise", () => {
            expect.hasAssertions();

            const root = materialize("native", workspaceFiles(projects(ACCEPTED)));
            const result = runNative([], root);

            expect(result.stdout.match(/Sorted /g)?.length ?? 0).toBeGreaterThan(30);
        });

        it.each(FLAG_SETS)("`sort-package-json %s` writes and prints what Node does", (...flags: string[]) => {
            expect.hasAssertions();

            expectParity(workspaceFiles(projects(ACCEPTED)), flags);
        });

        it("is idempotent: a second run finds everything sorted, as on Node", () => {
            expect.hasAssertions();

            const [nodeRoot, nativeRoot] = pair(workspaceFiles(projects(ACCEPTED)));

            runNode([], nodeRoot);
            runNative([], nativeRoot);

            const node = runNode(["--check"], nodeRoot);
            const native = runNative(["--check"], nativeRoot);

            expect(native.status).toBe(node.status);
            expect(normalize(native.stdout, nativeRoot)).toBe(normalize(node.stdout, nodeRoot));
            expect(native.status).toBe(0);
            expect(snapshot(nativeRoot)).toStrictEqual(snapshot(nodeRoot));
        });
    });

    // The files Node leaves after sorting them once: the flags then change what a sorted file looks like.
    describe("a workspace that is already sorted", () => {
        let sortedFiles: Files;

        beforeAll(() => {
            const [sortedRoot] = pair(workspaceFiles(projects(ACCEPTED)));

            runNode([], sortedRoot);

            sortedFiles = Object.fromEntries(Object.entries(snapshot(sortedRoot)).map(([name, hex]) => [name, Buffer.from(hex, "hex")]));
        });

        it.each(FLAG_SETS)("`sort-package-json %s` writes and prints what Node does", (...flags: string[]) => {
            expect.hasAssertions();

            expectParity(sortedFiles, flags);
        });
    });

    describe("declined cases", () => {
        it.each(Object.keys(DECLINED))("%s is handed to Node", (name) => {
            expect.hasAssertions();

            expectDelegation(workspaceFiles(projects({ [name]: DECLINED[name] as string })), []);
        });

        it("a declined file among accepted ones changes nothing before the hand-off", () => {
            expect.hasAssertions();

            const files = workspaceFiles(projects({ ...ACCEPTED, ...DECLINED }));

            expectDelegation(files, []);
            expectDelegation(files, ["--check"]);
        });
    });

    describe("the repository's own package.json files", () => {
        const listed = spawnSync("git", ["-C", repositoryRoot, "ls-files", "*package.json"], { encoding: "utf8" });
        const paths = listed.status === 0 ? listed.stdout.split("\n").filter((line) => line.endsWith("package.json")) : [];
        const corpus: Files = {};

        for (const [index, path] of paths.entries()) {
            const absolute = join(repositoryRoot, path);

            if (existsSync(absolute) && statSync(absolute).isFile()) {
                corpus[`packages/p${String(index).padStart(4, "0")}/package.json`] = readFileSync(absolute);
            }
        }

        it("has files to compare", () => {
            expect.hasAssertions();

            expect(Object.keys(corpus).length).toBeGreaterThan(100);
        });

        it("every file the native path answers is written as Node writes it", () => {
            expect.hasAssertions();

            const [nodeRoot] = pair(workspaceFiles(corpus));

            expect(runNode([], nodeRoot).status).not.toBe(70);

            const mismatches: string[] = [];
            const declined: string[] = [];
            const expected = snapshot(nodeRoot);

            for (const name of Object.keys(corpus)) {
                const root = materialize("native", workspaceFiles({ [name]: corpus[name] as Buffer }));
                const result = runNative([], root);

                if (result.status === 70) {
                    declined.push(name);
                } else if (snapshot(root)[name] !== expected[name]) {
                    mismatches.push(name);
                }
            }

            // A file that is declined is Node's; only a wrong answer is a failure here.
            expect({ mismatches }).toStrictEqual({ mismatches: [] });
            // The corpus is meant to be mostly native; a mass decline would hide a broken gate.
            expect(declined.length).toBeLessThan(Object.keys(corpus).length / 2);
        });

        it("prints and writes the same on the whole corpus in every mode", () => {
            expect.hasAssertions();

            const nativeOnly: Files = {};

            for (const name of Object.keys(corpus)) {
                const root = materialize("native", workspaceFiles({ [name]: corpus[name] as Buffer }));

                if (runNative(["--check"], root).status !== 70) {
                    nativeOnly[name] = corpus[name] as Buffer;
                }
            }

            for (const flags of [["--check"], [], ["--sort-scripts"], ["--check"]]) {
                expectParity(workspaceFiles(nativeOnly), flags);
            }
        });
    });

    // Seeded random inputs: the same seed gives the same cases, so a failure can be replayed.
    describe("random inputs", () => {
        // A linear congruential generator: not good randomness, but seeded, and enough to vary the inputs.
        const generator = (seed: number) => {
            let state = seed;

            return (): number => {
                state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;

                return state / 4_294_967_296;
            };
        };

        // `SORT_PACKAGE_JSON_FUZZ=<n>` multiplies the number of seeds, for a longer one-off run.
        const seeds = (first: number, count: number): number[] => Array.from({ length: count * Number(process.env["SORT_PACKAGE_JSON_FUZZ"] ?? 1) }, (_, index) => first + index);

        type Random = () => number;

        const pick = <T>(random: Random, items: ReadonlyArray<T>): T => items[Math.floor(random() * items.length)] as T;
        const between = (random: Random, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

        const KEYS = ["name", "version", "description", "scripts", "exports", "main", "module", "types", "files", "bugs", "repository", "dependencies", "devDependencies", "peerDependencies", "keywords", "license", "author", "private", "engines", "publishConfig", "bin", "type", "sideEffects", "x-custom", "zeta", "alpha", "ключ", "a.b", "toString", "constructor", "pnpm", "config", "workspaces", "funding", "homepage", "packageManager"];
        const WORDS = ["a", "b", "z", "dist", "src", "héllo", "日本", "😀", 'q"uote', String.raw`back\slash`, "tab\there", "nl\nx", "\u0001", "\u2028", "pkg-1", "@s/x", "", " ", "git+https://github.com/o/r.git", "git+https://github.com/o/r", "git+ssh://git@github.com/o/r.git", "https://x.y"];
        const CONDITIONS = ["types", "node-addons", "node", "import", "require", "default", "browser", "development", "./sub", "."];

        const randomValue = (random: Random, depth: number): unknown => {
            const kind = depth > 3 ? between(random, 0, 3) : between(random, 0, 7);

            switch (kind) {
                case 0: {
                    return pick(random, WORDS);
                }
                case 1: {
                    return between(random, -1000, 1_000_000);
                }
                case 2: {
                    return pick(random, [true, false, null]);
                }
                case 3: {
                    return pick(random, WORDS);
                }
                case 4:
                case 5: {
                    return Object.fromEntries(Array.from({ length: between(random, 0, 5) }, () => [pick(random, [...KEYS, ...CONDITIONS]), randomValue(random, depth + 1)]));
                }
                default: {
                    return Array.from({ length: between(random, 0, 5) }, () => randomValue(random, depth + 1));
                }
            }
        };

        const randomDocument = (random: Random): string => {
            const document: Record<string, unknown> = {};

            for (let index = between(random, 0, 14); index > 0; index -= 1) {
                const key = pick(random, KEYS);

                if (key === "bugs" && random() < 0.7) {
                    document[key] = random() < 0.5 ? { url: pick(random, WORDS) } : { email: "e", url: "https://x" };
                } else if (key === "repository" && random() < 0.7) {
                    document[key] = { ...(random() < 0.7 ? { type: pick(random, ["git", "svn", null]) } : {}), url: pick(random, WORDS), ...(random() < 0.2 ? { directory: pick(random, WORDS) } : {}) };
                } else if (key === "exports" && random() < 0.7) {
                    document[key] = Object.fromEntries(Array.from({ length: between(random, 0, 6) }, () => [pick(random, CONDITIONS), random() < 0.5 ? "./x.js" : randomValue(random, 2)]));
                } else if (key === "scripts" && random() < 0.7) {
                    document[key] = Object.fromEntries(Array.from({ length: between(random, 0, 8) }, () => [pick(random, ["build", "test", "prebuild", "postbuild", "lint", "dev", "pre:x", "x:y", "start", "zz"]), pick(random, WORDS)]));
                } else {
                    document[key] = randomValue(random, 0);
                }
            }

            const indent = pick(random, [2, 4, "\t", 1, 3, 11]);
            let text = JSON.stringify(document, null, random() < 0.1 ? 0 : indent);

            if (random() < 0.8) {
                text += "\n";
            }

            return random() < 0.2 ? text.replaceAll("\n", "\r\n") : text;
        };

        it.each(seeds(1, 8))("random documents, seed %i, are written as Node writes them", (seed) => {
            expect.hasAssertions();

            const random = generator(seed);
            const flags = [
                ...(random() < 0.3 ? ["--check"] : []),
                ...(random() < 0.3 ? ["--sort-scripts"] : []),
                ...(random() < 0.3 ? ["--indent", pick(random, ["2", "tab", "4", "0"])] : []),
                ...(random() < 0.3 ? ["--line-ending", pick(random, ["lf", "crlf"])] : []),
                ...(random() < 0.2 ? ["--no-final-newline"] : []),
                ...(random() < 0.2 ? ["--sort-order", "version,name"] : []),
                ...(random() < 0.2 ? ["--unsorted", "scripts,exports"] : []),
                ...(random() < 0.2 ? ["--no-format-repository"] : []),
            ];
            const documents: Record<string, string> = {};

            for (let index = 0; index < 60; index += 1) {
                documents[`d${String(index).padStart(3, "0")}`] = randomDocument(random);
            }

            // Only the documents the native path takes: the others are declined by design (see the declined cases).
            const taken: Record<string, string> = {};

            for (const [name, text] of Object.entries(documents)) {
                const probe = materialize("native", workspaceFiles(projects({ [name]: text })));

                if (runNative(["--check"], probe).status !== 70) {
                    taken[name] = text;
                }
            }

            expect(Object.keys(taken).length, "the generator mostly makes documents the native path takes").toBeGreaterThan(30);

            expectParity(workspaceFiles(projects(taken)), flags);
            expectParity(workspaceFiles(projects(taken)), []);
        });

        it.each(seeds(1001, 6))("random .gitignore lines and workspace shapes, seed %i, select the files Node selects", (seed) => {
            expect.hasAssertions();

            const random = generator(seed);
            const NAMES = ["a", "b", "ab", "A", "pkg-1", "pkg.x", "dist", "sub", "x_y"];
            const segment = (): string => {
                const name = pick(random, NAMES);

                return pick(random, [name, name, `${name.slice(0, 1)}*`, `*${name.slice(-1)}`, "*", `${name.slice(0, 1)}?`, "?", name.toUpperCase()]);
            };
            const line = (): string => {
                const body = Array.from({ length: between(random, 1, 3) }, segment).join("/");

                return `${pick(random, ["", "", "/"])}${body}${pick(random, ["", "", "/"])}`;
            };
            const lines = Array.from({ length: between(random, 1, 4) }, line);
            const exclusions = random() < 0.4 ? [`!${segment()}`, `!packages/${segment()}`] : [];
            const projectsList: Files = {};

            for (const first of ["a", "b", "ab", "A", "pkg-1", "dist"]) {
                projectsList[`packages/${first}/package.json`] = json({ version: "1", name: first });

                for (const second of ["sub", "pkg.x", "a"]) {
                    projectsList[`packages/${first}/${second}/package.json`] = json({ name: `${first}-${second}`, version: "1" });
                }
            }

            projectsList["pnpm-workspace.yaml"] = `packages:\n  - "packages/**"\n  - "pkg-*"\n  - "x_y"\n${exclusions.map((entry) => `  - "${entry}"`).join("\n")}\n`;
            projectsList["pkg-1/package.json"] = json({ version: "1", name: "pkg-1" });
            projectsList["x_y/package.json"] = json({ version: "1", name: "x_y" });
            projectsList[".gitignore"] = `${lines.join("\n")}\n`;

            expectParity(workspaceFiles(projectsList), ["--check"]);
        });

        it.each(seeds(2001, 4))("random --ignore globs, seed %i, select the files Node selects", (seed) => {
            expect.hasAssertions();

            const random = generator(seed);
            const part = (): string => pick(random, ["packages", "a", "b", "*", "?", "pa*", "*.json", "package.json", "p*e.json", "*age*", "a?", "A", "package.jso?"]);
            const globs = Array.from({ length: 6 }, () => Array.from({ length: between(random, 1, 3) }, part).join("/"));
            const projectsList: Files = {};

            for (const name of ["a", "b", "ab"]) {
                projectsList[`packages/${name}/package.json`] = json({ version: "1", name });
            }

            for (const glob of globs) {
                expectParity(workspaceFiles(projectsList), ["--check", "--ignore", glob]);
            }
        });
    });

    describe(".editorconfig", () => {
        const files = workspaceFiles(projects({ one: json({ version: "1", name: "a" }, 4), three: json({ version: "1", name: "c" }).replaceAll("\n", "\r\n"), two: json({ version: "1", name: "b" }, "\t") }));

        it.each([
            ["tab indent", "root = true\n[*]\nindent_style = tab\n"],
            ["eight spaces", "root = true\n[*]\nindent_style = space\nindent_size = 8\n"],
            ["size only", "root = true\n[*]\nindent_size = 3\n"],
            ["crlf", "root = true\n[*]\nend_of_line = crlf\n"],
            ["lf", "root = true\n[*]\nend_of_line = lf\n"],
            ["by glob", "root = true\n[*.json]\nindent_size = 5\n[packages/two/*]\nindent_style = tab\nend_of_line = crlf\n"],
            ["unusable values", "root = true\n[*]\nindent_size = tab\nindent_style = bogus\nend_of_line = cr\n"],
            ["unset", "root = true\n[*]\nindent_size = 6\n[packages/one/*]\nindent_size = unset\n"],
            ["not a json file section", "root = true\n[*.md]\nindent_size = 8\n"],
        ])("%s: %s", (_name, config) => {
            expect.hasAssertions();

            expectParity({ ...files, ".editorconfig": config }, []);
        });

        it.each([["--no-editorconfig"], ["--indent", "2"], ["--line-ending", "lf"]])("%s still follows Node when a .editorconfig is present", (...flags) => {
            expect.hasAssertions();

            expectParity({ ...files, ".editorconfig": "root = true\n[*]\nindent_style = tab\nend_of_line = crlf\n" }, flags);
        });
    });

    describe("workspace discovery", () => {
        const pkg = (name: string): string => json({ version: "1", name });

        it.each([
            ["a single glob", 'packages:\n  - "packages/*"\n', { "packages/a/package.json": pkg("a"), "packages/b/package.json": pkg("b"), "packages/c/readme.md": "x" }],
            ["quotes and comments", "packages:\n  # c\n  - 'packages/*'\n  - libs/x\n\nother:\n  - ignored/*\n", { "ignored/y/package.json": pkg("y"), "libs/x/package.json": pkg("x"), "packages/a/package.json": pkg("a") }],
            ["double star", 'packages:\n  - "packages/**"\n', { "packages/a/nested/package.json": pkg("n"), "packages/a/package.json": pkg("a"), "packages/package.json": pkg("p") }],
            ["double star skips node_modules", 'packages:\n  - "packages/**"\n', { "packages/.git/y/package.json": pkg("g"), "packages/a/node_modules/x/package.json": pkg("n"), "packages/a/package.json": pkg("a") }],
            ["two levels", 'packages:\n  - "apps/*/*"\n', { "apps/x/a/package.json": pkg("a"), "apps/x/package.json": pkg("x"), "apps/y/b/package.json": pkg("b") }],
            ["bare glob", "packages:\n  - '@*'\n  - 'pkg-*'\n", { "@scope/package.json": pkg("s"), "other/package.json": pkg("o"), "pkg-a/package.json": pkg("a") }],
            ["overlapping patterns", 'packages:\n  - "tools"\n  - "tools/**"\n', { "tools/a/package.json": pkg("a"), "tools/package.json": pkg("t") }],
            ["missing directory", 'packages:\n  - "nothing/*"\n  - "packages/*"\n', { "packages/a/package.json": pkg("a") }],
            ["no packages key falls back to package.json", "overrides:\n  x: 1\n", { "package.json": json({ name: "root", workspaces: ["packages/*"] }), "packages/a/package.json": pkg("a") }],
            ["symlink-free ordering", 'packages:\n  - "packages/*"\n', { "packages/_/package.json": pkg("_"), "packages/a/package.json": pkg("a"), "packages/b/package.json": pkg("b"), "packages/B/package.json": pkg("B") }],
            ["a flow-style list reads as no patterns", 'packages: ["packages/*"]\n', { "packages/a/package.json": pkg("a") }],
            ["a project without a package.json is skipped", 'packages:\n  - "packages/*"\n', { "packages/a/project.json": "{}", "packages/b/package.json": pkg("b") }],
            ["the aube workspace file wins", 'packages:\n  - "packages/*"\n', { "aube-workspace.yaml": "packages:\n  - 'libs/*'\n", "libs/l/package.json": pkg("l"), "packages/a/package.json": pkg("a") }],
        ] as [string, string, Files][])("%s", (_name, yaml, extra) => {
            expect.hasAssertions();

            expectParity(workspaceFiles({ "pnpm-workspace.yaml": yaml, ...extra }), []);
        });

        it.each([
            ["a name", "dist\n"],
            ["a rooted name", "/packages/b\n"],
            ["a path", "packages/b\n"],
            ["a wildcard", "pkg-*\n"],
            ["a directory only", "b/\n"],
            ["package.json itself", "package.json\n"],
            ["comments and blanks", "# b\n\n  \n\t\n# ü\nsomething\n"],
            ["case", "PACKAGES/B\n"],
            ["a question mark", "?\n"],
            ["a windows line ending", "packages/b\r\nx\r\n"],
            ["a nested wildcard path", "packages/*/sub\n"],
        ])(".gitignore with %s", (_name, ignore) => {
            expect.hasAssertions();

            expectParity(
                workspaceFiles({ ".gitignore": ignore, "dist/package.json": pkg("d"), "packages/a/package.json": pkg("a"), "packages/b/package.json": pkg("b"), "packages/b/sub/package.json": pkg("s"), "packages/pkg-c/package.json": pkg("c") }),
                ["--check"],
            );
        });

        it.each([
            ["a negated pattern", "packages:\n  - 'packages/*'\n  - '!packages/b'\n"],
            ["a negated glob name", "packages:\n  - 'packages/*'\n  - '!pkg-*'\n"],
            ["a negated trailing slash", "packages:\n  - 'packages/*'\n  - '!packages/b/'\n"],
        ])("workspace exclusions: %s", (_name, yaml) => {
            expect.hasAssertions();

            expectParity(
                workspaceFiles({ "packages/a/package.json": pkg("a"), "packages/b/package.json": pkg("b"), "packages/pkg-c/package.json": pkg("c"), "pnpm-workspace.yaml": yaml }),
                ["--check"],
            );
        });

        it.each([
            ["a negated .gitignore entry", { ".gitignore": "packages/*\n!packages/a\n" }],
            ["a double star in .gitignore", { ".gitignore": "**/b\n" }],
            ["a character class in .gitignore", { ".gitignore": "packages/[ab]\n" }],
            ["an escape in .gitignore", { ".gitignore": "packages/\\b\n" }],
            ["a trailing space in .gitignore", { ".gitignore": "packages/b \n" }],
            ["a non-ASCII .gitignore pattern", { ".gitignore": "packages/ü\n" }],
            ["a double star exclusion", { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!**/b/**'\n" }],
            ["a glob in the middle of a pattern", { "pnpm-workspace.yaml": "packages:\n  - 'packages/a*'\n" }],
            ["workspaces in package.json as an object", { "package.json": json({ name: "r", workspaces: { packages: ["packages/*"] } }), "pnpm-workspace.yaml": "x: 1\n" }],
            ["an invalid root package.json", { "package.json": "{" }],
            ["a symlinked-name project", { "packages/ü/package.json": json({ version: "1", name: "u" }) }],
        ] as [string, Files][])("%s is handed to Node", (_name, extra) => {
            expect.hasAssertions();

            expectDelegation(workspaceFiles({ "packages/a/package.json": pkg("a"), "packages/b/package.json": pkg("b"), ...extra }), ["--check"]);
        });
    });

    describe("messages", () => {
        const unsorted = json({ version: "1", name: "a" });
        const sorted = json({ name: "a", version: "1" });

        it.each([
            ["every file sorted", { "packages/a/package.json": sorted }, []],
            ["every file sorted, checked", { "packages/a/package.json": sorted }, ["--check"]],
            ["one sorted file, checked", { "package.json": sorted, "packages/a/package.json": sorted }, ["--check"]],
            ["one unsorted file", { "packages/a/package.json": unsorted }, []],
            ["one unsorted file, checked", { "packages/a/package.json": unsorted }, ["--check"]],
            ["many files, some unsorted", { "packages/a/package.json": unsorted, "packages/b/package.json": sorted, "packages/c/package.json": unsorted }, []],
            ["many files, some unsorted, checked", { "packages/a/package.json": unsorted, "packages/b/package.json": sorted, "packages/c/package.json": unsorted }, ["--check"]],
            ["every file ignored", { "packages/a/package.json": unsorted }, ["--ignore", "package.json"]],
            ["every file ignored by .gitignore", { ".gitignore": "package.json\n", "packages/a/package.json": unsorted }, []],
            ["a long path wraps like pail's", { [`packages/${"x".repeat(70)}/package.json`]: unsorted }, []],
            ["a long path, checked", { [`packages/${"x".repeat(70)}/package.json`]: unsorted }, ["--check"]],
        ] as [string, Files, string[]][])("%s", (_name, extra, flags) => {
            expect.hasAssertions();

            expectParity(workspaceFiles(extra), flags);
        });
    });

    describe("colour and the output width", () => {
        const files = workspaceFiles({ "packages/a/package.json": json({ version: "1", name: "a" }), "packages/b/package.json": json({ name: "b" }) });

        it.each(COLOUR_ENVIRONMENTS)("%j", (colour) => {
            expect.hasAssertions();

            expectParity(files, [], colour);
            expectParity(files, ["--check"], colour);
        });

        it.each([{ COLUMNS: "60" }, { COLUMNS: "200" }, { COLUMNS: "40" }])("cOLUMNS %j", (columns) => {
            expect.hasAssertions();

            expectParity(files, ["--check"], columns);
            expectParity(files, [], columns);
        });

        it.each([...DELEGATED_COLOUR_ENVIRONMENTS, { COLUMNS: "20" }, { COLUMNS: "abc" }, { TERM: "xterm-whatever" }, { NODE_ENV: "test" }, { NODE_ENV: "debug" }, { DEBUG: "1" }, { PAIL_LOG_LEVEL: "debug" }, { CEREBRO_OUTPUT_LEVEL: "1" }])(
            "%j is Node's",
            (extra) => {
                expect.hasAssertions();

                expectDelegation(files, ["--check"], extra);
            },
        );

        it.each([["--no-color"], ["--color"], ["--no-colors"]])("%s is Node's", (flag) => {
            expect.hasAssertions();

            expectDelegation(files, ["--check", flag]);
        });
    });

    describe("what the native path does not answer", () => {
        const files = workspaceFiles({ "packages/a/package.json": json({ version: "1", name: "a" }) });

        it("a run outside CI", () => {
            expect.hasAssertions();

            expectDelegation(files, ["--check"], {}, false);
        });

        it.each([
            ["a positional", ["packages"]],
            ["an unknown flag", ["--nope"]],
            ["a repeated flag", ["--check", "--check"]],
            ["a repeated single-valued flag", ["--indent", "2", "--indent", "4"]],
            ["a flag value that looks like a flag", ["--sort-order", "-x"]],
            ["an empty value", ["--indent="]],
            ["a missing value", ["--ignore"]],
            ["a bad line ending", ["--line-ending", "cr"]],
            ["a boolean with a value", ["--check=false"]],
            ["an indent with other characters", ["--indent", "ab"]],
            ["a huge indent", ["--indent", "99999999999"]],
            ["the separator", ["--", "x"]],
            ["a glob outside the subset", ["--ignore", "**/a/**"]],
            ["a glob with a class", ["--ignore", "packages/[a]/package.json"]],
            ["a rooted glob", ["--ignore", "/packages/a/package.json"]],
        ] as [string, string[]][])("%s", (_name, flags) => {
            expect.hasAssertions();

            expectDelegation(files, flags);
        });

        it("a vis.config next to the workspace", () => {
            expect.hasAssertions();

            expectDelegation({ ...files, "vis.config.json": "{}" }, ["--check"]);
        });

        it("a vis.config.ts that sets sortPackageJson", () => {
            expect.hasAssertions();

            expectDelegation({ ...files, "vis.config.ts": "export default { sortPackageJson: { sortScripts: true, indent: '4' } };\n" }, []);
        });

        it("a working directory below the workspace root", () => {
            expect.hasAssertions();

            const [nodeRoot, nativeRoot] = pair({ ...files, "packages/a/package.json": json({ version: "1", name: "a" }) });
            const node = runNode(["--check"], join(nodeRoot, "packages", "a"));
            const native = runNative(["--check"], join(nativeRoot, "packages", "a"));

            expect(native.status).toBe(70);
            expect(node.status).toBeDefined();
        });

        it("a non-pnpm workspace", () => {
            expect.hasAssertions();

            expectDelegation(
                {
                    "package-lock.json": "{}",
                    "package.json": json({ name: "root", workspaces: ["packages/*"] }),
                    "packages/a/package.json": json({ version: "1", name: "a" }),
                },
                ["--check"],
            );
        });

        it.skipIf(privileged)("a read-only package.json is Node's, with its error", () => {
            expect.hasAssertions();

            const readOnly = workspaceFiles({ "packages/a/package.json": json({ version: "1", name: "a" }), "packages/b/package.json": json({ version: "2", name: "b" }) });
            const [nodeRoot, nativeRoot] = pair(readOnly);

            for (const root of [nodeRoot, nativeRoot]) {
                chmodSync(join(root, "packages", "b", "package.json"), 0o444);
            }

            const node = runNode([], nodeRoot);
            const probe = runNative([], materialize("native", readOnly));

            expect(probe.status).toBe(0);

            const native = runNative([], nativeRoot, delegation());

            expect(node.status).toBe(1);
            expect(native.status).toBe(1);
            expect(normalize(native.stderr, nativeRoot)).toBe(normalize(node.stderr, nodeRoot));
            expect(normalize(native.stdout, nativeRoot)).toBe(normalize(node.stdout, nodeRoot));
            expect(snapshot(nativeRoot)).toStrictEqual(snapshot(nodeRoot));
        });
    });
});
