// @visulima/secret-scanner — entry module.
//
// Only responsibilities here:
//   1. Public surface re-exports (types, fingerprint, ruleset helpers, …).
//   2. The three top-level scan orchestrators — `scan`, `scanFiles`,
//      `scanString` — that thread `prepareScan` → native binding →
//      `postProcessDetailed`.
//
// Everything else lives in a dedicated module. Keep this file thin so
// consumers see the public surface at a glance and contributors know where
// to go for each concern (`baseline.ts`, `pipeline.ts`, `validator/`, …).

import { resolve } from "node:path";

import { binding } from "./binding";
import { resolveConfig } from "./config-loader";
import { buildIgnoreMatcher, filterIgnoredFiles } from "./ignore-matcher";
import { postProcessDetailed } from "./pipeline";
import { prepareScan } from "./prepare-scan";
import { beginScan, finishResult } from "./scan-session";
import type { ValidatorReport } from "./transports";
import { reportValidators } from "./transports";
import type { Finding, RuleInfo, ScanOptions, ScanResult, SkippedRule } from "./types";

/** Return any rules from the given config that failed to compile, with the reason. */
export const inspectRuleset = async (options?: ScanOptions): Promise<SkippedRule[]> => {
    const prepared = prepareScan(options);

    return binding.inspectRuleset(prepared.nativeOptions);
};

/** Return metadata for every compiled rule in the effective config. */
export const listRules = async (options?: ScanOptions): Promise<RuleInfo[]> => {
    const prepared = prepareScan(options);

    return binding.listRules(prepared.nativeOptions) as RuleInfo[];
};

/**
 * Discover every tag (preset/category) present in the effective ruleset, with
 * the number of rules carrying each. Lets a CLI build a `--list-presets` /
 * `--list-tags` UX without hand-rolling the aggregation, and mirrors the tags
 * accepted by the `tag:&lt;name>` selectors in `rules.enable`/`include`/`exclude`.
 * Sorted by descending rule count, then tag name for stable output.
 *
 * Derived from the resolved gitleaks-shaped config (the same source
 * `tag:` selectors expand against) — not the native `listRules()`, whose
 * `RuleInfo.tags` is not populated for the bundled set.
 */
export const listTags = (options?: ScanOptions): { count: number; tag: string }[] => {
    const resolved = resolveConfig({
        config: options?.config?.inline,
        configPath: options?.config?.path,
        extendBundled: options?.config?.extendBundled,
    });
    const counts = new Map<string, number>();

    for (const rule of resolved.rules ?? []) {
        // eslint-disable-next-line sonarjs/different-types-comparison -- Defensive: `rule` is typed `GitleaksRule` but the underlying config holds `unknown` at runtime; guard against `null` slipping through.
        if (typeof rule !== "object" || rule === null) {
            continue;
        }

        const { tags } = rule as { tags?: unknown };

        if (!Array.isArray(tags)) {
            continue;
        }

        for (const tag of tags) {
            if (typeof tag === "string") {
                counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
        }
    }

    return [...counts.entries()]
        .map(([tag, count]) => {
            return { count, tag };
        })
        .toSorted((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

/**
 * Report every non-HTTP validator type that appears in the current ruleset,
 * along with the optional peer-dep users need to install to verify findings
 * from those rules. Returns an empty array when the ruleset has no validators
 * beyond HTTP/JWT (the built-ins). Ideal for a `--list-validators` CLI pass
 * or a CI pre-flight check.
 */
export const listRequiredValidators = async (options?: ScanOptions): Promise<ValidatorReport[]> => {
    const resolved = resolveConfig({
        config: options?.config?.inline,
        configPath: options?.config?.path,
        extendBundled: options?.config?.extendBundled,
    });
    // eslint-disable-next-line sonarjs/different-types-comparison -- Defensive: `rule` is typed `GitleaksRule` but the underlying array holds `unknown` at runtime; guard against `null` slipping through.
    const rulesArray = (resolved.rules ?? []).filter((rule): rule is { validation?: unknown } => typeof rule === "object" && rule !== null);

    return reportValidators(rulesArray);
};

/**
 * Scan the given paths for secrets and report everything a caller needs to
 * tell a clean scan from an incomplete one: `skipped` lists files and
 * directories that could not be read (permission denied, I/O error, larger
 * than `walk.maxFileSize`), `suppressed` the findings a baseline, allowlist,
 * inline pragma or `.gitleaksignore` hid (with `reportSuppressed`), and
 * `unusedIgnores` the `.gitleaksignore` entries nothing matched.
 */
export const scanDetailed = async (paths: string[], options?: ScanOptions): Promise<ScanResult> => {
    const { context, prepared } = await beginScan(
        options,
        paths.map((path) => resolve(path)),
    );
    const report = await binding.scanDetailed(paths, prepared.nativeOptions);

    return finishResult(await postProcessDetailed(report, prepared, options, context), report.skipped, context);
};

/** Scan the given paths for secrets. Runs the detector on a Rust thread pool. */
export const scan = async (paths: string[], options?: ScanOptions): Promise<Finding[]> => {
    const result = await scanDetailed(paths, options);

    return result.findings;
};

/**
 * Like {@link scanFiles}, with the diagnostics of {@link scanDetailed}. A listed
 * file that doesn't exist, is a broken symlink or can't be read lands in `skipped`.
 */
export const scanFilesDetailed = async (files: string[], options?: ScanOptions): Promise<ScanResult> => {
    const { context, prepared } = await beginScan(options, [process.cwd()]);
    const matcher = buildIgnoreMatcher(options);
    const filteredFiles = filterIgnoredFiles(files, matcher, process.cwd());
    const report = await binding.scanFilesDetailed(filteredFiles, prepared.nativeOptions);

    return finishResult(await postProcessDetailed(report, prepared, options, context), report.skipped, context);
};

/**
 * Scan a fixed list of files (e.g. output of `git diff --name-only`). Bypasses
 * the native walker, so `walk.excludePatterns` / `walk.excludeFromFiles` are
 * honoured here in JS via the `ignore` package.
 */
export const scanFiles = async (files: string[], options?: ScanOptions): Promise<Finding[]> => {
    const result = await scanFilesDetailed(files, options);

    return result.findings;
};

export { buildBaselineSet, createBaseline, loadBaselineSet, resolveBaselineSet, writeBaseline, type WriteBaselineOptions } from "./baseline";
export { bundledConfigPath, type GitleaksConfig } from "./config-loader";
export { CONFIDENCE_LEVELS, DEFAULT_MAX_FILE_SIZE, MAX_ARCHIVE_DEPTH } from "./constants";
export { baselineKeys, fingerprint, gitleaksIgnoreFingerprint, legacyFingerprint, wholeMatchFingerprint } from "./fingerprint";
export { DIFF_HARDENING_FLAGS, GIT_CONFIG_OVERRIDES } from "./git-command";
export {
    type GitCommitInfo,
    type GitFinding,
    type GitScanOptions,
    type GitScanResult,
    type GitSkippedBlob,
    type GitSkipReason,
    type GitStagedScanOptions,
    scanGitHistory,
    scanGitHistoryDetailed,
    scanGitStaged,
} from "./git-scan";
export { isLockFile, isNotAlphanumericString, isPotentialUuid, isSequentialString } from "./heuristics";
export { type SarifLog, toSarif, type ToSarifOptions, toSarifUri } from "./sarif";
export { scanString } from "./scan-string";
export { transformYamlBlockScalars } from "./transformers/yaml";
export type { ValidatorReport } from "./transports";
export type {
    Confidence,
    Finding,
    GitleaksIgnoreEntry,
    RequiredFinding,
    RuleInfo,
    ScanOptions,
    ScanResult,
    SkippedFile,
    SkippedRule,
    SkipReason,
    SuppressedFinding,
    SuppressionReason,
    ValidationStatus,
} from "./types";
