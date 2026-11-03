// Prologue and epilogue shared by every multi-file scan (`scanDetailed`,
// `scanFilesDetailed`, and the git history / staged scans).

import { warnOnSkippedRules } from "./diagnostics";
import type { SuppressionContext } from "./pipeline";
import { createSuppressionContext } from "./pipeline";
import type { PreparedScan } from "./prepare-scan";
import { prepareScan } from "./prepare-scan";
import type { Finding, GitleaksIgnoreEntry, ScanOptions, SuppressedFinding } from "./types";

export interface ScanSession {
    context: SuppressionContext;
    prepared: PreparedScan;
}

/**
 * Prepare a scan: resolve the config, print skipped-rule diagnostics under
 * `verbose`, and build the per-scan suppression state. `bases` are the
 * directories a relative `finding.file` may be relative to.
 */
export const beginScan = async (options: ScanOptions | undefined, bases: ReadonlyArray<string>): Promise<ScanSession> => {
    const prepared = prepareScan(options);

    if (options?.verbose) {
        await warnOnSkippedRules(prepared.nativeOptions);
    }

    return { context: await createSuppressionContext(options, bases), prepared };
};

export interface FinishResultOptions {
    /** Report unused commit-scoped `.gitleaksignore` entries too (git history scans). */
    includeCommitEntries?: boolean;
}

/** Assemble a scan result, adding the `.gitleaksignore` entries nothing matched. */
export const finishResult = <F extends Finding, S>(
    processed: { findings: F[]; suppressed: SuppressedFinding<F>[] },
    skipped: S[],
    context: SuppressionContext,
    options: FinishResultOptions = {},
): { findings: F[]; skipped: S[]; suppressed: SuppressedFinding<F>[]; unusedIgnores: GitleaksIgnoreEntry[] } => {
    return {
        findings: processed.findings,
        skipped,
        suppressed: processed.suppressed,
        unusedIgnores: context.ignore?.unused({ includeCommitEntries: options.includeCommitEntries === true }) ?? [],
    };
};
