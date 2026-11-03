import type { Toolbox } from "@visulima/cerebro";
import { dim, green, yellow } from "@visulima/colorize";
import { relative, resolve } from "@visulima/path";
import type { Finding, GitleaksIgnoreEntry, GitSkippedBlob, RuleInfo, ScanOptions, SkippedFile, SuppressedFinding } from "@visulima/secret-scanner";
import { listRules } from "@visulima/secret-scanner";

import { pail } from "../../io/logger";
import type { BaselineDiff } from "../../secrets/baseline";
import { formatSkipped } from "../../secrets/format";
import type { ReportFormat, ReportTarget } from "../../secrets/report";
import { formatSuppressed, formatUnusedIgnores, renderReport } from "../../secrets/report";
import { writeReportFileSync } from "../../secrets/secure-write";
import type { SecretsFlags } from "./flags";
import type { SecretsOptions } from "./index";

export const GITLEAKS_IGNORE = ".gitleaksignore";

/**
 * Status lines for a scan (summary, "wrote report", hints). pail sends info,
 * notice and success to stdout, which carries the `--format` report, so they
 * would corrupt json / sarif / csv output; route every level to stderr.
 */
export const status: typeof pail = pail.child({ stdout: process.stderr });

/** Everything a scan produced, whichever mode ran it. */
export interface ScanOutcome {
    findings: Finding[];
    /** Files (working-tree scans) or git blobs (`--history`, `--staged`) the scan did not read. */
    skipped: (GitSkippedBlob | SkippedFile)[];
    skippedUnit: "blob" | "file";
    suppressed: SuppressedFinding[];
    unusedIgnores: GitleaksIgnoreEntry[];
}

export interface ReportingContext {
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
export const printDiagnostics = (outcome: ScanOutcome, context: ReportingContext): void => {
    const { flags, root, useColor } = context;

    if (!flags.quiet) {
        if (outcome.skipped.length > 0) {
            process.stderr.write(`${formatSkipped(outcome.skipped, outcome.skippedUnit, useColor, { verbose: flags.verbose })}\n`);
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

export const printBaselineDiff = (diff: BaselineDiff): void => {
    process.stderr.write(
        `${dim("baseline diff: ")}${green(`+${String(diff.fresh.length)} new`)} · ${yellow(`${String(diff.surviving.length)} unchanged`)} · ${dim(`-${String(diff.resolved.length)} resolved`)}\n`,
    );
};

/**
 * Print the `--format` report to stdout and write every `--report` file.
 *
 * With `--redact` the scanner has already masked every secret-bearing field,
 * composite `requiredFindings` included, so the findings are rendered as is.
 */
export const emitReports = async (outcome: ScanOutcome, context: ReportingContext): Promise<void> => {
    const { flags, format, history, reports, root, scanOptions, toolbox, toolVersion, useColor } = context;
    const shouldRedact = scanOptions.redact === true;
    const needsRules = format === "sarif" || reports.some((target) => target.format === "sarif");
    const ruleMetadata = needsRules ? await listRules(scanOptions).catch(() => [] as RuleInfo[]) : [];
    const renderContext = { history, redact: shouldRedact, root, ruleMetadata, toolVersion };
    // Unredacted reports hold every secret in clear text: owner-only (gitleaks #2300).
    // History reports carry commit messages, which `--redact` doesn't mask and which
    // can quote a secret, so they stay owner-only either way.
    const sensitive = !shouldRedact || history;

    process.stdout.write(renderReport(format, outcome.findings, { ...renderContext, useColor }));

    for (const target of reports) {
        const path = resolve(toolbox.process.cwd, target.path);

        writeReportFileSync(path, renderReport(target.format, outcome.findings, { ...renderContext, useColor: false }), sensitive);

        if (!flags.quiet) {
            status.info(`Wrote ${target.format} report to ${relative(toolbox.process.cwd, path) || path}`);
        }
    }
};

/** Set the exit code for the opt-in diagnostics gates. */
export const applyDiagnosticGates = (outcome: ScanOutcome, flags: SecretsFlags): void => {
    if (flags.failOnUnreadable) {
        // Oversized and binary entries were skipped on purpose; everything else couldn't be read.
        const unreadable = outcome.skipped.filter((entry) => entry.reason !== "too-large" && entry.reason !== "binary").length;

        if (unreadable > 0) {
            status.error(`${String(unreadable)} ${outcome.skippedUnit}(s) could not be read; the scan is incomplete (--fail-on-unreadable).`);
            process.exitCode = 1;
        }
    }

    if (flags.failOnUnusedIgnores && outcome.unusedIgnores.length > 0) {
        status.error(
            `${String(outcome.unusedIgnores.length)} unused ${GITLEAKS_IGNORE} entr${outcome.unusedIgnores.length === 1 ? "y" : "ies"} (--fail-on-unused-ignores).`,
        );
        process.exitCode = 1;
    }
};
