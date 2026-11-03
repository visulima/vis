import { resolve } from "@visulima/path";
import type { Confidence, ScanOptions } from "@visulima/secret-scanner";
import { CONFIDENCE_LEVELS, DEFAULT_MAX_FILE_SIZE, MAX_ARCHIVE_DEPTH } from "@visulima/secret-scanner";

import { VisUserError } from "../../errors/vis-user-error";
import type { ReportFormat } from "../../secrets/report";
import { isReportFormat, REPORT_FORMATS } from "../../secrets/report";

type RepeatableString = string | string[];

export interface SecretsFlags {
    affected?: boolean;
    all?: boolean;
    baseline?: string;
    concurrency?: number;
    config?: string;
    dryRun?: boolean;
    enableRule?: RepeatableString;
    exclude?: RepeatableString;
    excludeFrom?: RepeatableString;
    excludeRule?: RepeatableString;
    extendBundled?: boolean;
    failOnUnreadable?: boolean;
    failOnUnusedIgnores?: boolean;
    format?: string;
    gitignore?: boolean;
    gitleaksIgnore?: boolean;
    history?: boolean;
    historyRange?: string;
    includeHidden?: boolean;
    includeRule?: RepeatableString;
    init?: boolean;
    inlineAllow?: boolean;
    listRules?: boolean;
    listValidators?: boolean;
    logIgnored?: boolean;
    maxArchiveDepth?: number;
    maxCommits?: number;
    maxDecodeDepth?: number;
    maxSize?: number;
    minConfidence?: string;
    onlyVerified?: boolean;
    quiet?: boolean;
    redact?: boolean;
    replaceBaseline?: boolean;
    report?: RepeatableString;
    since?: string;
    staged?: boolean;
    updateBaseline?: boolean;
    validate?: boolean;
    verbose?: boolean;
}

export interface VisSecretsConfig {
    baseline?: string;
    config?: ScanOptions["config"] & {
        /**
         * Bundled rule-tag presets to enable in addition to the defaults.
         * Each entry expands to a `tag:preset:&lt;name>` enable filter, so
         * the same opt-in groups exposed by `--enable-rule` can be set
         * once in `vis.config.ts` instead of being repeated per
         * invocation.
         */
        presets?: string[];
    };
    redact?: boolean;
    rules?: { enable?: string[]; exclude?: string[]; include?: string[] };
    walk?: {
        excludeFromFiles?: string[];
        excludePatterns?: string[];
        gitignore?: boolean;
        includeHidden?: boolean;
        maxFileSize?: number;
    };
}

export const toArray = (value: RepeatableString | undefined): string[] => {
    if (!value) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
};

export const validateFormat = (raw: string | undefined): ReportFormat => {
    if (raw === undefined) {
        return "text";
    }

    if (!isReportFormat(raw)) {
        throw new VisUserError(`--format must be one of: ${REPORT_FORMATS.join(", ")} (got "${raw}")`);
    }

    return raw;
};

const validateDepth = (value: number | undefined, flag: string, max?: number): number | undefined => {
    if (value === undefined) {
        return undefined;
    }

    if (!Number.isInteger(value) || value < 0 || (max !== undefined && value > max)) {
        const range = max === undefined ? "a non-negative integer" : `an integer from 0 to ${String(max)}`;

        throw new VisUserError(`${flag} must be ${range} (got ${String(value)}).`);
    }

    return value;
};

const validateMaxSize = (value: number | undefined): number | undefined => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw new VisUserError(`--max-size must be a positive number of bytes (got ${String(value)}; default ${String(DEFAULT_MAX_FILE_SIZE)}).`);
    }

    return value;
};

const validateConfidence = (raw: string | undefined): Confidence | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    if (!(CONFIDENCE_LEVELS as ReadonlyArray<string>).includes(raw)) {
        throw new VisUserError(`--min-confidence must be one of: ${CONFIDENCE_LEVELS.join(", ")} (got "${raw}")`);
    }

    return raw as Confidence;
};

/**
 * Resolve scan options by layering (high → low precedence):
 *   CLI flags > vis.config.secrets > built-in defaults.
 *
 * Exported for unit tests — the layering is the only place where
 * `secrets.config.presets` and `--enable-rule` interact, and a regression
 * here is silent (the scan still runs; it just runs the wrong rule set).
 */
export const resolveScanOptions = (flags: SecretsFlags, visSecrets: VisSecretsConfig | undefined, root: string): ScanOptions => {
    const cfg = visSecrets ?? {};
    const resolvePath = (p: string | undefined): string | undefined => (p ? resolve(root, p) : undefined);
    const pickList = (flag: RepeatableString | undefined, fallback: string[] | undefined): string[] | undefined => {
        const fromFlag = toArray(flag);

        return fromFlag.length > 0 ? fromFlag : fallback;
    };

    const presetEnableRules = (cfg.config?.presets ?? []).map((name) => `tag:preset:${name}`);
    const baseEnableRules = pickList(flags.enableRule, cfg.rules?.enable) ?? [];
    // Presets layer on top of the active enable list (CLI flag or rules.enable).
    // Keep order stable + dedupe so explicit user entries win over generated
    // preset filters when the scanner reports an unknown / collided tag.
    const mergedEnable = [...baseEnableRules, ...presetEnableRules.filter((entry) => !baseEnableRules.includes(entry))];
    const enableRules = mergedEnable.length > 0 ? mergedEnable : undefined;
    const excludeRules = pickList(flags.excludeRule, cfg.rules?.exclude);
    const includeRules = pickList(flags.includeRule, cfg.rules?.include);
    const excludePatterns = pickList(flags.exclude, cfg.walk?.excludePatterns);
    const excludeFromFlag = toArray(flags.excludeFrom).map((p) => resolve(root, p));
    const excludeFromFiles = excludeFromFlag.length > 0 ? excludeFromFlag : cfg.walk?.excludeFromFiles?.map((p) => resolve(root, p));
    const baselinePath = resolvePath(flags.baseline) ?? resolvePath(cfg.baseline);
    const configPath = resolvePath(flags.config) ?? resolvePath(cfg.config?.path);
    const minConfidence = validateConfidence(flags.minConfidence ?? cfg.config?.minConfidence);

    return {
        baseline: baselinePath,
        concurrency: flags.concurrency,
        config: {
            extendBundled: flags.extendBundled === false ? false : cfg.config?.extendBundled,
            inline: cfg.config?.inline,
            minConfidence,
            onlyVerified: flags.onlyVerified ?? cfg.config?.onlyVerified ?? false,
            path: configPath,
            validate: flags.validate ?? cfg.config?.validate ?? false,
        },
        inlineAllow: flags.inlineAllow,
        maxArchiveDepth: validateDepth(flags.maxArchiveDepth, "--max-archive-depth", MAX_ARCHIVE_DEPTH),
        maxDecodeDepth: validateDepth(flags.maxDecodeDepth, "--max-decode-depth"),
        redact: flags.redact ?? cfg.redact,
        reportSuppressed: flags.logIgnored === true,
        rules: { enable: enableRules, exclude: excludeRules, include: includeRules },
        verbose: flags.verbose ?? false,
        walk: {
            excludeFromFiles,
            excludePatterns,
            gitignore: flags.gitignore === false ? false : (cfg.walk?.gitignore ?? true),
            includeHidden: flags.includeHidden ?? cfg.walk?.includeHidden,
            maxFileSize: validateMaxSize(flags.maxSize) ?? cfg.walk?.maxFileSize,
        },
    };
};

/** The flags that pick what a scan reads; at most one may be set. */
const scanTargetFlags = (flags: SecretsFlags): string[] =>
    [
        flags.history ? "--history" : undefined,
        flags.staged ? "--staged" : undefined,
        flags.since === undefined ? undefined : "--since",
        flags.affected ? "--affected" : undefined,
    ].filter((flag): flag is string => flag !== undefined);

/** The modes that print or seed something instead of scanning a target. */
const nonScanMode = (flags: SecretsFlags, includeUpdateBaseline: boolean): string | undefined =>
    [
        flags.listRules ? "--list-rules" : undefined,
        flags.listValidators ? "--list-validators" : undefined,
        flags.init ? "--init" : undefined,
        includeUpdateBaseline && flags.updateBaseline ? "--update-baseline" : undefined,
    ].find((flag): flag is string => flag !== undefined);

/**
 * Reject history-only flags used without `--history`, flag combinations the
 * history walk can't honour, and two scan targets at once, instead of
 * silently ignoring all but one.
 */
export const assertHistoryFlags = (flags: SecretsFlags): void => {
    const targets = scanTargetFlags(flags);

    if (targets.length > 1) {
        throw new VisUserError(`${targets.join(", ")} each pick what to scan and can't be combined. Use one of them.`);
    }

    if (!flags.history) {
        const historyOnly = [
            flags.all ? "--all" : undefined,
            flags.historyRange === undefined ? undefined : "--history-range",
            flags.maxCommits === undefined ? undefined : "--max-commits",
        ].filter((flag): flag is string => flag !== undefined);

        if (historyOnly.length > 0) {
            throw new VisUserError(
                `${historyOnly.join(", ")} only applies to git history scans. Did you mean \`vis secrets --history ${historyOnly.join(" ")}\`?`,
            );
        }

        return;
    }

    if (flags.all && flags.historyRange !== undefined) {
        throw new VisUserError("--all walks every ref and can't be combined with --history-range. Use one or the other.");
    }

    if (flags.updateBaseline) {
        throw new VisUserError("--update-baseline records working-tree findings and can't be combined with --history.");
    }

    if (flags.maxCommits !== undefined && (!Number.isInteger(flags.maxCommits) || flags.maxCommits < 1)) {
        throw new VisUserError(`--max-commits must be a positive integer (got ${String(flags.maxCommits)}); omit it to walk every commit.`);
    }
};

/** Git blob scans (`--history`, `--staged`) read text only and never open archives. */
export const assertArchiveFlags = (flags: SecretsFlags): void => {
    const mode = flags.history ? "--history" : flags.staged ? "--staged" : undefined;

    if (flags.maxArchiveDepth !== undefined && mode !== undefined) {
        throw new VisUserError(
            `--max-archive-depth only applies to working-tree scans; ${mode} scans git blobs as text and doesn't open archives. Drop --max-archive-depth or ${mode}.`,
        );
    }
};

/**
 * Why a scan covers only part of the repository (staged files, a diff, a
 * path subset, part of history). On such a scan an ignore entry for a file
 * outside it would look unused, so unused entries are neither printed nor
 * enforced.
 */
export const partialScanReasons = (flags: SecretsFlags, hasPathArguments: boolean): string[] =>
    [
        flags.staged ? "--staged" : undefined,
        flags.since === undefined ? undefined : "--since",
        flags.affected ? "--affected" : undefined,
        flags.historyRange === undefined ? undefined : "--history-range",
        flags.maxCommits === undefined ? undefined : "--max-commits",
        hasPathArguments ? "explicit paths" : undefined,
    ].filter((flag): flag is string => flag !== undefined);

/**
 * Reject the reporting flags in modes that never produce a scan report, scan
 * targets in modes that don't scan them, and `--fail-on-unused-ignores` where
 * a partial scan would call every entry for an unscanned file "unused".
 */
export const assertReportingFlags = (flags: SecretsFlags, hasPathArguments: boolean): void => {
    const reportless = nonScanMode(flags, true);
    const reportingFlags = [
        toArray(flags.report).length > 0 ? "--report" : undefined,
        flags.logIgnored ? "--log-ignored" : undefined,
        flags.failOnUnreadable ? "--fail-on-unreadable" : undefined,
        flags.failOnUnusedIgnores ? "--fail-on-unused-ignores" : undefined,
    ].filter((flag): flag is string => flag !== undefined);

    if (reportless !== undefined && reportingFlags.length > 0) {
        throw new VisUserError(`${reportingFlags.join(", ")} only applies to a scan report and can't be combined with ${reportless}.`);
    }

    const targetless = nonScanMode(flags, false);
    const targets = [...scanTargetFlags(flags), ...(hasPathArguments ? ["explicit paths"] : [])];

    if (targetless !== undefined && targets.length > 0) {
        throw new VisUserError(`${targets.join(", ")} picks what to scan and can't be combined with ${targetless}.`);
    }

    if (!flags.failOnUnusedIgnores) {
        return;
    }

    if (flags.gitleaksIgnore === false) {
        throw new VisUserError("--fail-on-unused-ignores checks .gitleaksignore, which --no-gitleaks-ignore turns off. Drop one of them.");
    }

    const partial = partialScanReasons(flags, hasPathArguments);

    if (partial.length > 0) {
        throw new VisUserError(
            `--fail-on-unused-ignores needs a full scan: with ${partial.join(", ")}, entries for files outside the scan would be reported as unused. Run it on a full \`vis secrets\` or \`vis secrets --history\` scan.`,
        );
    }
};
