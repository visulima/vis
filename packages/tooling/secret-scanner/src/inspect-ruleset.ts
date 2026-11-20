import { binding } from "./binding";
import { prepareScan } from "./prepare-scan";
import type { ScanOptions, SkippedRule } from "./types";

/** Return any rules from the given config that failed to compile, with the reason. */
export const inspectRuleset = async (options?: ScanOptions): Promise<SkippedRule[]> => {
    const prepared = prepareScan(options);

    return binding.inspectRuleset(prepared.nativeOptions);
};
