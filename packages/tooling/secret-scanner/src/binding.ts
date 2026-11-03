// Native NAPI binding loader.
//
// The napi-generated `index.js` at the package root handles platform-binding
// selection via the `@visulima/secret-scanner-binding-*` optionalDependencies.
// `loadNativeRootBinding` requires it from the package root, walking up so the
// reference survives however a bundler (Vite, packem, Rollup) nests this module
// under dist/.

import type * as Native from "../index.js";
import loadNativeRootBinding from "./load-native-root-binding";
import type { Finding, SkippedFile, SuppressedFinding, SuppressionReason } from "./types";

const native = loadNativeRootBinding(import.meta.url) as typeof Native;

/** What a native scan returns: active findings, suppressed ones (with `reportSuppressed`) and unreadable files. */
export interface NativeReport {
    findings: Finding[];
    skipped: SkippedFile[];
    /** Allowlisted / inline-allowed matches; empty unless `reportSuppressed`. */
    suppressed: SuppressedFinding[];
}

type NativeSuppressed = Native.Finding & { suppressedBy: string };

type RawNativeReport = Native.Finding[] | { findings: Native.Finding[]; skipped: Native.SkippedFile[]; suppressed?: NativeSuppressed[] };

/**
 * The one place native output is typed into the public shapes. Accepts the
 * `{ findings, suppressed, skipped }` report, and the older shapes (a bare
 * findings array, or a report without `suppressed`) whose findings carry
 * `suppressedBy` inline.
 */
export const splitNativeReport = (raw: RawNativeReport): NativeReport => {
    const report = Array.isArray(raw) ? { findings: raw, skipped: [] } : raw;
    const skipped = report.skipped as SkippedFile[];

    if (report.suppressed !== undefined) {
        return { findings: report.findings as Finding[], skipped, suppressed: report.suppressed as SuppressedFinding[] };
    }

    const findings: Finding[] = [];
    const suppressed: SuppressedFinding[] = [];

    for (const finding of report.findings) {
        const { suppressedBy, ...rest } = finding;

        if (suppressedBy === undefined) {
            findings.push(rest as Finding);
        } else {
            suppressed.push({ ...(rest as Finding), suppressedBy: suppressedBy as SuppressionReason });
        }
    }

    return { findings, skipped, suppressed };
};

/** The native binding, with every scan returning a {@link NativeReport}. */
export const binding = {
    inspectRuleset: native.inspectRuleset,
    listRules: native.listRules,
    scanDetailed: async (paths: string[], options: Native.ScanOptions): Promise<NativeReport> => splitNativeReport(await native.scanDetailed(paths, options)),
    scanFilesDetailed: async (files: string[], options: Native.ScanOptions): Promise<NativeReport> =>
        splitNativeReport(await native.scanFilesDetailed(files, options)),
    scanTextSync: (content: string, file: string, options: Native.ScanOptions): NativeReport => splitNativeReport(native.scanTextSync(content, file, options)),
};

export type * as Native from "../index.js";
