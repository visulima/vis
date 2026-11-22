import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    applySecretlintIgnores,
    buildIgnoreMatcher,
    filterIgnoredFiles,
    isPathExcluded,
    isWithin,
    overrideMatchPath,
    resolveSecretlintIgnoreFiles,
} from "../src/ignore-matcher";

let tmp: string;

beforeEach(async () => {
    tmp = realpathSync(await mkdtemp(resolve(tmpdir(), "secret-scanner-ignore-test-")));
});

afterEach(async () => {
    await rm(tmp, { force: true, recursive: true });
});

describe(buildIgnoreMatcher, () => {
    it("returns undefined when no options are provided", () => {
        expect.assertions(1);

        expect(buildIgnoreMatcher(undefined, tmp)).toBeUndefined();
    });

    it("returns undefined when walk has neither files nor patterns", () => {
        expect.assertions(1);

        expect(buildIgnoreMatcher({ walk: {} }, tmp)).toBeUndefined();
    });

    it("builds a matcher from inline patterns", () => {
        expect.assertions(2);

        const matcher = buildIgnoreMatcher({ walk: { excludePatterns: ["*.log", "dist/**"] } }, tmp);

        expect(matcher?.ignores(resolve(tmp, "deploy.log"))).toBe(true);
        expect(matcher?.ignores(resolve(tmp, "src/app.ts"))).toBe(false);
    });

    it("builds a matcher from an ignore-style file", async () => {
        expect.assertions(2);

        const ignoreFile = resolve(tmp, ".secretsignore");

        await writeFile(ignoreFile, "fixtures/**\n*.env\n");

        const matcher = buildIgnoreMatcher({ walk: { excludeFromFiles: [ignoreFile] } }, tmp);

        expect(matcher?.ignores(resolve(tmp, "fixtures/leak.txt"))).toBe(true);
        expect(matcher?.ignores(resolve(tmp, "production.env"))).toBe(true);
    });

    it("merges patterns from files and inline lists", async () => {
        expect.assertions(2);

        const ignoreFile = resolve(tmp, ".custom-ignore");

        await writeFile(ignoreFile, "*.tmp\n");

        const matcher = buildIgnoreMatcher({
            walk: {
                excludeFromFiles: [ignoreFile],
                excludePatterns: ["*.log"],
            },
        }, tmp);

        expect(matcher?.ignores(resolve(tmp, "cache.tmp"))).toBe(true);
        expect(matcher?.ignores(resolve(tmp, "deploy.log"))).toBe(true);
    });

    it("keeps negation scoped to the source that declared it", async () => {
        expect.assertions(3);

        const exclusions = resolve(tmp, "exclusions.ignore");
        const exceptions = resolve(tmp, "exceptions.ignore");

        await writeFile(exclusions, "*.env\n");
        await writeFile(exceptions, "!leak.env\n");

        // A separate source cannot re-include what the first source excluded.
        const combined = buildIgnoreMatcher({ walk: { excludeFromFiles: [exclusions, exceptions] } }, tmp);

        expect(combined?.ignores(resolve(tmp, "leak.env"))).toBe(true);

        // Inside one source, negation still works.
        await writeFile(exceptions, "*.env\n!leak.env\n");
        const singleSource = buildIgnoreMatcher({ walk: { excludeFromFiles: [exceptions] } }, tmp);

        expect(singleSource?.ignores(resolve(tmp, "leak.env"))).toBe(false);
        expect(singleSource?.ignores(resolve(tmp, "other.env"))).toBe(true);
    });

    it("anchors each ignore file at its own directory and ignores paths outside it", async () => {
        expect.assertions(4);

        await mkdir(resolve(tmp, "app"));
        await writeFile(resolve(tmp, "app/.secretlintignore"), "/config/\n");

        // The scan root is `tmp`, but `/config/` is anchored at `tmp/app`.
        const matcher = buildIgnoreMatcher({ walk: { excludeFromFiles: [resolve(tmp, "app/.secretlintignore")] } }, tmp);

        expect(matcher?.ignores(resolve(tmp, "app/config/a.txt"))).toBe(true);
        expect(matcher?.ignores(resolve(tmp, "config/a.txt"))).toBe(false);
        expect(matcher?.ignores(resolve(tmp, "app/sub/config/a.txt"))).toBe(false);
        expect(matcher?.ignores(resolve(tmp, "other.txt"))).toBe(false);
    });

    it("anchors an explicit file in a subdirectory at the base, so it can exclude paths outside that subdirectory", async () => {
        expect.assertions(3);

        await mkdir(resolve(tmp, "tools"));
        await writeFile(resolve(tmp, "tools/secrets.ignore"), "dist/\n/app/\n");

        const matcher = buildIgnoreMatcher({ walk: { excludeFromFiles: [resolve(tmp, "tools/secrets.ignore")] } }, tmp);

        expect(matcher?.ignores(resolve(tmp, "dist/a.txt"))).toBe(true);
        expect(matcher?.ignores(resolve(tmp, "app/a.txt"))).toBe(true);
        expect(matcher?.ignores(resolve(tmp, "tools/app/a.txt"))).toBe(false);
    });

    it("silently skips missing ignore files", () => {
        expect.assertions(1);

        const matcher = buildIgnoreMatcher({
            walk: {
                excludeFromFiles: [resolve(tmp, "does-not-exist.ignore")],
                excludePatterns: ["*.log"],
            },
        }, tmp);

        // Matcher still builds from the patterns we did get.
        expect(matcher?.ignores(resolve(tmp, "deploy.log"))).toBe(true);
    });

    it("warns and continues when an ignore-file read fails (e.g. it's a directory)", async () => {
        expect.assertions(3);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        // A directory exists() but readFileSync(dir) throws EISDIR → caught + warned.
        const dir = resolve(tmp, "a-directory");

        await mkdir(dir);

        const matcher = buildIgnoreMatcher({
            walk: {
                excludeFromFiles: [dir],
                excludePatterns: ["*.log"],
            },
        }, tmp);

        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError.mock.calls[0]?.[0]).toContain("failed to read ignore file");
        // The inline pattern still produced a usable matcher.
        expect(matcher?.ignores(resolve(tmp, "deploy.log"))).toBe(true);

        consoleError.mockRestore();
    });
});

describe(resolveSecretlintIgnoreFiles, () => {
    it("auto-discovers .secretlintignore in the root and adds explicit paths", async () => {
        expect.assertions(2);

        const discovered = resolve(tmp, ".secretlintignore");
        const explicit = resolve(tmp, "extra.ignore");

        await writeFile(discovered, "*.env\n");
        await writeFile(explicit, "*.log\n");

        const options = { secretlintIgnore: [explicit] };

        expect(resolveSecretlintIgnoreFiles(options, [tmp])).toStrictEqual([explicit, discovered]);
        expect(applySecretlintIgnores(options, [tmp])?.walk?.excludeFromFiles).toStrictEqual([explicit, discovered]);
    });

    it("stops discovery at the repository root", async () => {
        expect.assertions(1);

        const repo = resolve(tmp, "repo");
        const pkg = resolve(repo, "pkg");

        await mkdir(resolve(repo, ".git"), { recursive: true });
        await mkdir(pkg);
        await writeFile(resolve(tmp, ".secretlintignore"), "*\n");
        await writeFile(resolve(repo, ".secretlintignore"), "*.env\n");
        await writeFile(resolve(pkg, ".secretlintignore"), "*.log\n");

        expect(resolveSecretlintIgnoreFiles(undefined, [pkg])).toStrictEqual([resolve(pkg, ".secretlintignore"), resolve(repo, ".secretlintignore")]);
    });

    it("only looks at the scan root itself outside a repository", async () => {
        expect.assertions(1);

        const nested = resolve(tmp, "a/b");

        await mkdir(nested, { recursive: true });
        await writeFile(resolve(tmp, "a/.secretlintignore"), "*\n");
        await writeFile(resolve(nested, ".secretlintignore"), "*.env\n");

        expect(resolveSecretlintIgnoreFiles(undefined, [nested])).toStrictEqual([resolve(nested, ".secretlintignore")]);
    });

    it("honours secretlintIgnore: false", async () => {
        expect.assertions(1);

        await writeFile(resolve(tmp, ".secretlintignore"), "*.env\n");

        expect(resolveSecretlintIgnoreFiles({ secretlintIgnore: false }, [tmp])).toStrictEqual([]);
    });
});

describe(filterIgnoredFiles, () => {
    it("passes files through unchanged when the matcher is undefined", () => {
        expect.assertions(1);

        const files = ["src/a.ts", "src/b.ts"];

        expect(filterIgnoredFiles(files, undefined, process.cwd())).toStrictEqual(files);
    });

    it("drops files the matcher matches", () => {
        expect.assertions(1);

        const matcher = buildIgnoreMatcher({ walk: { excludePatterns: ["*.log"] } }, tmp);

        expect(filterIgnoredFiles(["src/app.ts", "deploy.log", "src/app.test.ts"], matcher, tmp)).toStrictEqual(["src/app.ts", "src/app.test.ts"]);
    });

    it("keeps files that resolve outside the cwd", () => {
        expect.assertions(1);

        const matcher = buildIgnoreMatcher({ walk: { excludePatterns: ["**"] } }, tmp);
        // `../outside.ts` relative-resolves to `..` → skipped through the "starts with `..`" guard.
        const kept = filterIgnoredFiles(["../outside.ts"], matcher, resolve(tmp));

        expect(kept).toStrictEqual(["../outside.ts"]);
    });

    it("falls back to the raw cwd when realpathSync(cwd) throws", () => {
        expect.assertions(1);

        // A cwd that doesn't exist makes `realpathSync(cwd)` throw → fallback to the
        // raw string. The relative `deploy.log` still resolves and is filtered out.
        const missingCwd = resolve(tmp, "does-not-exist-dir");
        const matcher = buildIgnoreMatcher({ walk: { excludePatterns: ["*.log"] } }, missingCwd);
        const kept = filterIgnoredFiles(["deploy.log", "app.ts"], matcher, missingCwd);

        expect(kept).toStrictEqual(["app.ts"]);
    });
});

describe(isPathExcluded, () => {
    it("is false when no excludes are configured", () => {
        expect.assertions(1);

        expect(isPathExcluded("dist/x.env", undefined, tmp)).toBe(false);
    });

    it("matches inline patterns against a root-relative path", () => {
        expect.assertions(2);

        const options = { walk: { excludePatterns: ["dist/**"] } };

        expect(isPathExcluded("dist/x.env", options, tmp)).toBe(true);
        expect(isPathExcluded("src/x.env", options, tmp)).toBe(false);
    });

    it("honours exclude files", async () => {
        expect.assertions(2);

        const ignoreFile = resolve(tmp, ".secretsignore");

        await writeFile(ignoreFile, "*.env\n");

        const options = { walk: { excludeFromFiles: [ignoreFile] } };

        expect(isPathExcluded("config/a.env", options, tmp)).toBe(true);
        expect(isPathExcluded("config/a.ts", options, tmp)).toBe(false);
    });

    it("honours a discovered .secretlintignore like scanFiles does", async () => {
        expect.assertions(3);

        await writeFile(resolve(tmp, ".secretlintignore"), "*.env\n");

        expect(isPathExcluded("config/a.env", undefined, tmp)).toBe(true);
        expect(isPathExcluded("config/a.ts", undefined, tmp)).toBe(false);
        expect(isPathExcluded("config/a.env", { secretlintIgnore: false }, tmp)).toBe(false);
    });

    it("never excludes a path outside the root", () => {
        expect.assertions(1);

        expect(isPathExcluded("../dist/x.env", { walk: { excludePatterns: ["**"] } }, tmp)).toBe(false);
    });
});

describe(overrideMatchPath, () => {
    it("keeps the directory of a path whose first component merely starts with two dots", async () => {
        expect.assertions(2);

        await mkdir(resolve(tmp, "..config"));
        await writeFile(resolve(tmp, "..config", "app.env"), "x");

        expect(overrideMatchPath("..config/app.env", [tmp], tmp)).toBe("..config/app.env");
        expect(overrideMatchPath(resolve(tmp, "..", "outside.env"), [tmp], tmp)).toBe("outside.env");
    });
});

describe(isWithin, () => {
    it("is true only for paths strictly below the root", () => {
        expect.assertions(5);

        expect(isWithin(tmp, resolve(tmp, "a/b.txt"))).toBe(true);
        expect(isWithin(tmp, resolve(tmp, "..foo"))).toBe(true);
        expect(isWithin(tmp, tmp)).toBe(false);
        expect(isWithin(tmp, resolve(tmp, "../sibling"))).toBe(false);
        expect(isWithin(resolve(tmp, "a"), resolve(tmp, "ab/c.txt"))).toBe(false);
    });
});
