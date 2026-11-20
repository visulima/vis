// Test helpers for custom rules. Every case runs through the same native
// detector as a real scan, but the tester owns all ScanOptions (no validators,
// baselines, bundled rules or caller-supplied redaction) and exposes only
// masked, projected findings so a failing test or snapshot can't leak a secret.

import { binding } from "./binding";
import { maskSecret } from "./mask";
import { prepareScan } from "./prepare-scan";
import type { DefinedRule } from "./rule";
import { scanString } from "./scan-string";
import type { Finding, ScanOptions, SkippedRule } from "./types";

export interface RuleCase {
    code: string;
    file?: string;
    /** Expected finding count. Defaults to 1 for invalid cases and 0 for valid ones. */
    findings?: number;
    /** Assert the first reported finding starts on this line. */
    line?: number;
    name?: string;
    /** Filter findings to this rule before counting (useful for multi-rule testers). */
    ruleId?: string;
}

export interface RuleTestCases {
    invalid?: (RuleCase | string)[];
    valid?: (RuleCase | string)[];
}

/** Minimal, secret-safe projection used by `run()` and `snapshot()`. */
export interface RuleSnapshotFinding {
    column: number;
    line: number;
    maskedMatch: string;
    ruleId: string;
}

export interface RuleSnapshotCase {
    findings: RuleSnapshotFinding[];
    name: string;
}

export interface RuleTestResult extends RuleSnapshotCase {
    kind: "invalid" | "valid";
    passed: boolean;
}

export class RuleTesterError extends Error {
    public override name = "RuleTesterError";
}

export interface RuleTester {
    run: (cases: RuleTestCases) => Promise<RuleTestResult[]>;
    snapshot: (cases: (RuleCase | string)[]) => Promise<RuleSnapshotCase[]>;
}

interface NormalizedCase extends RuleCase {
    name: string;
}

const normalizeCase = (value: RuleCase | string, index: number, kind: "invalid" | "valid"): NormalizedCase => {
    const testCase = typeof value === "string" ? { code: value } : value;

    return { ...testCase, name: testCase.name ?? `${kind} #${index + 1}` };
};

const project = (finding: Finding): RuleSnapshotFinding => {
    return {
        column: finding.startColumn,
        line: finding.startLine,
        maskedMatch: finding.match === "" ? "" : maskSecret(finding.match),
        ruleId: finding.ruleId,
    };
};

const describeFindings = (findings: RuleSnapshotFinding[]): string => {
    if (findings.length === 0) {
        return "none";
    }

    return findings.map((finding) => `${finding.ruleId}@${finding.line}:${finding.column}`).join(", ");
};

/** Build a fresh tester for one rule or a small ruleset. */
export const createRuleTester = (rules: DefinedRule | DefinedRule[], options: { file?: string } = {}): RuleTester => {
    const definitions = Array.isArray(rules) ? rules : [rules];
    const scanOptions = (): ScanOptions => {
        return {
            config: {
                extendBundled: false,
                heuristics: {
                    lockFile: false,
                    notAlphanumericString: false,
                    potentialUuid: false,
                    sequentialString: false,
                },
                inline: { rules: definitions },
            },
            inlineAllow: false,
            redact: false,
            reportSuppressed: false,
        };
    };

    const assertCompiles = (): void => {
        const skipped = binding.inspectRuleset(prepareScan(scanOptions()).nativeOptions) as SkippedRule[];
        const testedIds = new Set(definitions.map((rule) => rule.id));
        const failures = skipped.filter((entry) => testedIds.has(entry.ruleId));

        if (failures.length > 0) {
            const detail = failures.map((entry) => `${entry.ruleId}: ${entry.reason}`).join("; ");

            throw new RuleTesterError(`Rule failed to compile: ${detail}`);
        }
    };

    const scanCase = async (testCase: NormalizedCase): Promise<RuleSnapshotFinding[]> => {
        const findings = await scanString(testCase.code, testCase.file ?? options.file ?? "test.ts", scanOptions());
        const matching = testCase.ruleId === undefined ? findings : findings.filter((finding) => finding.ruleId === testCase.ruleId);

        return matching.map((finding) => project(finding));
    };

    /**
     * Assert valid/invalid cases. Throws one aggregated `RuleTesterError` with
     * positions only — never case content or raw secrets — when a case fails.
     */
    const run = async (cases: RuleTestCases): Promise<RuleTestResult[]> => {
        assertCompiles();

        const specs = (["valid", "invalid"] as const).flatMap((kind) =>
            (cases[kind] ?? []).map((value, index) => {
                return { kind, testCase: normalizeCase(value, index, kind) };
            }),
        );
        const outcomes = await Promise.all(
            specs.map(async ({ kind, testCase }) => {
                const findings = await scanCase(testCase);
                const expected = testCase.findings ?? (kind === "invalid" ? 1 : 0);
                const lineMatches = testCase.line === undefined || findings[0]?.line === testCase.line;
                const passed = findings.length === expected && lineMatches;
                const line = testCase.line === undefined ? "" : ` starting on line ${String(testCase.line)}`;
                const failure = passed ? undefined : `${testCase.name}: expected ${String(expected)} finding(s)${line}, got ${describeFindings(findings)}`;

                return { failure, result: { findings, kind, name: testCase.name, passed } };
            }),
        );
        const failures = outcomes.flatMap((outcome) => (outcome.failure === undefined ? [] : [outcome.failure]));

        if (failures.length > 0) {
            throw new RuleTesterError(failures.join("\n"));
        }

        return outcomes.map((outcome) => outcome.result);
    };

    /** Produce a stable, masked snapshot payload for any list of cases. */
    const snapshot = async (cases: (RuleCase | string)[]): Promise<RuleSnapshotCase[]> => {
        assertCompiles();

        return Promise.all(
            cases.map(async (value, index) => {
                const testCase = normalizeCase(value, index, "invalid");
                const findings = await scanCase(testCase);

                return {
                    findings: findings.toSorted((a, b) => a.line - b.line || a.column - b.column),
                    name: testCase.name,
                };
            }),
        );
    };

    return { run, snapshot };
};
