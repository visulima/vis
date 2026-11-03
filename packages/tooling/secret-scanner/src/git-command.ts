// Git plumbing helpers shared by the history and staged scanners.
//
// Every invocation goes through `runGit` / `GitBlobReader` so the same
// hardening applies everywhere: user config that changes output shape
// (`core.quotepath`, `color.ui`, textconv drivers, external diff tools) is
// overridden on the command line, and repository-redirecting environment
// variables are scrubbed so `cwd` decides which repository is read.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `-c` overrides placed before the subcommand on every git call. */
const GIT_CONFIG_OVERRIDES = ["-c", "core.quotepath=off", "-c", "color.ui=never", "-c", "diff.relative=false"];

/**
 * Extra flags for the diff family (`diff`, `diff-tree`). They keep a user's
 * textconv driver (sops, git-crypt, …) or external diff tool from rewriting
 * the output we parse.
 */
export const DIFF_HARDENING_FLAGS = ["--no-color", "--no-textconv", "--no-ext-diff"];

/** All-zero object id git prints for the missing side of an add or delete. */
export const NULL_OID = /^0+$/;

/** Mode git uses for a submodule commit pointer (gitlink). */
export const GITLINK_MODE = "160000";

/** Bytes inspected for a NUL when deciding whether a blob is binary. */
const BINARY_SNIFF_BYTES = 8192;

// Git reads these from the environment and lets them override the repository
// implied by `cwd`. Inside a git hook an inherited GIT_DIR/GIT_WORK_TREE would
// silently point our plumbing at the wrong repository.
const GIT_REPO_ENV_KEYS = new Set(["GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_WORK_TREE"]);

/**
 * Build the environment for a git child process.
 *
 * `keepIndexFile` preserves `GIT_INDEX_FILE`: during `git commit &lt;paths>` the
 * pre-commit hook gets a temporary index that holds what is actually being
 * committed, so a staged scan must read that one. Git may hand the hook a
 * relative path, so it is resolved against the current process directory.
 */
export const gitEnvironment = (keepIndexFile = false): NodeJS.ProcessEnv => {
    const environment: NodeJS.ProcessEnv = {};

    for (const [key, value] of Object.entries(process.env)) {
        if (!GIT_REPO_ENV_KEYS.has(key)) {
            environment[key] = value;
        }
    }

    const indexFile = process.env["GIT_INDEX_FILE"];

    if (keepIndexFile && indexFile !== undefined && indexFile !== "") {
        environment["GIT_INDEX_FILE"] = isAbsolute(indexFile) ? indexFile : resolvePath(process.cwd(), indexFile);
    }

    return environment;
};

/**
 * Reject an argument that git would interpret as an option. Refs and ranges
 * are user-supplied, and a value starting with `-` could otherwise smuggle a
 * flag (e.g. `--output=…`) into the plumbing call.
 */
export const assertNotFlag = (value: string, label: string): void => {
    if (value.startsWith("-")) {
        throw new Error(`secret-scanner: git ${label} "${value}" looks like a flag; refusing to pass it to git.`);
    }
};

/** Run a git subcommand with the hardening overrides and return its stdout. */
export const runGit = async (gitArguments: string[], cwd: string, environment: NodeJS.ProcessEnv = gitEnvironment()): Promise<string> => {
    const { stdout } = await execFileAsync("git", [...GIT_CONFIG_OVERRIDES, ...gitArguments], {
        cwd,
        env: environment,
        // Commit lists and diff output can be large on long histories.
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
    });

    return stdout;
};

/** True when the first 8 KiB of `content` contain a NUL byte, git's own binary heuristic. */
export const isBinaryBlob = (content: Buffer): boolean => content.subarray(0, BINARY_SNIFF_BYTES).includes(0);

/** One entry of `git diff-tree --raw -z` / `git diff --raw -z` output. */
export interface RawDiffEntry {
    newMode: string;
    newOid: string;
    newPath: string;
    oldMode: string;
    oldOid: string;
    /** Same as `newPath` unless the entry is a rename or copy. */
    oldPath: string;
    /** First letter of the status (`A`, `M`, `R`, …); the similarity score is dropped. */
    status: string;
}

/**
 * Parse NUL-separated `--raw -z` diff output. Each record is
 * `:&lt;old mode> &lt;new mode> &lt;old oid> &lt;new oid> &lt;status>\0&lt;path>\0`, with a
 * second path for renames and copies.
 */
export const parseRawDiff = (stdout: string): RawDiffEntry[] => {
    const fields = stdout.split("\0");
    const entries: RawDiffEntry[] = [];
    let index = 0;

    while (index < fields.length) {
        const header = fields[index];

        index += 1;

        if (!header?.startsWith(":")) {
            continue;
        }

        const [oldMode = "", newMode = "", oldOid = "", newOid = "", rawStatus = ""] = header.slice(1).split(" ");
        const status = rawStatus.charAt(0);
        const firstPath = fields[index] ?? "";

        index += 1;

        let secondPath = firstPath;

        if (status === "R" || status === "C") {
            secondPath = fields[index] ?? "";
            index += 1;
        }

        entries.push({ newMode, newOid, newPath: secondPath, oldMode, oldOid, oldPath: firstPath, status });
    }

    return entries;
};

/** Outcome of reading one blob through {@link GitBlobReader}. */
export type BlobReadResult = { content: Buffer; kind: "ok" } | { kind: "missing" } | { kind: "too-large"; size: number };

interface PendingRead {
    oid: string;
    reject: (error: Error) => void;
    resolve: (result: BlobReadResult) => void;
}

/**
 * Streams blobs out of a single long-lived `git cat-file --batch` process.
 *
 * Reading by object id never runs textconv or smudge filters, so the bytes
 * scanned are exactly the bytes committed. The batch header carries the size,
 * which lets an oversized blob be discarded without buffering it.
 *
 * `cat-file --batch` answers `&lt;oid> missing` both for an absent object and
 * for one it cannot read (corrupt or permission denied), so a `missing`
 * answer is double-checked with `cat-file -e`: only a clean exit 1 counts as
 * a missing blob, and anything else is raised as a git failure.
 *
 * Reads must be awaited one at a time.
 */
export class GitBlobReader {
    readonly #child: ChildProcessWithoutNullStreams;

    readonly #cwd: string;

    readonly #maxBytes: number;

    #buffered: Buffer[] = [];

    /** Body bytes (plus the trailing LF) still owed by the current answer. */
    #bodyRemaining = 0;

    #bodyChunks: Buffer[] | undefined;

    #discardedSize = 0;

    #failure: Error | undefined;

    #pending: PendingRead | undefined;

    #stderr = "";

    public constructor(cwd: string, maxBytes: number) {
        this.#cwd = cwd;
        this.#maxBytes = maxBytes;
        this.#child = spawn("git", [...GIT_CONFIG_OVERRIDES, "cat-file", "--batch"], { cwd, env: gitEnvironment(), windowsHide: true });

        this.#child.stdout.on("data", (chunk: Buffer) => {
            this.#onData(chunk);
        });
        this.#child.stderr.on("data", (chunk: Buffer) => {
            this.#stderr += chunk.toString("utf8");
        });
        this.#child.on("error", (error) => {
            this.#fail(error);
        });
        this.#child.on("close", (code) => {
            this.#fail(new Error(`git cat-file --batch exited unexpectedly (code ${String(code)}): ${this.#stderr.trim()}`));
        });
        // A write after the process died surfaces through `close`/`error`.
        this.#child.stdin.on("error", () => {});
    }

    public async read(oid: string): Promise<BlobReadResult> {
        if (this.#failure) {
            throw this.#failure;
        }

        const result = await new Promise<BlobReadResult>((resolve, reject) => {
            this.#pending = { oid, reject, resolve };
            this.#child.stdin.write(`${oid}\n`);
        });

        if (result.kind === "missing") {
            await this.#confirmMissing(oid);
        }

        return result;
    }

    public close(): void {
        this.#failure ??= new Error("git blob reader closed");
        this.#child.removeAllListeners("close");
        this.#child.stdin.end();
    }

    async #confirmMissing(oid: string): Promise<void> {
        try {
            await runGit(["cat-file", "-e", oid], this.#cwd);
        } catch (error) {
            const { code, stderr } = error as { code?: unknown; stderr?: unknown };

            if (code === 1 && (typeof stderr !== "string" || stderr.trim() === "")) {
                return;
            }

            throw new Error(`git could not read object ${oid}: ${typeof stderr === "string" ? stderr.trim() : String(error)}`, { cause: error });
        }

        // `-e` succeeded, so the object exists but `--batch` could not read it.
        throw new Error(`git could not read object ${oid}: ${this.#stderr.trim() || "object exists but is unreadable"}`);
    }

    #fail(error: Error): void {
        this.#failure ??= error;

        const pending = this.#pending;

        this.#pending = undefined;
        pending?.reject(this.#failure);
    }

    #settle(result: BlobReadResult): void {
        const pending = this.#pending;

        this.#pending = undefined;
        pending?.resolve(result);
    }

    #onData(chunk: Buffer): void {
        let rest: Buffer = chunk;

        while (rest.length > 0) {
            if (this.#bodyRemaining > 0) {
                rest = this.#consumeBody(rest);

                continue;
            }

            const joined = Buffer.concat([...this.#buffered, rest]);
            const newline = joined.indexOf(10);

            if (newline === -1) {
                this.#buffered = [joined];

                return;
            }

            this.#buffered = [];
            rest = joined.subarray(newline + 1);
            this.#startAnswer(joined.subarray(0, newline).toString("utf8"));
        }
    }

    #startAnswer(header: string): void {
        if (header.endsWith(" missing")) {
            this.#settle({ kind: "missing" });

            return;
        }

        const size = Number(header.split(" ")[2]);

        if (!Number.isFinite(size)) {
            this.#fail(new Error(`unexpected git cat-file header: ${header}`));

            return;
        }

        // `size` body bytes followed by one LF.
        this.#bodyRemaining = size + 1;

        if (size > this.#maxBytes) {
            this.#bodyChunks = undefined;
            this.#discardedSize = size;
        } else {
            this.#bodyChunks = [];
        }
    }

    #consumeBody(chunk: Buffer): Buffer {
        const take = Math.min(chunk.length, this.#bodyRemaining);

        this.#bodyChunks?.push(chunk.subarray(0, take));
        this.#bodyRemaining -= take;

        if (this.#bodyRemaining === 0) {
            if (this.#bodyChunks === undefined) {
                this.#settle({ kind: "too-large", size: this.#discardedSize });
            } else {
                const body = Buffer.concat(this.#bodyChunks);

                this.#settle({ content: body.subarray(0, -1), kind: "ok" });
            }

            this.#bodyChunks = undefined;
        }

        return chunk.subarray(take);
    }
}
