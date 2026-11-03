import { realpathSync } from "node:fs";

import { isAccessibleSync, readJsonSync } from "@visulima/fs";
import { isAbsolute, relative, resolve } from "@visulima/path";
import type { Finding } from "@visulima/secret-scanner";
import { baselineKeys, fingerprint, legacyFingerprint, wholeMatchFingerprint } from "@visulima/secret-scanner";

import { writeReportFileSync } from "./secure-write";

const toRelative = (file: string, root: string): string => {
    if (!isAbsolute(file)) {
        return file;
    }

    const rel = relative(root, file);

    return rel === "" || rel.startsWith("..") ? file : rel;
};

const realOrSelf = (path: string): string => {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
};

/** `absolute` relative to `base`, or `absolute` itself when it lies outside `base`. */
const relativeInside = (base: string, absolute: string): string => {
    const rel = relative(base, absolute);

    return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? absolute : rel;
};

/** Convert a finding to the shape we persist in baselines (with paths relative to root). */
export const toRelativeFinding = (f: Finding, root: string): Finding => {
    const relativeFile = toRelative(f.file, root);

    return relativeFile === f.file ? f : { ...f, file: relativeFile };
};

const readBaseline = (baselinePath: string): Finding[] => {
    if (!isAccessibleSync(baselinePath)) {
        return [];
    }

    try {
        const parsed = readJsonSync(baselinePath) as unknown;

        return Array.isArray(parsed) ? (parsed as Finding[]) : [];
    } catch {
        return [];
    }
};

/**
 * Rewrite a finding whose `file` is relative to `base` (the scanner reports
 * staged and file-list scans relative to the process cwd) so it is relative
 * to `root`, like every other finding vis reports.
 */
export const rebaseFinding = <F extends Finding>(finding: F, base: string, root: string): F => {
    const absolute = isAbsolute(finding.file) ? finding.file : resolve(base, finding.file);
    const file = relativeInside(realOrSelf(root), absolute);

    return file === finding.file ? finding : { ...finding, file };
};

/**
 * The baseline at `baselinePath` (paths relative to `root`) with every entry
 * also listed under its path relative to `base`, for a scan whose findings
 * the scanner reports relative to `base`. Without it, running from a
 * subdirectory would match no baseline entry.
 */
export const rebaseBaseline = (baselinePath: string, root: string, base: string): Finding[] => {
    const realRoot = realOrSelf(root);
    const realBase = realOrSelf(base);

    return readBaseline(baselinePath).flatMap((entry) => {
        const file = relativeInside(realBase, isAbsolute(entry.file) ? entry.file : resolve(realRoot, entry.file));

        return file === entry.file ? [entry] : [entry, { ...entry, file }];
    });
};

/** The keys a baseline entry suppresses under, as the scanner indexes a baseline file. */
const entryKeys = (entry: Finding): string[] => [
    fingerprint({ ...entry, secret: typeof entry.secret === "string" ? entry.secret : "" }),
    legacyFingerprint(entry),
];

export interface BaselineDiff {
    fresh: Finding[];
    resolved: Finding[];
    surviving: Finding[];
}

/** Compare current findings against an existing baseline. */
export const diffBaseline = (findings: Finding[], baselinePath: string, root: string): BaselineDiff => {
    const existing = readBaseline(baselinePath).map((f) => toRelativeFinding(f, root));
    // Match as the scanner suppresses: content hash, line-based legacy form, and
    // the whole match as the secret (entries written before secret-group parity).
    const existingKeys = new Set(existing.flatMap((f) => entryKeys(f)));
    const currentRelative = findings.map((f) => toRelativeFinding(f, root));
    const currentKeys = new Set(currentRelative.flatMap((f) => baselineKeys(f)));
    const isKnown = (f: Finding): boolean => baselineKeys(f).some((key) => existingKeys.has(key));

    return {
        fresh: currentRelative.filter((f) => !isKnown(f)),
        resolved: existing.filter((f) => !entryKeys(f).some((key) => currentKeys.has(key))),
        surviving: currentRelative.filter((f) => isKnown(f)),
    };
};

export interface WriteBaselineOptions {
    /** If true, replace the file instead of merging with existing entries. */
    replace?: boolean;

    /**
     * The findings hold real secrets (no `--redact`): write the file 0600.
     * Default `true`.
     */
    sensitive?: boolean;
}

/**
 * Write `findings` to `baselinePath` with paths relative to `root`. By default
 * merges with any existing baseline (so prior triage decisions for files not
 * rescanned this run are preserved). Pass `replace: true` to overwrite.
 */
export const writeBaseline = (findings: Finding[], baselinePath: string, root: string, options: WriteBaselineOptions = {}): number => {
    const incoming = findings.map((f) => toRelativeFinding(f, root));
    let final: Finding[];

    if (options.replace) {
        final = incoming;
    } else {
        // Incoming findings supersede entries that recorded the same finding with the
        // whole match as its secret (written before secret-group parity).
        const superseded = new Set(incoming.filter((f) => f.secret !== f.match).map((f) => wholeMatchFingerprint(f)));
        const existing = readBaseline(baselinePath)
            .map((f) => toRelativeFinding(f, root))
            .filter((f) => !superseded.has(fingerprint(f)));
        const seen = new Set<string>();

        final = [];

        for (const f of [...existing, ...incoming]) {
            const key = fingerprint(f);

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            final.push(f);
        }
    }

    writeReportFileSync(baselinePath, `${JSON.stringify(final, null, 4)}\n`, options.sensitive ?? true);

    return final.length;
};
