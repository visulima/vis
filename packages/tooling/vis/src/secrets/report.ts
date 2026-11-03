import { dim, yellow } from "@visulima/colorize";
import type { Finding, GitFinding, GitleaksIgnoreEntry, RuleInfo, SkippedFile, SuppressedFinding } from "@visulima/secret-scanner";

import { emitSecretsCsv, emitSecretsGitlabCodeQuality, emitSecretsJUnit, gitleaksFingerprint } from "../report/secrets";
import { toRelativeFinding } from "./baseline";
import { formatHistoryText, formatSarif, formatText } from "./format";

export const REPORT_FORMATS = ["text", "json", "sarif", "csv", "junit", "gitlab-code-quality"] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const isReportFormat = (value: string): value is ReportFormat => (REPORT_FORMATS as ReadonlyArray<string>).includes(value);

export interface ReportTarget {
    format: ReportFormat;
    path: string;
}

/**
 * Parse repeatable `--report &lt;format>=&lt;path>` values. Throws on an unknown
 * format, a missing path, or two reports to the same file.
 */
export const parseReportTargets = (values: string[]): ReportTarget[] => {
    const targets: ReportTarget[] = [];
    const seen = new Set<string>();

    for (const value of values) {
        const separator = value.indexOf("=");
        const format = separator === -1 ? value : value.slice(0, separator);
        const path = separator === -1 ? "" : value.slice(separator + 1);

        if (!isReportFormat(format)) {
            throw new Error(`--report "${value}": format must be one of ${REPORT_FORMATS.join(", ")}, as <format>=<path> (e.g. sarif=secrets.sarif)`);
        }

        if (path === "") {
            throw new Error(`--report "${value}" needs a file path: ${format}=<path>`);
        }

        if (seen.has(path)) {
            throw new Error(`--report writes ${path} twice; give each report its own file.`);
        }

        seen.add(path);
        targets.push({ format, path });
    }

    return targets;
};

export interface RenderContext {
    /** Render the commit-grouped text view (`--history`). */
    history: boolean;
    /** Findings are already masked; the text view must not print source context. */
    redact: boolean;
    root: string;
    ruleMetadata: RuleInfo[];
    toolVersion: string;
    useColor: boolean;
}

/** Render findings in one report format. */
export const renderReport = (format: ReportFormat, findings: Finding[], context: RenderContext): string => {
    const relativeFindings = (): Finding[] => findings.map((finding) => toRelativeFinding(finding, context.root));

    switch (format) {
        case "csv": {
            return emitSecretsCsv(relativeFindings());
        }
        case "gitlab-code-quality": {
            return emitSecretsGitlabCodeQuality(relativeFindings());
        }
        case "json": {
            return `${JSON.stringify(relativeFindings(), null, 2)}\n`;
        }
        case "junit": {
            return emitSecretsJUnit(relativeFindings());
        }
        case "sarif": {
            return `${formatSarif(findings, context.toolVersion, context.root, context.ruleMetadata)}\n`;
        }
        default: {
            const text = context.history
                ? formatHistoryText(findings as GitFinding[], context.useColor, { redact: context.redact })
                : formatText(findings, context.root, context.useColor, { redact: context.redact });

            return `${text}\n`;
        }
    }
};

/** Files the scan could not read, grouped by reason; listed with `verbose`. */
export const formatSkippedFiles = (skipped: SkippedFile[], useColor: boolean, options: { verbose?: boolean } = {}): string => {
    const counts = new Map<string, number>();

    for (const file of skipped) {
        counts.set(file.reason, (counts.get(file.reason) ?? 0) + 1);
    }

    const breakdown = [...counts].map(([reason, count]) => `${reason}: ${String(count)}`).join(", ");
    const summary = `${String(skipped.length)} file(s) not scanned (${breakdown})${options.verbose ? "" : "; use --verbose to list them"}`;
    const lines = [useColor ? yellow(summary) : summary];

    if (options.verbose) {
        for (const file of skipped) {
            const detail = `  - ${file.path} [${file.reason}]`;

            lines.push(useColor ? dim(detail) : detail);
        }
    }

    return lines.join("\n");
};

/** Describe an ignore entry without printing a secret-value entry's secret. */
const describeIgnoreEntry = (entry: GitleaksIgnoreEntry): string => (entry.kind === "secret" ? "<secret-value entry>" : entry.raw);

/** Stale `.gitleaksignore` entries, one per line with their line number. */
export const formatUnusedIgnores = (entries: GitleaksIgnoreEntry[], ignoreFile: string, useColor: boolean): string => {
    const summary = `${String(entries.length)} unused ${ignoreFile} entr${entries.length === 1 ? "y" : "ies"} (no finding matched; remove or update them):`;
    const lines = [useColor ? yellow(summary) : summary];

    for (const entry of entries) {
        const detail = `  - line ${String(entry.line)}: ${describeIgnoreEntry(entry)}`;

        lines.push(useColor ? dim(detail) : detail);
    }

    return lines.join("\n");
};

/** `--log-ignored`: every suppressed finding with the reason it was suppressed. */
export const formatSuppressed = (suppressed: SuppressedFinding[], root: string, useColor: boolean): string => {
    const summary = `${String(suppressed.length)} finding(s) suppressed:`;
    const lines = [useColor ? yellow(summary) : summary];

    for (const finding of suppressed) {
        const relative = toRelativeFinding(finding, root);
        const { commit } = finding as Partial<GitFinding>;
        const entryLine = finding.suppressedByEntry === undefined ? "" : ` line ${String(finding.suppressedByEntry.line)}`;
        const reason = `${finding.suppressedBy}${entryLine}`;
        const detail = `  - [${finding.ruleId}] ${gitleaksFingerprint({ ...relative, commit })} (${reason})`;

        lines.push(useColor ? dim(detail) : detail);
    }

    return lines.join("\n");
};
