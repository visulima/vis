// Prologue and epilogue shared by every multi-file scan (`scanDetailed`,
// `scanFilesDetailed`, and the git history / staged scans).

import { warnOnSkippedRules } from "./diagnostics";
import { applySecretlintIgnores } from "./ignore-matcher";
import type { SuppressionContext } from "./pipeline";
import { createSuppressionContext } from "./pipeline";
import type { PreparedScan } from "./prepare-scan";
import { prepareScan } from "./prepare-scan";
import type { AllowWarning, Finding, GitleaksIgnoreEntry, ScanOptions, SuppressedFinding } from "./types";

export interface ScanSession {
    context: SuppressionContext;
    /** The options the scan runs with: `options` plus the discovered `.secretlintignore` files. */
    options: ScanOptions | undefined;
    prepared: PreparedScan;
}

/**
 * Prepare a scan: resolve the config, print skipped-rule diagnostics under
 * `verbose`, and build the per-scan suppression state. `bases` are the
 * directories a relative `finding.file` may be relative to. `ignoreRoots` are
 * where `.secretlintignore` files are discovered; git history scans omit it
 * because they read blobs rather than walk the file system.
 */
export const beginScan = async (options: ScanOptions | undefined, bases: ReadonlyArray<string>, ignoreRoots?: ReadonlyArray<string>): Promise<ScanSession> => {
    const effective = ignoreRoots === undefined ? options : applySecretlintIgnores(options, ignoreRoots);
    const prepared = prepareScan(effective);

    if (effective?.verbose) {
        await warnOnSkippedRules(prepared.nativeOptions);
    }

    return { context: await createSuppressionContext(effective, bases), options: effective, prepared };
};

export interface FinishResultOptions {
    /** Allow-marker warnings of the scan. */
    allowWarnings?: AllowWarning[];
    /** Report unused commit-scoped `.gitleaksignore` entries too (git history scans). */
    includeCommitEntries?: boolean;
}

/** Assemble a scan result, adding the `.gitleaksignore` entries nothing matched. */
export const finishResult = <F extends Finding, S>(
    processed: { findings: F[]; suppressed: SuppressedFinding<F>[] },
    skipped: S[],
    context: SuppressionContext,
    options: FinishResultOptions = {},
): { allowWarnings: AllowWarning[]; findings: F[]; skipped: S[]; suppressed: SuppressedFinding<F>[]; unusedIgnores: GitleaksIgnoreEntry[] } => {
    return {
        allowWarnings: options.allowWarnings ?? [],
        findings: processed.findings,
        skipped,
        suppressed: processed.suppressed,
        unusedIgnores: context.ignore?.unused({ includeCommitEntries: options.includeCommitEntries === true }) ?? [],
    };
};
