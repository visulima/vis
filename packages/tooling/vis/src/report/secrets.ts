/**
 * Report emitters for `vis secrets`: CSV, JUnit XML and GitLab Code Quality.
 *
 * Findings arrive with paths already relative to the workspace root (see
 * `toRelativeFinding`) and already masked when `--redact` is on. History
 * findings carry the commit that introduced them.
 */

import { createHash } from "node:crypto";

import type { Finding, GitFinding } from "@visulima/secret-scanner";
import { gitleaksIgnoreFingerprint } from "@visulima/secret-scanner";

import { cdata, escapeAttribute } from "./junit-audit";

type SecretsFinding = Finding & Partial<Pick<GitFinding, "commit">>;

// OWASP CSV-injection guidance: a cell starting with one of these is evaluated
// as a formula by Excel / LibreOffice / Sheets (gitleaks #2237).
const FORMULA_TRIGGER = /^[\t\r+=@-]/;

/** Neutralise spreadsheet formulas, then quote per RFC 4180. */
export const csvCell = (value: string): string => {
    const safe = FORMULA_TRIGGER.test(value) ? `'${value}` : value;

    return /[\n\r",]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const CSV_COLUMNS = [
    "RuleID",
    "Commit",
    "File",
    "Secret",
    "Match",
    "StartLine",
    "EndLine",
    "StartColumn",
    "EndColumn",
    "Author",
    "Message",
    "Date",
    "Email",
    "Fingerprint",
    "Tags",
] as const;

/** CSV with gitleaks' column names (minus `SymlinkFile`, which vis never fills). */
export const emitSecretsCsv = (findings: SecretsFinding[]): string => {
    const rows = findings.map((finding) =>
        [
            csvCell(finding.ruleId),
            csvCell(finding.commit?.sha ?? ""),
            csvCell(finding.file),
            csvCell(finding.secret),
            csvCell(finding.match),
            String(finding.startLine),
            String(finding.endLine),
            String(finding.startColumn),
            String(finding.endColumn),
            csvCell(finding.commit?.authorName ?? ""),
            csvCell(finding.commit?.message ?? ""),
            csvCell(finding.commit?.date ?? ""),
            csvCell(finding.commit?.authorEmail ?? ""),
            csvCell(gitleaksIgnoreFingerprint(finding)),
            csvCell(finding.tags.join(" ")),
        ].join(","),
    );

    return `${[CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
};

/**
 * Mask a secret as the scanner does under `redact` (`abc***xyz`, `******` for
 * six characters or fewer). Idempotent, so already-redacted findings pass
 * through unchanged. JUnit results are shown in CI UIs to anyone with read
 * access, so they never carry the raw value.
 */
const maskSecret = (value: string): string => {
    // Code points, as the scanner counts; grapheme clusters aren't needed for a mask.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- See above.
    const chars = [...value];

    if (chars.length <= 6) {
        return "******";
    }

    return `${chars.slice(0, 3).join("")}${"*".repeat(chars.length - 6)}${chars.slice(-3).join("")}`;
};

/**
 * Surefire-flavoured JUnit XML: one failing `&lt;testcase>` per finding, grouped
 * in a single `&lt;testsuite>`. An empty scan yields an empty suite.
 */
export const emitSecretsJUnit = (findings: SecretsFinding[], options: { now?: Date } = {}): string => {
    const timestamp = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "");
    const count = String(findings.length);
    const cases = findings
        .map((finding) => {
            const where = `${finding.file}:${String(finding.startLine)}:${String(finding.startColumn)}`;
            const details = [
                `Rule: ${finding.ruleId}`,
                `File: ${where}`,
                ...(finding.commit === undefined
                    ? []
                    : [`Commit: ${finding.commit.sha}`, `Author: ${finding.commit.authorName} <${finding.commit.authorEmail}>`]),
                `Secret: ${maskSecret(finding.secret)}`,
                `Fingerprint: ${gitleaksIgnoreFingerprint(finding)}`,
            ].join("\n");

            const failure = `<failure type="${escapeAttribute(finding.ruleId)}" message="${escapeAttribute(finding.description || finding.ruleId)}">${cdata(details)}</failure>`;

            return [
                `    <testcase classname="${escapeAttribute(finding.file)}" name="${escapeAttribute(`${finding.ruleId} at ${where}`)}">`,
                `      ${failure}`,
                "    </testcase>",
                "",
            ].join("\n");
        })
        .join("");

    return [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<testsuites name="vis-secrets" tests="${count}" failures="${count}" skipped="0" errors="0" time="0">`,
        `  <testsuite name="secrets" tests="${count}" failures="${count}" skipped="0" errors="0" timestamp="${timestamp}" time="0">`,
        `${cases}  </testsuite>`,
        "</testsuites>",
        "",
    ].join("\n");
};

interface CodeQualityIssue {
    categories: string[];
    check_name: string;
    description: string;
    engine_name: string;
    fingerprint: string;
    location: { lines: { begin: number; end: number }; path: string };
    severity: "blocker" | "critical" | "info" | "major" | "minor";
    type: "issue";
}

/**
 * GitLab Code Quality report (`artifacts:reports:codequality`), the shape
 * gitleaks #2096 emits. Neither the description nor the fingerprint is
 * derived from the secret: the fingerprint hashes the finding's location, so
 * it is stable across runs and GitLab can diff MRs against the base.
 */
export const emitSecretsGitlabCodeQuality = (findings: SecretsFinding[]): string => {
    const issues: CodeQualityIssue[] = findings.map((finding) => {
        return {
            categories: ["Security"],
            check_name: finding.ruleId,
            description: `${finding.ruleId}: ${finding.description || "Potential secret"}`,
            engine_name: "vis-secrets",
            fingerprint: createHash("sha256")
                .update(`${gitleaksIgnoreFingerprint(finding)}\0${String(finding.startColumn)}\0${String(finding.endLine)}\0${String(finding.endColumn)}`)
                .digest("hex"),
            location: { lines: { begin: finding.startLine, end: finding.endLine }, path: finding.file },
            severity: "critical",
            type: "issue",
        };
    });

    return `${JSON.stringify(issues, undefined, 2)}\n`;
};
