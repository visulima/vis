import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import { dim, yellow } from "@visulima/colorize";
import { isAccessibleSync } from "@visulima/fs";
import { join, relative, resolve } from "@visulima/path";
import type { Finding, RuleInfo, ScanOptions } from "@visulima/secret-scanner";
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
import { filesSince, hasGit } from "../../secrets/git";
import { parseReportTargets } from "../../secrets/report";
import { pathExists } from "../../util/toolbox-fs";
import type { SecretsFlags, VisSecretsConfig } from "./flags";
import { assertArchiveFlags, assertHistoryFlags, assertReportingFlags, partialScanReasons, resolveScanOptions, toArray, validateFormat } from "./flags";
import type { SecretsOptions } from "./index";
import type { ScanOutcome } from "./report";
import { applyDiagnosticGates, emitReports, GITLEAKS_IGNORE, printBaselineDiff, printDiagnostics, status } from "./report";

const DEFAULT_BASELINE = ".secrets-baseline.json";

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

/** What a scan reads, resolved once from the validated flags. */
type ScanMode = { files: string[]; kind: "files" } | { kind: "history" } | { kind: "paths"; paths: string[] } | { kind: "staged" };

const resolveScanMode = (flags: SecretsFlags, args: string[], root: string): ScanMode => {
    const paths = args.length > 0 ? args.map((p) => resolve(root, p)) : [root];
    const gitFlag = flags.history ? "--history" : flags.staged ? "--staged" : flags.since === undefined ? undefined : "--since";

    if (gitFlag !== undefined && !hasGit(root)) {
        throw new VisUserError(`${gitFlag} requires a git working tree, and none was detected.`);
    }

    if (flags.history) {
        return { kind: "history" };
    }

    if (flags.staged) {
        return { kind: "staged" };
    }

    if (flags.since !== undefined) {
        return { files: filesSince(root, flags.since), kind: "files" };
    }

    if (flags.affected) {
        // Best-effort: derive a file list from `git diff` against a base ref. For more
        // control, use --since with the preferred base (e.g. `--since main`).
        if (!hasGit(root)) {
            status.warn("--affected requires git; falling back to full scan");

            return { kind: "paths", paths };
        }

        return { files: filesSince(root, process.env["VIS_BASE"] ?? "HEAD~1"), kind: "files" };
    }

    return { kind: "paths", paths };
};

const runScan = async (mode: ScanMode, flags: SecretsFlags, scanOptions: ScanOptions, root: string): Promise<ScanOutcome> => {
    if (mode.kind === "history") {
        const result = await scanGitHistoryDetailed({ ...scanOptions, all: flags.all, cwd: root, maxCommits: flags.maxCommits, range: flags.historyRange });

        return { ...result, skippedUnit: "blob" };
    }

    if (mode.kind === "paths") {
        const result = await scanDetailed(mode.paths, scanOptions);

        return { ...result, skippedUnit: "file" };
    }

    const result = mode.kind === "staged" ? await scanGitStaged({ ...scanOptions, cwd: root }) : await scanFilesDetailed(mode.files, scanOptions);

    return { ...result, skippedUnit: mode.kind === "staged" ? "blob" : "file" };
};

const printRulesetDiagnostics = async (scanOptions: ScanOptions): Promise<void> => {
    const skipped = await inspectRuleset(scanOptions);

    if (skipped.length > 0) {
        status.warn(`${String(skipped.length)} rule(s) skipped due to invalid regex. First few:`);

        for (const s of skipped.slice(0, 5)) {
            process.stderr.write(`  - ${s.ruleId}: ${s.reason}\n`);
        }
    }
};

const execute = async (toolbox: Toolbox<Console, SecretsOptions>): Promise<void> => {
    const { argument, options, visConfig, workspaceRoot } = toolbox;
    const flags = options as unknown as SecretsFlags;
    const args = (argument as string[] | undefined) ?? [];
    const root = workspaceRoot ?? toolbox.process.cwd;
    const useColor = !flags.quiet && process.stdout.isTTY;
    const visSecrets = (visConfig as { secrets?: VisSecretsConfig } | undefined)?.secrets;
    const scanOptions = resolveScanOptions(flags, visSecrets, root);
    const toolVersion = "0.0.0-alpha"; // vis injects its own version via cerebro; this just tags SARIF.

    // Before the --list-*/--init early returns, so no mode silently drops a flag.
    assertHistoryFlags(flags);
    assertArchiveFlags(flags);
    assertReportingFlags(flags, args.length > 0);

    const format = validateFormat(flags.format);
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

    const mode = resolveScanMode(flags, args, root);
    const history = mode.kind === "history";

    if (mode.kind === "files" && mode.files.length === 0) {
        if (!flags.quiet) {
            status.success("No files to scan.");
        }

        return;
    }

    const spinner = createSpinner({ verbose: !flags.quiet && format === "text" });

    spinner.start(history ? "scanning git history for secrets" : "scanning for secrets");

    let outcome: ScanOutcome;

    try {
        outcome = await runScan(mode, flags, scanOptions, root);
        spinner.succeed();
    } catch (error) {
        spinner.failed();

        throw new VisUserError(`${history ? "git-history secret scan" : "secret scan"} failed: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        });
    }

    const context = {
        flags,
        format,
        fullScan: partialScanReasons(flags, args.length > 0).length === 0,
        history,
        reports,
        root,
        scanOptions,
        toolbox,
        toolVersion,
        useColor,
    };

    printDiagnostics(outcome, context);

    if (flags.verbose) {
        await printRulesetDiagnostics(scanOptions);
    }

    const { findings } = outcome;

    // `ScanOptions.baseline` also accepts an inline Finding[]/fingerprint Set, but this
    // command only resolves a baseline file path (see resolveScanOptions), so narrow to
    // the string form and fall back to the default path otherwise.
    const baselineFullPath = typeof scanOptions.baseline === "string" ? scanOptions.baseline : join(root, DEFAULT_BASELINE);

    if (flags.updateBaseline) {
        const count = writeBaseline(findings, baselineFullPath, root, { replace: flags.replaceBaseline, sensitive: scanOptions.redact !== true });

        status.success(`Baseline updated: ${relative(root, baselineFullPath) || baselineFullPath} now contains ${String(count)} entries.`);

        return;
    }

    await emitReports(outcome, context);

    if (format === "text" && !history && !flags.quiet && isAccessibleSync(baselineFullPath)) {
        printBaselineDiff(diffBaseline(findings, baselineFullPath, root));
    }

    if (findings.length > 0) {
        if (!flags.quiet) {
            status.warn(`${String(findings.length)} potential secret(s) found${history ? " across git history" : ""}`);
            status.notice(
                history
                    ? "Findings reference the commit that introduced them — rotate the credential and rewrite history (e.g. git filter-repo) if it is still reachable."
                    : "Suppress individual lines with `gitleaks:allow` / `secret-scanner:allow`, or run `vis secrets --update-baseline`.",
            );
        }

        process.exitCode = 1;
    } else if (!flags.quiet) {
        status.success(history ? "No secrets detected in git history." : "No secrets detected.");
    }

    applyDiagnosticGates(outcome, flags);
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
