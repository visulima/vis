// Native NAPI binding loader.
//
// The napi-generated `index.js` at the package root handles platform-binding
// selection via the `@visulima/secret-scanner-binding-*` optionalDependencies.
// `loadNativeRootBinding` requires it from the package root, walking up so the
// reference survives however a bundler (Vite, packem, Rollup) nests this module
// under dist/.

import type * as NativeBinding from "../index.js";
import loadNativeRootBinding from "./load-native-root-binding";

const native = loadNativeRootBinding(import.meta.url) as typeof NativeBinding;

// TEMP adapter: removed when the TS stream lands (restore `export type * as Native from "../index.js"`
// and `binding = native`). The native scans now return `{ findings, suppressed, skipped }`;
// this folds `suppressed` back into one list (active first, as before) for the code in
// src/ that still expects it.
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace Native {
    export type Finding = NativeBinding.Finding & { suppressedBy?: string };
    export type ScanOptions = NativeBinding.ScanOptions;
}

interface LegacyReport {
    findings: Native.Finding[];
    skipped: NativeBinding.SkippedFile[];
}

const mergeSuppressed = (report: NativeBinding.ScanReport): Native.Finding[] => [...report.findings, ...report.suppressed];

const legacyReport = (report: NativeBinding.ScanReport): LegacyReport => {
    return { findings: mergeSuppressed(report), skipped: report.skipped };
};

export const binding = {
    inspectRuleset: native.inspectRuleset,
    listRules: native.listRules,
    scanDetailed: async (...args: Parameters<typeof native.scanDetailed>): Promise<LegacyReport> => legacyReport(await native.scanDetailed(...args)),
    scanFilesDetailed: async (...args: Parameters<typeof native.scanFilesDetailed>): Promise<LegacyReport> =>
        legacyReport(await native.scanFilesDetailed(...args)),
    scanTextSync: (...args: Parameters<typeof native.scanTextSync>): Native.Finding[] => mergeSuppressed(native.scanTextSync(...args)),
};
