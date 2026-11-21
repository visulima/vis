import type { Toolbox } from "@visulima/cerebro";
import { dim, green, yellow } from "@visulima/colorize";
import { relative, resolve } from "@visulima/path";
import type {
    AllowWarning,
    Finding,
    GitleaksIgnoreEntry,
    GitSkippedBlob,
    RuleInfo,
    ScanProfile,
    SkippedFile,
    SuppressedFinding,
} from "@visulima/secret-scanner";
import { listRules } from "@visulima/secret-scanner";

import { pail } from "../../io/logger";
import type { BaselineDiff } from "../../secrets/baseline";
import { formatAllowWarnings, formatSkipped } from "../../secrets/format";
import type { ReportFormat, ReportTarget } from "../../secrets/report";
import { formatSuppressed, formatUnusedIgnores, renderReport } from "../../secrets/report";
import { writeReportFileSync } from "../../secrets/secure-write";
import type { ResolvedScanOptions, SecretsFlags } from "./flags";
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
    /** Allow markers naming rule ids that are not active. */
    allowWarnings: AllowWarning[];
    findings: Finding[];
    /** Timing breakdown; present only with `--profile`. */
    profile?: ScanProfile;
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
    scanOptions: ResolvedScanOptions;
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

        if (outcome.allowWarnings.length > 0) {
            process.stderr.write(`${formatAllowWarnings(outcome.allowWarnings, root, useColor)}\n`);
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

const LABEL_WIDTH = 44;

/** Fit a label on one terminal line, cutting the start (paths: keep the file name) or the end (patterns). */
const fitLabel = (value: string, width: number, keep: "end" | "start" = "start"): string => {
    // Regexes can contain newlines; keep every row to a single terminal line.
    const flat = value.replaceAll(/\s+/gu, " ").trim();

    if (flat.length <= width) {
        return flat.padEnd(width);
    }

    return keep === "end" ? `…${flat.slice(flat.length - width + 1)}` : `${flat.slice(0, width - 1)}…`;
};

const timingRow = (label: string, ms: number, count: number, suffix = ""): string =>
    `  ${label} ${ms.toFixed(1).padStart(7)} ms  ×${String(count)}${suffix}`;

/** A profile with nothing in it, for a scan that selected no files. */
export const emptyProfile = (): ScanProfile => {
    return { files: [], phases: [], rules: [], totalMs: 0 };
};

/** Render an opt-in profile for humans. Kept here so stdout stays machine-readable. */
export const formatProfile = (profile: ScanProfile, useColor = false): string => {
    const heading = (text: string): string => (useColor ? dim(text) : text);
    const lines = [`${heading("profile:")} ${profile.totalMs.toFixed(1)} ms total, ${String(profile.files.length)} file(s)`];
    const section = (name: string, rows: string[]): void => {
        lines.push(heading(`${name}:`), ...(rows.length > 0 ? rows : ["  (none)"]));
    };

    section(
        "phases",
        profile.phases.slice(0, 10).map((phase) => timingRow(fitLabel(phase.name, LABEL_WIDTH), phase.ms, phase.count)),
    );
    section(
        "rules",
        profile.rules
            .slice(0, 10)
            .map((rule) => timingRow(fitLabel(rule.ruleId, LABEL_WIDTH), rule.ms, rule.count, `  ${String(rule.matches)} match(es)`)),
    );
    section(
        "files",
        profile.files.slice(0, 10).map((file) => `  ${fitLabel(file.file, LABEL_WIDTH, "end")} ${file.ms.toFixed(1).padStart(7)} ms`),
    );

    return lines.join("\n");
};

/**
 * Timing is explicitly requested, so print it even with `--quiet`. Like the
 * other diagnostics it goes to stderr: raw table output shouldn't pass through
 * the logger, and stdout carries `--format` output.
 */
export const printProfile = (profile: ScanProfile | undefined, useColor: boolean): void => {
    if (profile !== undefined) {
        process.stderr.write(`${formatProfile(profile, useColor)}\n`);
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
 * By default the scanner has already masked every secret-bearing field,
 * composite `requiredFindings` included, so the findings are rendered as is.
 */
export const emitReports = async (outcome: ScanOutcome, context: ReportingContext): Promise<void> => {
    const { flags, format, history, reports, root, scanOptions, toolbox, toolVersion, useColor } = context;
    const shouldRedact = scanOptions.redact;
    const needsRules = format === "sarif" || reports.some((target) => target.format === "sarif");
    const ruleMetadata = needsRules ? await listRules(scanOptions).catch(() => [] as RuleInfo[]) : [];
    const renderContext = { history, redact: shouldRedact, root, ruleMetadata, staged: flags.staged === true, toolVersion };
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
