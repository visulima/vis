import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanGitHistoryDetailed, scanGitStaged } from "../src/git-scan";
import { scanDetailed, scanFilesDetailed } from "../src/index";
import { ProfileAccumulator } from "../src/profile";

const CONFIG = {
    rules: [{ description: "Fake token", id: "test-token", keywords: ["TESTTOKEN"], regex: String.raw`TESTTOKEN_[A-Za-z0-9]{20}` }],
    title: "test",
};
const config = { extendBundled: false, inline: CONFIG };
const SECRET = "TESTTOKEN_abcdefghij0123456789";

const GIT_REPO_ENV_KEYS = new Set(["GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_WORK_TREE"]);
const hermeticGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_REPO_ENV_KEYS.has(key)));

const dirs: string[] = [];

const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "secret-scanner-profile-")));

    dirs.push(dir);

    return dir;
};

const initRepo = (): { git: (...arguments_: string[]) => string; root: string } => {
    const root = tempDir();
    const git = (...arguments_: string[]): string => execFileSync("git", arguments_, { cwd: root, encoding: "utf8", env: hermeticGitEnv });

    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    git("config", "commit.gpgsign", "false");

    return { git, root };
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { force: true, recursive: true });
    }
});

describe("scan profiling", () => {
    it("omits the profile unless it is requested", async () => {
        expect.assertions(2);

        const dir = tempDir();
        const file = join(dir, "a.env");

        writeFileSync(file, SECRET);

        const listed = await scanFilesDetailed([file], { config });
        const walked = await scanDetailed([dir], { config });

        expect(listed.profile).toBeUndefined();
        expect("profile" in walked).toBe(false);
    }, 30_000);

    it("reports phases, rules, matches and files when requested", async () => {
        expect.assertions(11);

        const dir = tempDir();
        const file = join(dir, "a.env");

        writeFileSync(file, SECRET);

        const result = await scanFilesDetailed([file], { config, profile: true });
        const { profile } = result;
        const phase = (name: string): number | undefined => profile?.phases.find((entry) => entry.name === name)?.ms;
        const rule = profile?.rules.find((entry) => entry.ruleId === "test-token");

        expect(profile).toBeDefined();
        expect(phase("detect")).toBeDefined();
        expect(phase("finalize")).toBeDefined();
        expect(rule?.matches).toBe(1);
        expect(rule?.pattern).toBe(CONFIG.rules[0]?.regex);
        expect(rule?.count).toBeGreaterThanOrEqual(1);
        expect(profile?.files).toHaveLength(1);
        expect(result.findings).toHaveLength(1);
        // The TypeScript pipeline is timed too, and counted in the total.
        expect(phase("postprocess")).toBeDefined();
        expect(profile?.totalMs).toBeGreaterThanOrEqual(phase("postprocess") ?? Number.POSITIVE_INFINITY);
        expect(profile?.phases.some((entry) => entry.name === "validate")).toBe(false);
    }, 30_000);

    it("times validation as its own phase when it is enabled", async () => {
        expect.assertions(2);

        const dir = tempDir();
        const file = join(dir, "a.env");

        writeFileSync(file, SECRET);

        const { profile } = await scanFilesDetailed([file], { config: { ...config, validate: true }, profile: true });

        expect(profile?.phases.map((entry) => entry.name)).toContain("validate");
        expect(profile?.phases.map((entry) => entry.name)).toContain("postprocess");
    }, 30_000);

    it("names files relative to the scan root, however long the root is", async () => {
        expect.assertions(3);

        const root = join(tempDir(), "a-deliberately-long-workspace-directory", "nested-packages", "with-many-segments");

        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "a.env"), SECRET);

        const walked = await scanDetailed([root], { config, profile: true });
        const listed = await scanFilesDetailed([join(root, "src", "a.env")], { config, profile: true });

        expect(walked.profile?.files.map((entry) => entry.file)).toStrictEqual([walked.findings[0]?.file]);
        expect(walked.profile?.files[0]?.file).toBe("src/a.env");
        expect(listed.profile?.files.map((entry) => entry.file)).toStrictEqual([listed.findings[0]?.file]);
    }, 30_000);

    it("labels history rows with the short commit id and folds blobs into one profile", async () => {
        expect.assertions(5);

        const { git, root } = initRepo();

        writeFileSync(join(root, "a.env"), SECRET);
        git("add", "a.env");
        git("commit", "-q", "-m", "add");
        writeFileSync(join(root, "b.env"), `${SECRET}\n`);
        git("add", "b.env");
        git("commit", "-q", "-m", "add b");

        const { findings, profile } = await scanGitHistoryDetailed({ config, cwd: root, profile: true });
        const files = profile?.files.map((entry) => entry.file) ?? [];

        expect(findings).toHaveLength(2);
        expect(files).toHaveLength(2);
        expect(files.every((file) => /^[ab]\.env@[\da-f]{7}$/.test(file))).toBe(true);
        expect(profile?.rules.find((entry) => entry.ruleId === "test-token")?.matches).toBe(2);
        expect(profile?.phases.map((entry) => entry.name)).toStrictEqual(expect.arrayContaining(["git.listCommits", "git.blobs", "postprocess"]));
    }, 60_000);

    it("reports staged files by their reported path and counts git phases once", async () => {
        expect.assertions(3);

        const { git, root } = initRepo();

        writeFileSync(join(root, "a.env"), SECRET);
        git("add", "a.env");

        const previous = process.cwd();

        process.chdir(root);

        try {
            const { profile } = await scanGitStaged({ config, cwd: root, profile: true });
            const phases = profile?.phases.map((entry) => entry.name);

            expect(profile?.files.map((entry) => entry.file)).toStrictEqual(["a.env"]);
            expect(phases).toStrictEqual(expect.arrayContaining(["git.diff", "git.blobs"]));
            // `git.blobs` encloses the native scans, so it is not added on top of them.
            expect(profile?.totalMs).toBeLessThan((profile?.phases.find((entry) => entry.name === "git.blobs")?.ms ?? 0) + (profile?.phases.find((entry) => entry.name === "git.diff")?.ms ?? 0) + 1000);
        } finally {
            process.chdir(previous);
        }
    }, 60_000);
});

describe("scan profiling of Git work", () => {
    it("labels parent rescans of a modified file apart from the commit's own blob", async () => {
        expect.assertions(2);

        const { git, root } = initRepo();

        writeFileSync(join(root, "a.env"), SECRET);
        git("add", "a.env");
        git("commit", "-q", "-m", "add");
        writeFileSync(join(root, "a.env"), `${SECRET}\nTESTTOKEN_zyxwvutsrq9876543210\n`);
        git("add", "a.env");
        git("commit", "-q", "-m", "modify");

        const { profile } = await scanGitHistoryDetailed({ config, cwd: root, profile: true });
        const files = profile?.files.map((entry) => entry.file) ?? [];

        expect(files.filter((file) => file.endsWith(" (parent)"))).toHaveLength(1);
        expect(files.every((file) => /^a\.env@[\da-f]{7}(?: \(parent\))?$/.test(file))).toBe(true);
    }, 60_000);
});

describe(ProfileAccumulator, () => {
    const native = (ms: number, rule: { count: number; ms: number }) => {
        return {
            files: [{ file: "x", ms: 1 }],
            phases: [{ count: 1, ms, name: "detect" }],
            rules: [{ ...rule, pattern: "A", ruleId: "a" }],
            totalMs: ms + 1,
        };
    };

    it("merges native profiles incrementally and sums phases and rules", () => {
        expect.assertions(4);

        const accumulator = new ProfileAccumulator();

        accumulator.addNative(native(5, { count: 1, ms: 3 }), "a@1111111");
        accumulator.addNative(native(4, { count: 2, ms: 6 }), "b@2222222");

        const profile = accumulator.build([]);

        expect(profile.totalMs).toBe(11);
        expect(profile.phases).toStrictEqual([{ count: 2, ms: 9, name: "detect" }]);
        expect(profile.rules).toStrictEqual([{ count: 3, matches: 0, ms: 9, pattern: "A", ruleId: "a" }]);
        expect(profile.files.map((entry) => entry.file)).toStrictEqual(["a@1111111", "b@2222222"]);
    });

    it("adds only the time of an enclosing phase that native scans and phases did not account for", () => {
        expect.assertions(1);

        const accumulator = new ProfileAccumulator();
        const startedAt = performance.now() - 50;

        accumulator.addNative(native(9, { count: 1, ms: 1 }));
        accumulator.addResidual("git.blobs", startedAt, 0);

        expect(accumulator.totalMs).toBeGreaterThanOrEqual(50);
    });

    it("counts matches per rule from the scan's findings", () => {
        expect.assertions(1);

        const accumulator = new ProfileAccumulator();

        accumulator.addNative(native(1, { count: 2, ms: 3 }));

        expect(accumulator.build([{ ruleId: "a" }, { ruleId: "a" }, { ruleId: "b" }]).rules[0]?.matches).toBe(2);
    });

    it("adds TypeScript phases to the total unless they enclose native scans", () => {
        expect.assertions(2);

        const accumulator = new ProfileAccumulator();

        accumulator.addNative(native(4, { count: 1, ms: 1 }));
        accumulator.addPhase("git.diff", 2);
        accumulator.addPhase("git.blobs", 20, { overlapsNative: true });

        const profile = accumulator.build([]);

        expect(profile.totalMs).toBe(7);
        expect(profile.phases.map((entry) => entry.name)).toStrictEqual(["git.blobs", "detect", "git.diff"]);
    });
});
