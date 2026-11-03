import { execFileSync } from "node:child_process";

import { isAbsolute, join, resolve } from "@visulima/path";

import { VisUserError } from "../errors/vis-user-error";

/**
 * Overrides for user config that changes git's output shape: quoted
 * non-ASCII paths, forced colour, paths relative to the cwd, textconv
 * drivers and external diff tools.
 */
const GIT_HARDENING = ["-c", "core.quotepath=off", "-c", "color.ui=never", "-c", "diff.relative=false"];
const DIFF_HARDENING = ["--no-color", "--no-textconv", "--no-ext-diff"];

const runGit = (root: string, args: string[]): string => {
    try {
        return execFileSync("git", [...GIT_HARDENING, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
        return "";
    }
};

/** Split NUL-separated (`-z`) git output; paths are verbatim, with no quoting to undo. */
const splitFiles = (stdout: string): string[] => stdout.split("\0").filter(Boolean);

/** Absolute paths of files changed since `ref` (defaults to upstream/HEAD~1). */
export const filesSince = (root: string, ref: string): string[] => {
    if (ref.startsWith("-")) {
        throw new VisUserError(`--since "${ref}" looks like a flag, not a git ref.`);
    }

    // `--show-cdup` keeps the caller's spelling of `root`; `--show-toplevel` is a
    // realpath and would not match a symlinked workspace path.
    const base = resolve(root, runGit(root, ["rev-parse", "--show-cdup"]).trim());
    const diff = (range: string): string[] => splitFiles(runGit(root, ["diff", "-z", "--name-only", "--diff-filter=ACMR", ...DIFF_HARDENING, range, "--"]));
    let list = diff(`${ref}...HEAD`);

    // Fallback for the common case where the user hasn't set up a merge-base yet.
    if (list.length === 0) {
        list = diff(ref);
    }

    // `git diff` prints paths relative to the repository root, not the cwd.
    return list.map((p) => (isAbsolute(p) ? p : join(base, p)));
};

/** True if `git` is on PATH and `root` is a working tree. */
export const hasGit = (root: string): boolean => runGit(root, ["rev-parse", "--show-toplevel"]).trim().length > 0;
