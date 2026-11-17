import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Git exports `GIT_DIR`, `GIT_INDEX_FILE` and friends into hook processes, so
 * these tests retarget the outer repo when the suite runs from a pre-commit
 * hook. Clear them for the duration so every git call resolves from cwd.
 */
const INHERITED_GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];

const detachGitEnvironment = (): (() => void) => {
    const saved = new Map(INHERITED_GIT_VARS.map((name) => [name, process.env[name]]));

    for (const name of INHERITED_GIT_VARS) {
        Reflect.deleteProperty(process.env, name);
    }

    return () => {
        for (const [name, value] of saved) {
            if (value === undefined) {
                Reflect.deleteProperty(process.env, name);
            } else {
                process.env[name] = value;
            }
        }
    };
};

/**
 * Creates a temp directory with `git init` and returns cleanup helpers.
 * execSync used with hardcoded "git init" — no user input, safe for test setup.
 */
export const createTemporaryGitRepo = (): { cleanup: () => void; restore: () => void; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "vis-hook-test-"));
    const originalCwd = process.cwd();
    const restoreEnvironment = detachGitEnvironment();

    execSync("git init", { cwd: root, stdio: "ignore" });
    process.chdir(root);

    return {
        cleanup: () => {
            process.chdir(originalCwd);
            restoreEnvironment();
            rmSync(root, { force: true, recursive: true });
        },
        restore: () => {
            process.chdir(originalCwd);
            restoreEnvironment();
        },
        root,
    };
};
