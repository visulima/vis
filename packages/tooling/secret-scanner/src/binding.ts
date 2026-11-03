// Native NAPI binding loader.
//
// The napi-generated `index.js` at the package root handles platform-binding
// selection via the `@visulima/secret-scanner-binding-*` optionalDependencies.
// `loadNativeRootBinding` requires it from the package root, walking up so the
// reference survives however a bundler (Vite, packem, Rollup) nests this module
// under dist/.

import type * as Native from "../index.js";
import loadNativeRootBinding from "./load-native-root-binding";
import type { Finding, SkippedFile, SuppressedFinding } from "./types";

const native = loadNativeRootBinding(import.meta.url) as typeof Native;

/** What a native scan returns: active findings, suppressed ones (with `reportSuppressed`) and unreadable files. */
export interface NativeReport {
    findings: Finding[];
    skipped: SkippedFile[];
    /** Allowlisted / inline-allowed matches; empty unless `reportSuppressed`. */
    suppressed: SuppressedFinding[];
}

/** Types native output into the public shapes; native already splits active, suppressed and skipped. */
const toNativeReport = (report: Native.ScanReport): NativeReport => {
    return {
        findings: report.findings as Finding[],
        skipped: report.skipped as SkippedFile[],
        suppressed: report.suppressed as SuppressedFinding[],
    };
};

/** The native binding, with every scan returning a {@link NativeReport}. */
export const binding = {
    inspectRuleset: native.inspectRuleset,
    listRules: native.listRules,
    scanDetailed: async (paths: string[], options: Native.ScanOptions): Promise<NativeReport> => toNativeReport(await native.scanDetailed(paths, options)),
    scanFilesDetailed: async (files: string[], options: Native.ScanOptions): Promise<NativeReport> =>
        toNativeReport(await native.scanFilesDetailed(files, options)),
    scanTextSync: (content: string, file: string, options: Native.ScanOptions): NativeReport => toNativeReport(native.scanTextSync(content, file, options)),
};

export type * as Native from "../index.js";
