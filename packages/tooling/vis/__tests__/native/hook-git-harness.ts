import { execFileSync, spawnSync } from "node:child_process";
/* eslint-disable no-bitwise -- permission bits need bit-level masking. */
import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";

import { tree } from "./destructive-parity-harness";
import type { Result } from "./workspace-parity-harness";
import { Harness } from "./workspace-parity-harness";

/**
 * What the hook parity suites (`hook-install-parity.test.ts`, `hook-uninstall-parity.test.ts`) share: a repository per
 * workspace, and an outcome that sees what the two commands change besides files, `core.hooksPath`, and the file modes
 * of every path (`tree` of the destructive-parity harness), so a changed mode shows.
 *
 * Every run, setup and command alike, reads no global or system git configuration, so a `core.hooksPath` of the machine
 * the suite runs on cannot change which path the commands take.
 */
export const ISOLATED_GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...Harness.environment(), ...ISOLATED_GIT }, stdio: ["ignore", "pipe", "ignore"] });

/** `git config --local core.hooksPath` of `root`, or `undefined` when it is unset. */
export const hooksPath = (root: string): string | undefined => {
    const result = spawnSync("git", ["config", "--local", "core.hooksPath"], { cwd: root, encoding: "utf8", env: { ...Harness.environment(), ...ISOLATED_GIT } });

    return result.status === 0 ? result.stdout.trim() : undefined;
};

/** The permission bits of one file or directory of `root`, in octal. */
export const modeOf = (root: string, name: string): string => (lstatSync(join(root, name)).mode & 0o7777).toString(8);

export interface HookOutcome {
    hooksPath: string | undefined;
    status: number | null;
    stderr: string;
    stdout: string;
    /** Every path with its type, mode and content, but `.git`. */
    tree: Record<string, string>;
}

/** What a run that is handed over must leave alone: `core.hooksPath` and every path but `.git`. */
export const state = (root: string): { hooksPath: string | undefined; tree: Record<string, string> } => {
    return { hooksPath: hooksPath(root), tree: tree(root) };
};

export const hookOutcome = (result: Result, root: string): HookOutcome => {
    const { status, stderr, stdout } = Harness.outcome(result, root);

    return { hooksPath: hooksPath(root), status, stderr, stdout, tree: tree(root) };
};

export interface Setup {
    /** Permission bits to set before the run, by relative path. */
    chmod?: Record<string, number>;
    /** Config entries to set in the repository (set with `git config --local`). */
    config?: Record<string, string>;
    /** Whether the directory is a git repository (default). */
    repository?: boolean;
}

/** A repository in `root` with the setup applied. */
export const prepare = (root: string, setup: Setup): void => {
    if (setup.repository !== false) {
        git(root, "init", "-q");

        for (const [key, value] of Object.entries(setup.config ?? {})) {
            git(root, "config", "--local", key, value);
        }
    }

    for (const [file, mode] of Object.entries(setup.chmod ?? {})) {
        chmodSync(join(root, file), mode);
    }
};

/** Commits everything in `root`, so a worktree can be added. */
export const commitAll = (root: string): void => {
    git(root, "add", "-A");
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x");
};
