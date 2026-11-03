import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import { dim, green, yellow } from "@visulima/colorize";
import { isAccessibleSync } from "@visulima/fs";
import { join, relative, resolve } from "@visulima/path";
import { redact } from "@visulima/redact";
import type { Confidence, Finding, GitleaksIgnoreEntry, GitSkippedBlob, RuleInfo, ScanOptions, SkippedFile, SuppressedFinding } from "@visulima/secret-scanner";
import {
    inspectRuleset,
    listRequiredValidators,
    listRules,
    scan,
    scanDetailed,
    scanFilesDetailed,
    scanGitHistoryDetailed,
    scanGitStaged,
} from "@visulima/secret-scanner";

import { VisUserError } from "../../errors/vis-user-error";
import { pail } from "../../io/logger";
import { createSpinner } from "../../io/spinner";
import { diffBaseline, writeBaseline } from "../../secrets/baseline";
import { formatSkippedBlobs } from "../../secrets/format";
import { filesSince, hasGit } from "../../secrets/git";
import type { ReportFormat, ReportTarget } from "../../secrets/report";
import {
    formatSkippedFiles,
    formatSuppressed,
    formatUnusedIgnores,
    isReportFormat,
    parseReportTargets,
    renderReport,
    REPORT_FORMATS,
} from "../../secrets/report";
import { writeReportFileSync } from "../../secrets/secure-write";
import { pathExists } from "../../util/toolbox-fs";
import type { SecretsOptions } from "./index";

type RepeatableString = string | string[];

const GITLEAKS_IGNORE = ".gitleaksignore";

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

const DEFAULT_BASELINE = ".secrets-baseline.json";

const toArray = (value: string | string[] | undefined): string[] => {
    if (!value) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
};

const validateFormat = (raw: string | undefined): ReportFormat => {
    if (raw === undefined) {
        return "text";
    }

    if (!isReportFormat(raw)) {
        throw new Error(`--format must be one of: ${REPORT_FORMATS.join(", ")} (got "${raw}")`);
    }

    return raw;
};

/** The library clamps archive nesting at this depth; reject larger values instead. */
const MAX_ARCHIVE_DEPTH = 8;

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

const validateConfidence = (raw: string | undefined): Confidence | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    const allowed = new Set<Confidence>(["high", "low", "medium"]);

    if (!allowed.has(raw as Confidence)) {
        throw new Error(`--min-confidence must be one of: ${[...allowed].join(", ")} (got "${raw}")`);
    }

    return raw as Confidence;
};

const printListRules = async (scanOptions: ScanOptions, useColor: boolean): Promise<void> => {
    const rules: RuleInfo[] = await listRules(scanOptions);

    process.stdout.write(`${String(rules.length)} rules loaded\n\n`);

    for (const rule of rules) {
        const id = useColor ? yellow(rule.id) : rule.id;
        const tags = rule.tags.length > 0 ? ` ${useColor ? dim(`[${rule.tags.join(", ")}]`) : `[${rule.tags.join(", ")}]`}` : "";

        process.stdout.write(`${id}${tags}\n  ${rule.description}\n`);

        if (rule.keywords.length > 0) {
            const kw = `keywords: ${rule.keywords.slice(0, 6).join(", ")}${rule.keywords.length > 6 ? ", ..." : ""}`;

            process.stdout.write(`  ${useColor ? dim(kw) : kw}\n`);
        }

        process.stdout.write("\n");
    }
};

const printListValidators = async (scanOptions: ScanOptions, useColor: boolean): Promise<void> => {
    const report = await listRequiredValidators(scanOptions);

    if (report.length === 0) {
        process.stdout.write(
            useColor ? `${dim("No non-HTTP validators required by the current ruleset.")}\n` : "No non-HTTP validators required by the current ruleset.\n",
        );

        return;
    }

    process.stdout.write(`${String(report.length)} non-HTTP validator type(s) referenced by the current ruleset:\n\n`);

    for (const entry of report) {
        const title = useColor ? yellow(entry.displayName) : entry.displayName;
        const typeLabel = `(${entry.type}, ${String(entry.ruleCount)} rule${entry.ruleCount === 1 ? "" : "s"})`;

        process.stdout.write(`${title} ${useColor ? dim(typeLabel) : typeLabel}\n`);
        process.stdout.write(`  ${entry.summary}\n`);

        const hint = entry.packageName ? `install: npm add ${entry.packageName}` : "no driver — bespoke implementation required";

        process.stdout.write(`  ${useColor ? dim(hint) : hint}\n\n`);
    }
};

const runInit = async (root: string, scanOptions: ScanOptions, dryRun: boolean): Promise<void> => {
    const baselinePath = join(root, DEFAULT_BASELINE);

    if (!dryRun && isAccessibleSync(baselinePath)) {
        pail.warn(`Detected existing ${DEFAULT_BASELINE} — refusing to overwrite. Delete it first to re-init.`);
        process.exitCode = 1;

        return;
    }

    pail.info(dryRun ? "[dry-run] Previewing init — no files will be written." : "Scanning workspace to seed baseline…");
    const spinner = createSpinner();

    spinner.start("scanning");

    let findings: Finding[];

    try {
        findings = await scan([root], scanOptions);
        spinner.succeed();
    } catch (error) {
        spinner.failed();
        throw error;
    }

    if (dryRun) {
        pail.info(`[dry-run] Would create ${DEFAULT_BASELINE} with ${String(findings.length)} finding(s).`);

        return;
    }

    const count = writeBaseline(findings, baselinePath, root, { replace: true, sensitive: scanOptions.redact !== true });

    pail.success(`Wrote ${DEFAULT_BASELINE} (${String(count)} findings).`);
    pail.notice("Commit it. Use `vis secrets --baseline .secrets-baseline.json` in CI. Add path patterns to .gitignore to exclude directories from scanning.");
};

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
            maxFileSize: flags.maxSize ?? cfg.walk?.maxFileSize,
        },
    };
};

const printDiff = (diff: { fresh: Finding[]; resolved: Finding[]; surviving: Finding[] }): void => {
    process.stderr.write(
        `${dim("baseline diff: ")}${green(`+${String(diff.fresh.length)} new`)} · ${yellow(`${String(diff.surviving.length)} unchanged`)} · ${dim(`-${String(diff.resolved.length)} resolved`)}\n`,
    );
};

/**
 * Reject history-only flags used without `--history`, and flag combinations
 * the history walk can't honour, instead of silently ignoring them.
 */
export const assertHistoryFlags = (flags: SecretsFlags): void => {
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

const chooseScanPaths = async (flags: SecretsFlags, args: string[], root: string): Promise<{ files?: string[]; paths?: string[]; staged?: true }> => {
    if (flags.staged) {
        if (!hasGit(root)) {
            throw new Error("--staged requires a git working tree, and none was detected.");
        }

        return { staged: true };
    }

    if (flags.since) {
        if (!hasGit(root)) {
            throw new Error("--since requires a git working tree, and none was detected.");
        }

        return { files: filesSince(root, flags.since) };
    }

    if (flags.affected) {
        // Best-effort: derive a file list from `git diff` against a base ref. If the
        // user has the full vis workspace available, they can combine --since with
        // their preferred base (e.g. `--since main`) for more control.
        if (!hasGit(root)) {
            pail.warn("--affected requires git; falling back to full scan");

            return { paths: args && args.length > 0 ? args.map((p) => resolve(root, p)) : [root] };
        }

        const baseRef = process.env["VIS_BASE"] ?? "HEAD~1";

        return { files: filesSince(root, baseRef) };
    }

    return { paths: args && args.length > 0 ? args.map((p) => resolve(root, p)) : [root] };
};

/**
 * Why a scan covers only part of the repository (staged files, a diff, a
 * path subset, part of history). On such a scan an ignore entry for a file
 * outside it would look unused, so unused entries are neither printed nor
 * enforced.
 */
const partialScanReasons = (flags: SecretsFlags, hasPathArguments: boolean): string[] =>
    [
        flags.staged ? "--staged" : undefined,
        flags.since === undefined ? undefined : "--since",
        flags.affected ? "--affected" : undefined,
        flags.historyRange === undefined ? undefined : "--history-range",
        flags.maxCommits === undefined ? undefined : "--max-commits",
        hasPathArguments ? "explicit paths" : undefined,
    ].filter((flag): flag is string => flag !== undefined);

/**
 * Reject the reporting flags in modes that never produce a scan report, and
 * `--fail-on-unused-ignores` where a partial scan would call every entry for
 * an unscanned file "unused".
 */
export const assertReportingFlags = (flags: SecretsFlags, hasPathArguments: boolean): void => {
    const nonScanMode = [
        flags.listRules ? "--list-rules" : undefined,
        flags.listValidators ? "--list-validators" : undefined,
        flags.init ? "--init" : undefined,
        flags.updateBaseline ? "--update-baseline" : undefined,
    ].find((flag): flag is string => flag !== undefined);
    const reportingFlags = [
        toArray(flags.report).length > 0 ? "--report" : undefined,
        flags.logIgnored ? "--log-ignored" : undefined,
        flags.failOnUnreadable ? "--fail-on-unreadable" : undefined,
        flags.failOnUnusedIgnores ? "--fail-on-unused-ignores" : undefined,
    ].filter((flag): flag is string => flag !== undefined);

    if (nonScanMode !== undefined && reportingFlags.length > 0) {
        throw new VisUserError(`${reportingFlags.join(", ")} only applies to a scan report and can't be combined with ${nonScanMode}.`);
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

/** Everything a scan produced, whichever mode ran it. */
interface ScanOutcome {
    findings: Finding[];
    skippedBlobs: GitSkippedBlob[];
    skippedFiles: SkippedFile[];
    suppressed: SuppressedFinding[];
    unusedIgnores: GitleaksIgnoreEntry[];
}

interface ReportingContext {
    flags: SecretsFlags;
    format: ReportFormat;
    /** The scan covered the whole tree / history, so unused ignore entries are meaningful. */
    fullScan: boolean;
    history: boolean;
    reports: ReportTarget[];
    root: string;
    scanOptions: ScanOptions;
    toolbox: Toolbox<Console, SecretsOptions>;
    toolVersion: string;
    useColor: boolean;
}

/** Diagnostics go to stderr so json / sarif / csv on stdout stay parseable. */
const printDiagnostics = (outcome: ScanOutcome, context: ReportingContext): void => {
    const { flags, root, useColor } = context;

    if (!flags.quiet) {
        if (outcome.skippedBlobs.length > 0) {
            process.stderr.write(`${formatSkippedBlobs(outcome.skippedBlobs, useColor, { verbose: flags.verbose })}\n`);
        }

        if (outcome.skippedFiles.length > 0) {
            process.stderr.write(`${formatSkippedFiles(outcome.skippedFiles, useColor, { verbose: flags.verbose })}\n`);
        }

        if (context.fullScan && outcome.unusedIgnores.length > 0) {
            process.stderr.write(`${formatUnusedIgnores(outcome.unusedIgnores, GITLEAKS_IGNORE, useColor)}\n`);
        }
    }

    // Explicitly requested, so printed even with --quiet.
    if (flags.logIgnored) {
        process.stderr.write(`${formatSuppressed(outcome.suppressed, root, useColor)}\n`);
    }
};

/** Print the `--format` report to stdout and write every `--report` file. */
const emitReports = async (outcome: ScanOutcome, context: ReportingContext): Promise<void> => {
    const { flags, format, history, reports, root, scanOptions, toolbox, toolVersion, useColor } = context;
    const shouldRedact = scanOptions.redact === true;
    const reportFindings = shouldRedact ? redact(outcome.findings, ["match", "secret"]) : outcome.findings;
    const needsRules = format === "sarif" || reports.some((target) => target.format === "sarif");
    const ruleMetadata = needsRules ? await listRules(scanOptions).catch(() => [] as RuleInfo[]) : [];
    const renderContext = { history, redact: shouldRedact, root, ruleMetadata, toolVersion };

    process.stdout.write(renderReport(format, reportFindings, { ...renderContext, useColor }));

    for (const target of reports) {
        const path = resolve(toolbox.process.cwd, target.path);

        // Unredacted reports hold every secret in clear text: owner-only (gitleaks #2300).
        writeReportFileSync(path, renderReport(target.format, reportFindings, { ...renderContext, useColor: false }), !shouldRedact);

        if (!flags.quiet) {
            pail.info(`Wrote ${target.format} report to ${relative(toolbox.process.cwd, path) || path}`);
        }
    }
};

/** Set the exit code for the opt-in diagnostics gates. */
const applyDiagnosticGates = (outcome: ScanOutcome, flags: SecretsFlags): void => {
    if (flags.failOnUnreadable) {
        const unreadableFiles = outcome.skippedFiles.filter((file) => file.reason !== "too-large").length;
        const unreadable = unreadableFiles + outcome.skippedBlobs.filter((blob) => blob.reason === "missing").length;

        if (unreadable > 0) {
            pail.error(`${String(unreadable)} file(s) could not be read; the scan is incomplete (--fail-on-unreadable).`);
            process.exitCode = 1;
        }
    }

    if (flags.failOnUnusedIgnores && outcome.unusedIgnores.length > 0) {
        pail.error(
            `${String(outcome.unusedIgnores.length)} unused ${GITLEAKS_IGNORE} entr${outcome.unusedIgnores.length === 1 ? "y" : "ies"} (--fail-on-unused-ignores).`,
        );
        process.exitCode = 1;
    }
};

const runHistoryScan = async (flags: SecretsFlags, root: string, scanOptions: ScanOptions, context: Omit<ReportingContext, "history">): Promise<void> => {
    if (flags.staged || flags.since || flags.affected) {
        throw new Error("--history scans commit history and can't be combined with --staged / --since / --affected (those scan the working tree).");
    }

    if (!hasGit(root)) {
        throw new Error("--history requires a git working tree, and none was detected.");
    }

    const isInteractive = !flags.quiet && context.format === "text";
    const spinner = createSpinner({ verbose: isInteractive });

    spinner.start("scanning git history for secrets");

    let outcome: ScanOutcome;

    try {
        const result = await scanGitHistoryDetailed({
            ...scanOptions,
            all: flags.all,
            cwd: root,
            maxCommits: flags.maxCommits,
            range: flags.historyRange,
        });

        outcome = {
            findings: result.findings,
            skippedBlobs: result.skipped,
            skippedFiles: [],
            suppressed: result.suppressed,
            unusedIgnores: result.unusedIgnores,
        };
        spinner.succeed();
    } catch (error) {
        spinner.failed();
        throw new VisUserError(`git-history secret scan failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    const reporting = { ...context, history: true };

    printDiagnostics(outcome, reporting);
    await emitReports(outcome, reporting);

    if (outcome.findings.length > 0) {
        if (!flags.quiet) {
            pail.warn(`${String(outcome.findings.length)} potential secret(s) found across git history`);
            pail.notice(
                "Findings reference the commit that introduced them — rotate the credential and rewrite history (e.g. git filter-repo) if it is still reachable.",
            );
        }

        process.exitCode = 1;
    } else if (!flags.quiet) {
        pail.success("No secrets detected in git history.");
    }

    applyDiagnosticGates(outcome, flags);
};

const execute = async (toolbox: Toolbox<Console, SecretsOptions>): Promise<void> => {
    const { argument, options, visConfig, workspaceRoot } = toolbox;
    const flags = options as unknown as SecretsFlags;
    const args = argument as string[] | undefined;
    const root = workspaceRoot ?? toolbox.process.cwd;
    const useColor = !flags.quiet && process.stdout.isTTY;
    const visSecrets = (visConfig as { secrets?: VisSecretsConfig } | undefined)?.secrets;
    const scanOptions = resolveScanOptions(flags, visSecrets, root);
    const toolVersion = "0.0.0-alpha"; // vis injects its own version via cerebro; this just tags SARIF.

    // Before the --list-*/--init early returns, so no mode silently drops a history or reporting flag.
    assertHistoryFlags(flags);
    assertArchiveFlags(flags);
    assertReportingFlags(flags, (args ?? []).length > 0);

    const reports = parseReportTargets(toArray(flags.report));
    const ignorePath = join(root, GITLEAKS_IGNORE);

    // gitleaks reads `.gitleaksignore` from the scan root; do the same unless --no-gitleaks-ignore.
    if (flags.gitleaksIgnore !== false && (await pathExists(toolbox.fs, ignorePath))) {
        scanOptions.gitleaksIgnore = ignorePath;
    }

    if (flags.listRules) {
        await printListRules(scanOptions, useColor);

        return;
    }

    if (flags.listValidators) {
        await printListValidators(scanOptions, useColor);

        return;
    }

    if (flags.init) {
        await runInit(root, scanOptions, flags.dryRun ?? false);

        return;
    }

    const format = validateFormat(flags.format);
    const fullScan = partialScanReasons(flags, (args ?? []).length > 0).length === 0;
    const context = { flags, format, fullScan, reports, root, scanOptions, toolbox, toolVersion, useColor };

    if (flags.history) {
        await runHistoryScan(flags, root, scanOptions, context);

        return;
    }

    const target = await chooseScanPaths(flags, args ?? [], root);

    if (target.files?.length === 0) {
        if (!flags.quiet) {
            pail.success("No files to scan.");
        }

        return;
    }

    const isInteractive = !flags.quiet && format === "text";
    const spinner = createSpinner({ verbose: isInteractive });

    spinner.start("scanning for secrets");

    let outcome: ScanOutcome;

    try {
        if (target.staged) {
            const result = await scanGitStaged({ ...scanOptions, cwd: root });

            outcome = {
                findings: result.findings,
                skippedBlobs: result.skipped,
                skippedFiles: [],
                suppressed: result.suppressed,
                unusedIgnores: result.unusedIgnores,
            };
        } else {
            const result = await (target.files === undefined ? scanDetailed(target.paths ?? [root], scanOptions) : scanFilesDetailed(target.files, scanOptions));

            outcome = {
                findings: result.findings,
                skippedBlobs: [],
                skippedFiles: result.skipped,
                suppressed: result.suppressed,
                unusedIgnores: result.unusedIgnores,
            };
        }

        spinner.succeed();
    } catch (error) {
        spinner.failed();

        const message = `secret scan failed: ${error instanceof Error ? error.message : String(error)}`;

        throw target.staged ? new VisUserError(message, { cause: error }) : new Error(message, { cause: error });
    }

    const reporting = { ...context, history: false };

    printDiagnostics(outcome, reporting);

    // Optional skipped-rule diagnostics (verbose only)
    if (flags.verbose) {
        const skipped = await inspectRuleset(scanOptions);

        if (skipped.length > 0) {
            pail.warn(`${String(skipped.length)} rule(s) skipped due to invalid regex. First few:`);

            for (const s of skipped.slice(0, 5)) {
                process.stderr.write(`  - ${s.ruleId}: ${s.reason}\n`);
            }
        }
    }

    const { findings } = outcome;

    // `ScanOptions.baseline` also accepts an inline Finding[]/fingerprint Set, but this
    // command only resolves a baseline file path (see resolveScanOptions), so narrow to
    // the string form and fall back to the default path otherwise.
    const baselineFullPath = typeof scanOptions.baseline === "string" ? scanOptions.baseline : join(root, DEFAULT_BASELINE);
    const showDiff = !flags.quiet && isAccessibleSync(baselineFullPath);

    if (flags.updateBaseline) {
        const count = writeBaseline(findings, baselineFullPath, root, { replace: flags.replaceBaseline, sensitive: scanOptions.redact !== true });

        pail.success(`Baseline updated: ${relative(root, baselineFullPath) || baselineFullPath} now contains ${String(count)} entries.`);

        return;
    }

    await emitReports(outcome, reporting);

    if (format === "text" && showDiff) {
        printDiff(diffBaseline(findings, baselineFullPath, root));
    }

    if (findings.length > 0) {
        if (!flags.quiet) {
            pail.warn(`${String(findings.length)} potential secret(s) found`);
            pail.notice("Suppress individual lines with `gitleaks:allow` / `secret-scanner:allow`, or run `vis secrets --update-baseline`.");
        }

        process.exitCode = 1;
    } else if (!flags.quiet) {
        pail.success("No secrets detected.");
    }

    applyDiagnosticGates(outcome, flags);
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
