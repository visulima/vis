// `scanString` lives in its own module so non-entry callers (e.g. the
// git-history scanner) can reuse it without importing `index.ts` and creating
// a circular dependency. `index.ts` re-exports it as part of the public
// surface.

import { binding } from "./binding";
import { createSuppressionContext, postProcessDetailed } from "./pipeline";
import { prepareScan } from "./prepare-scan";
import type { AllowWarning, Finding, ScanOptions } from "./types";

/**
 * Scan an in-memory buffer like `scanString`, and also return the allow markers
 * in it that name rule ids which are not active.
 */
export const scanStringDetailed = async (
    content: string,
    file: string,
    options?: ScanOptions,
): Promise<{ allowWarnings: AllowWarning[]; findings: Finding[] }> => {
    const prepared = prepareScan(options);
    const context = await createSuppressionContext(options, [process.cwd()]);
    const report = binding.scanTextSync(content, file, prepared.nativeOptions);

    const { findings } = await postProcessDetailed(report, prepared, options, context);

    return { allowWarnings: report.allowWarnings, findings };
};

/**
 * Scan an in-memory buffer as if it lived at `file`. Useful for editor
 * integrations and ad-hoc programmatic scans.
 *
 * **Note**: detection runs synchronously on the calling thread (the native
 * binding is sync for string input — scanning ~550 KB takes ~11 ms with the
 * full ~1,340-rule set). The `async` signature exists because the pipeline
 * may await validators. For large buffers on a latency-sensitive event loop
 * (HTTP server request handler, VSCode extension main thread), chunk the
 * input yourself or offload to a worker.
 */
export const scanString = async (content: string, file: string, options?: ScanOptions): Promise<Finding[]> => {
    const { findings } = await scanStringDetailed(content, file, options);

    return findings;
};
