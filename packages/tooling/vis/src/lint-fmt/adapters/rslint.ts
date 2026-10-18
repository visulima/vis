import { createHash } from "node:crypto";

import { resolve } from "@visulima/path";

import { TOOL_SIGNATURES } from "../../util/tool-signatures";
import type { AdapterRunOptions, Finding, FindingSeverity, RunResult, ToolAdapter, ToolPresence } from "../config-types";
import { declaredVersion, findFirstConfig } from "../detect";

/**
 * Rslint adapter. Rust-native linter from the Rstack family; runs the
 * typescript-eslint rule set and emits one JSON object per finding.
 *
 * Detection requires a config file. Rslint exits 1 with "no rslint config
 * found" when there is none, so a dependency alone would make every
 * `vis lint` run fail.
 *
 * Verified against `@rslint/core` 0.9.5: findings go to stdout, a warning's
 * severity is "warn", `--max-warnings=N` works, and a broken config exits 1
 * with its reason on stderr and nothing on stdout.
 */

const SEVERITY_MAP: Record<string, FindingSeverity> = {
    error: "error",
    warn: "warning",
};

interface RslintPosition {
    column?: number;
    line?: number;
}

interface RslintDiagnostic {
    filePath?: string;
    message?: string;
    range?: { end?: RslintPosition; start?: RslintPosition };
    ruleName?: string;
    severity?: string;
}

/** The first non-empty line of stderr, which is where rslint explains a failure. */
const firstStderrLine = (stderr: string): string | undefined => stderr.split("\n").map((line) => line.trim()).find((line) => line.length > 0);

export const rslintAdapter: ToolAdapter = {
    argsCheck: (files, options) => buildArgs(files, options, false),
    argsFix: (files, options) => buildArgs(files, options, true),

    bin: () => ["pnpm", "exec", "rslint"],

    cacheKey: (presence, options) => {
        const parts = [
            "rslint",
            presence.declaredVersion ?? "unknown",
            presence.configFile ?? "no-config",
            options.maxWarnings === undefined ? "" : `mw=${options.maxWarnings}`,
            options.quiet ? "q" : "",
            ...(options.extraArgs ?? []),
        ];

        return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
    },

    detect: (root, packageJson): ToolPresence | undefined => {
        const configFile = findFirstConfig(root, TOOL_SIGNATURES.rslint.configFiles);

        if (!configFile) {
            return undefined;
        }

        const declared = declaredVersion(packageJson, TOOL_SIGNATURES.rslint.packageNames[0]);

        return {
            adapter: "rslint",
            configFile,
            declared: Boolean(declared),
            declaredVersion: declared,
            root,
        };
    },

    extensions: ["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"],
    id: "rslint",
    kind: "lint",

    parse: (result: RunResult, presence: ToolPresence): Finding[] => {
        const findings: Finding[] = [];

        // One JSON object per line. Lines that are not JSON are skipped rather than
        // reported as errors: a summary line must not become a finding.
        for (const line of result.stdout.split("\n")) {
            const text = line.trim();

            if (!text.startsWith("{")) {
                continue;
            }

            let diagnostic: RslintDiagnostic;

            try {
                diagnostic = JSON.parse(text) as RslintDiagnostic;
            } catch {
                continue;
            }

            findings.push({
                adapter: "rslint",
                column: diagnostic.range?.start?.column,
                endColumn: diagnostic.range?.end?.column,
                endLine: diagnostic.range?.end?.line,
                file: diagnostic.filePath === undefined ? presence.root : resolve(presence.root, diagnostic.filePath),
                fixable: false,
                line: diagnostic.range?.start?.line,
                message: diagnostic.message ?? "",
                ruleId: diagnostic.ruleName,
                severity: SEVERITY_MAP[diagnostic.severity ?? ""] ?? "warning",
            });
        }

        // A non-zero exit with no findings is a crash, such as a broken config. Report it
        // as an error so the output does not read "no findings".
        if (findings.length === 0 && result.exitCode !== 0 && result.exitCode !== null) {
            findings.push({
                adapter: "rslint",
                file: presence.root,
                fixable: false,
                message: firstStderrLine(result.stderr) ?? `rslint exited with code ${String(result.exitCode)} and no output`,
                severity: "error",
            });
        }

        return findings;
    },
};

const buildArgs = (files: ReadonlyArray<string>, options: AdapterRunOptions, fix: boolean): string[] => {
    const args = ["--format", "jsonline"];

    if (fix) {
        args.push("--fix");
    }

    if (options.quiet) {
        args.push("--quiet");
    }

    if (typeof options.maxWarnings === "number") {
        args.push(`--max-warnings=${String(options.maxWarnings)}`);
    }

    if (options.extraArgs?.length) {
        args.push(...options.extraArgs);
    }

    args.push(...files);

    return args;
};
