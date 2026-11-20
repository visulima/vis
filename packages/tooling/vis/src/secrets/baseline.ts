import { realpathSync } from "node:fs";

import { isAccessibleSync, readJsonSync } from "@visulima/fs";
import { isAbsolute, relative, resolve } from "@visulima/path";
import type { Finding } from "@visulima/secret-scanner";
import { baselineKeys, fingerprint, legacyFingerprint, maskFinding, wholeMatchFingerprint } from "@visulima/secret-scanner";

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

/**
 * Every key a finding matches under: as given and masked. The scanner reports
 * masked findings by default, so a baseline written with real values (before
 * masking became the default) and one written from masked output both match.
 */
const matchKeys = (finding: Finding): string[] => [...baselineKeys(finding), ...baselineKeys(maskFinding(finding))];

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** An entry read from a baseline file only needs `ruleId`, `file` and `startLine`; fill in the strings masking reads. */
const normaliseEntry = (entry: Finding): Finding => {
    const normalised: Finding = { ...entry, match: asString(entry.match), secret: asString(entry.secret) };

    if (Array.isArray(entry.requiredFindings)) {
        normalised.requiredFindings = entry.requiredFindings.map((required) => {
            return { ...required, match: asString(required.match), secret: asString(required.secret) };
        });
    } else {
        delete normalised.requiredFindings;
    }

    return normalised;
};

const maskEntry = (entry: Finding): Finding => maskFinding(normaliseEntry(entry));

/** The keys a baseline entry suppresses under, as the scanner indexes a baseline file. */
const entryKeys = (entry: Finding): string[] => [fingerprint(normaliseEntry(entry)), legacyFingerprint(entry), fingerprint(maskEntry(entry))];

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
    const currentKeys = new Set(currentRelative.flatMap((f) => matchKeys(f)));
    const isKnown = (f: Finding): boolean => matchKeys(f).some((key) => existingKeys.has(key));

    return {
        fresh: currentRelative.filter((f) => !isKnown(f)),
        resolved: existing.filter((f) => !entryKeys(f).some((key) => currentKeys.has(key))),
        surviving: currentRelative.filter((f) => isKnown(f)),
    };
};

export interface WriteBaselineOptions {
    /** If true, replace the file instead of merging with existing entries. */
    replace?: boolean;
}

/** Identity of a baseline entry regardless of masking, so a real-value entry and its masked rescan are one. */
const maskedFingerprint = (entry: Finding): string => fingerprint(maskEntry(entry));

/** Whether an entry's secret is already a mask. A real value can only be told apart from another by its real fingerprint. */
const isMaskedEntry = (entry: Finding): boolean => {
    const secret = asString(entry.secret);

    return maskEntry(entry).secret === secret;
};

/**
 * Write `findings` to `baselinePath` with paths relative to `root`. By default
 * merges with any existing baseline (so prior triage decisions for files not
 * rescanned this run are preserved; an existing entry wins over a rescan of
 * the same finding). Pass `replace: true` to overwrite. The file is always
 * written 0600: whether an entry still holds a real value cannot be told from
 * its text.
 */
export const writeBaseline = (findings: Finding[], baselinePath: string, root: string, options: WriteBaselineOptions = {}): number => {
    const incoming = findings.map((f) => toRelativeFinding(f, root));
    let final: Finding[];

    if (options.replace) {
        final = incoming;
    } else {
        // Incoming findings supersede entries that recorded the same finding with the
        // whole match as its secret (written before secret-group parity).
        const superseded = new Set(incoming.filter((f) => f.secret !== f.match).map((f) => wholeMatchFingerprint(maskFinding(f))));
        const existing = readBaseline(baselinePath)
            .map((f) => toRelativeFinding(f, root))
            .filter((f) => !superseded.has(maskedFingerprint(f)));
        const seenReal = new Set<string>();
        // Masked identities of every kept entry, and of the kept entries that are masks.
        const seenMasked = new Set<string>();
        const seenMaskedEntries = new Set<string>();

        final = [];

        // Two real values are the same entry only when their real fingerprints are;
        // a mask stands for any real value it could have come from.
        for (const f of [...existing, ...incoming]) {
            const realKey = fingerprint(normaliseEntry(f));
            const maskedKey = maskedFingerprint(f);
            const masked = isMaskedEntry(f);

            if (seenReal.has(realKey) || (masked ? seenMasked.has(maskedKey) : seenMaskedEntries.has(maskedKey))) {
                continue;
            }

            seenReal.add(realKey);
            seenMasked.add(maskedKey);

            if (masked) {
                seenMaskedEntries.add(maskedKey);
            }

            final.push(f);
        }
    }

    writeReportFileSync(baselinePath, `${JSON.stringify(final, null, 4)}\n`, true);

    return final.length;
};
