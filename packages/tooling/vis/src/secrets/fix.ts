// Working-tree secret rewrites. `--fix` replaces only the byte span the scanner
// identified as the secret, so BOMs, CRLFs and all surrounding file bytes survive
// untouched. Findings without a trustworthy span are skipped, never guessed from
// the line/column reported for humans.
//
// NOTE: node:fs and node:path are used directly because CerebroFs has no
// lstat/chmod/rename or atomic byte-level write, and @visulima/path rewrites a
// literal backslash in a POSIX file name into a separator, which would aim a
// rewrite at a different file than the one scanned.
// No secret value is ever formatted into a message here.

import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Finding, SourceSpan } from "@visulima/secret-scanner";

/** Fixed-length stand-ins: never derive them from the secret being replaced. */
export const FIX_MASK = "********";
export const FIX_REPLACEMENT = "<REDACTED>";

const REPLACEMENT_BYTES = Buffer.from(FIX_REPLACEMENT, "utf8");

export interface FixSkip {
    file: string;
    line: number;
    reason: string;
    ruleId: string;
}

export interface FixEdit {
    file: string;
    line: number;
    ruleId: string;
}

export interface FixResult {
    changedFiles: number;
    edits: FixEdit[];
    replacements: number;
    skipped: FixSkip[];
}

interface FileBytes {
    bytes: Buffer;
    dev: number;
    gid: number;
    ino: number;
    mode: number;
    mtimeMs: number;
    size: number;
    uid: number;
}

interface UnreadableFile {
    reason: string;
}

/** A secret span accepted for rewriting; `end` and `start` are byte offsets into the file. */
interface AcceptedSpan {
    end: number;
    ruleId: string;
    start: number;
}

/** One or more overlapping accepted spans, replaced together exactly once. */
interface Replacement {
    end: number;
    ruleIds: Set<string>;
    start: number;
}

interface AcceptedFile {
    file: FileBytes;
    spans: AcceptedSpan[];
}

type Resolved = { display: string; file: FileBytes; path: string } | { display: string; reason: string };

const isOutside = (base: string, path: string): boolean => {
    const within = relative(base, path);

    return within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within);
};

const lineAt = (bytes: Buffer, offset: number): number => {
    let line = 1;

    for (let index = 0; index < offset; index++) {
        if (bytes[index] === 0x0a) {
            line++;
        }
    }

    return line;
};

/** Replace atomically, in the same directory, keeping the original permission bits. */
const atomicWrite = (path: string, bytes: Buffer, { gid, mode, uid }: Pick<FileBytes, "gid" | "mode" | "uid">): void => {
    const temporary = join(dirname(path), `.${basename(path)}.vis-fix-${process.pid}-${randomUUID()}`);

    try {
        const descriptor = openSync(temporary, "wx", mode);

        try {
            const created = fstatSync(descriptor);

            // The replacement is a new inode: keep the original owner and group, so the
            // mode bits grant access to the same people. When that is not permitted the
            // write fails and the file is left as it was.
            if (created.uid !== uid || created.gid !== gid) {
                fchownSync(descriptor, uid, gid);
            }

            fchmodSync(descriptor, mode);
            writeFileSync(descriptor, bytes);
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }

        renameSync(temporary, path);
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
};

const displayPath = (root: string, path: string): string => relative(root, path) || path;

/** Read a file we are willing to rewrite, or say why not. */
const snapshotRegularFile = (path: string): FileBytes | UnreadableFile => {
    try {
        const stat = lstatSync(path);

        if (stat.isSymbolicLink()) {
            return { reason: "symbolic link" };
        }

        if (!stat.isFile()) {
            return { reason: "not a regular file" };
        }

        if (stat.nlink > 1) {
            return { reason: "hard-linked file" };
        }

        // A read-only file is a deliberate guard; a rename would silently bypass it.
        // eslint-disable-next-line no-bitwise -- permission bits are a mask
        if ((stat.mode & 0o222) === 0) {
            return { reason: "read-only file" };
        }

        return { bytes: readFileSync(path), dev: stat.dev, gid: stat.gid, ino: stat.ino, mode: stat.mode % 0o1_0000, mtimeMs: stat.mtimeMs, size: stat.size, uid: stat.uid };
    } catch {
        return { reason: "file unavailable" };
    }
};

/** Re-check the file we validated before replacing it, so concurrent edits lose. */
const isUnchanged = (path: string, file: FileBytes): boolean => {
    try {
        const current = snapshotRegularFile(path);

        return (
            !("reason" in current)
            && realpathSync(path) === path
            && current.dev === file.dev
            && current.ino === file.ino
            && current.mode === file.mode
            && current.uid === file.uid
            && current.gid === file.gid
            && current.size === file.size
            && current.mtimeMs === file.mtimeMs
            && current.bytes.equals(file.bytes)
        );
    } catch {
        return false;
    }
};

const isSpanInFile = ({ matchEnd, matchStart, secretEnd, secretStart }: SourceSpan, bytes: Buffer, secret: Buffer): boolean =>
    Number.isInteger(matchStart)
    && Number.isInteger(matchEnd)
    && Number.isInteger(secretStart)
    && Number.isInteger(secretEnd)
    && matchStart >= 0
    && secretStart >= matchStart
    && secretEnd > secretStart
    && secretEnd <= matchEnd
    && matchEnd <= bytes.length
    && bytes.subarray(secretStart, secretEnd).equals(secret);

/** Merge overlapping or identical spans into their union, so a longer secret never leaves a tail. */
const unionSpans = (spans: AcceptedSpan[]): Replacement[] => {
    const merged: Replacement[] = [];

    for (const { end, ruleId, start } of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
        const last = merged.at(-1);

        if (last !== undefined && start < last.end) {
            last.end = Math.max(last.end, end);
            last.ruleIds.add(ruleId);
        } else {
            merged.push({ end, ruleIds: new Set([ruleId]), start });
        }
    }

    return merged;
};

const replaceSpans = (bytes: Buffer, replacements: Replacement[]): Buffer => {
    const parts: Buffer[] = [];
    let cursor = 0;

    for (const { end, start } of replacements) {
        parts.push(bytes.subarray(cursor, start), REPLACEMENT_BYTES);
        cursor = end;
    }

    parts.push(bytes.subarray(cursor));

    return Buffer.concat(parts);
};

/**
 * Findings are relative to `scanRoot` (the one positional path, or the workspace):
 * a file passed directly is reported as `""`, a directory's children relative to it.
 */
export const fixSecrets = (findings: Finding[], root: string, dryRun: boolean, scanRoot: string = root): FixResult => {
    const skipped: FixSkip[] = [];
    const accepted = new Map<string, AcceptedFile>();
    const files = new Map<string, FileBytes | UnreadableFile>();
    const absoluteScanRoot = resolve(root, scanRoot);
    // A symlinked parent would make a lexically contained path point outside the
    // workspace. Compare real paths before reading or replacing anything.
    let canonicalRoot: string;

    try {
        canonicalRoot = realpathSync(root);
    } catch {
        canonicalRoot = root;
    }

    const resolveTarget = (file: string): Resolved => {
        const path = resolve(absoluteScanRoot, file);
        const display = displayPath(root, path);

        if (isOutside(root, path)) {
            return { display, reason: "outside workspace" };
        }

        let realPath: string;

        try {
            // Check the final component before canonicalising: a symlink must
            // stay a link, even when its target is inside the workspace.
            if (lstatSync(path).isSymbolicLink()) {
                return { display, reason: "symbolic link" };
            }

            realPath = realpathSync(path);
        } catch {
            return { display, reason: "file unavailable" };
        }

        if (isOutside(canonicalRoot, realPath)) {
            return { display, reason: "outside workspace" };
        }

        let snapshot = files.get(realPath);

        if (snapshot === undefined) {
            snapshot = snapshotRegularFile(realPath);
            files.set(realPath, snapshot);
        }

        return "reason" in snapshot ? { display, reason: snapshot.reason } : { display, file: snapshot, path: realPath };
    };

    for (const finding of findings) {
        if (finding.sourceSpan === undefined) {
            skipped.push({ file: finding.file, line: finding.startLine, reason: finding.spanUnavailableReason ?? "no trusted byte span", ruleId: finding.ruleId });

            continue;
        }

        const resolved = resolveTarget(finding.file);

        // A composite's dependencies are rewritten like the finding itself.
        for (const target of [finding, ...(finding.requiredFindings ?? [])]) {
            const skip = (reason: string, file: string): void => {
                skipped.push({ file, line: target.startLine, reason, ruleId: target.ruleId });
            };
            const { sourceSpan: span } = target;

            if (span === undefined) {
                skip(target.spanUnavailableReason ?? "no trusted byte span", finding.file);

                continue;
            }

            if (target.secret.length === 0) {
                skip("empty secret", finding.file);

                continue;
            }

            if ("reason" in resolved) {
                skip(resolved.reason, resolved.display);

                continue;
            }

            if (!isSpanInFile(span, resolved.file.bytes, Buffer.from(target.secret, "utf8"))) {
                skip("span does not match file", resolved.display);

                continue;
            }

            const entry = accepted.get(resolved.path) ?? { file: resolved.file, spans: [] };

            entry.spans.push({ end: span.secretEnd, ruleId: target.ruleId, start: span.secretStart });
            accepted.set(resolved.path, entry);
        }
    }

    const edits: FixEdit[] = [];
    let changedFiles = 0;
    let replacements = 0;

    for (const [path, { file, spans }] of accepted) {
        const merged = unionSpans(spans);
        const display = displayPath(root, path);
        const located = merged.map(({ ruleIds, start }) => {
            return { line: lineAt(file.bytes, start), ruleIds };
        });

        if (!dryRun) {
            let failureReason: string | undefined;

            if (isUnchanged(path, file)) {
                try {
                    atomicWrite(path, replaceSpans(file.bytes, merged), file);
                } catch {
                    failureReason = "write failed";
                }
            } else {
                failureReason = "file changed during scan";
            }

            if (failureReason !== undefined) {
                for (const { line, ruleIds } of located) {
                    skipped.push({ file: display, line, reason: failureReason, ruleId: [...ruleIds].sort().join(", ") });
                }

                continue;
            }
        }

        changedFiles++;
        replacements += merged.length;

        const byLine = new Map<number, Set<string>>();

        for (const { line, ruleIds } of located) {
            byLine.set(line, new Set([...(byLine.get(line) ?? []), ...ruleIds]));
        }

        for (const [line, ruleIds] of byLine) {
            edits.push({ file: display, line, ruleId: [...ruleIds].sort().join(", ") });
        }
    }

    edits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    skipped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.reason.localeCompare(b.reason));

    return { changedFiles, edits, replacements, skipped };
};
