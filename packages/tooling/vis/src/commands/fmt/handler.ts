import { spawnSync } from "node:child_process";

import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import { bold, cyan, dim, green } from "@visulima/colorize";
import { basename, relative } from "@visulima/path";

import { resolveSharedCacheDirectory } from "../../cache/cache-directory";
import { findVisConfigFile } from "../../config/config";
import { collectFmtDoctor, formatFmtDoctor } from "../../fmt/doctor";
import { decideFmtEngine } from "../../fmt/engine";
import type { FmtResolution } from "../../fmt/resolve-options";
import { describeFmtSource, resolveFmtOptions } from "../../fmt/resolve-options";
import { hasGlobs, runOxfmt, TRANSIENT_CONFIG_PATTERN, TRANSIENT_CONFIG_PREFIX } from "../../fmt/run-oxfmt";
import { biomeAdapter } from "../../lint-fmt/adapters/biome";
import { dprintAdapter } from "../../lint-fmt/adapters/dprint";
import { BUNDLED_OXFMT_EXTENSIONS, oxfmtAdapter } from "../../lint-fmt/adapters/oxfmt";
import { prettierAdapter } from "../../lint-fmt/adapters/prettier";
import { ruffFmtAdapter } from "../../lint-fmt/adapters/ruff";
import type { AdapterId, AdapterRunOptions, Finding, FmtAdapterId, RunResult } from "../../lint-fmt/config-types";
import { detectAdapters } from "../../lint-fmt/detect";
import { changedFilesSince, stagedFiles } from "../../lint-fmt/diff";
import type { OutputSink } from "../../lint-fmt/output";
import { resolveOutput } from "../../lint-fmt/output";
import { adaptersByKind, registerAdapters, routeFilesByExtension, warnUnknownAdapterIds } from "../../lint-fmt/registry";
import { emitGitHub } from "../../lint-fmt/reporters/github";
import { emitJUnit } from "../../lint-fmt/reporters/junit";
import { emitSarif } from "../../lint-fmt/reporters/sarif";
import { aggregate, exitCodeFor, groupFindingsByFile } from "../../lint-fmt/results";
import type { AdapterJob } from "../../lint-fmt/runner";
import { runAdaptersParallel } from "../../lint-fmt/runner";
import { runWatchLoop } from "../../lint-fmt/watch-loop";
import { importTs } from "../../runtime/ts-loader";
import type { FmtOptions } from "./index";

const FORMAT_ADAPTERS = [oxfmtAdapter, biomeAdapter, dprintAdapter, prettierAdapter, ruffFmtAdapter];

const execute = async ({ logger, options, visConfig, workspaceRoot }: Toolbox<Console, FmtOptions>): Promise<void> => {
    const root = workspaceRoot ?? process.cwd();
    const fmtConfig = visConfig?.fmt;

    warnUnknownAdapterIds(logger, "fmt", fmtConfig);
    const adapters = registerAdapters(FORMAT_ADAPTERS, fmtConfig?.order);
    const detected = detectAdapters(root, adapters);
    const allEligible = adaptersByKind(detected, adapters, "fmt");
    const enabled = allEligible.filter(({ adapter }) => fmtConfig?.adapters?.[adapter.id as FmtAdapterId]?.enabled !== false);
    const engineInput = {
        builtin: fmtConfig?.adapters?.oxfmt?.builtin,
        detected: enabled.map(({ adapter }) => adapter.id as FmtAdapterId),
        engine: fmtConfig?.engine,
        oxfmtEnabled: fmtConfig?.adapters?.oxfmt?.enabled !== false,
    };

    if (options.doctor) {
        await runDoctor({ engineInput, fmtConfig, format: options.format ?? "human", logger, output: options.output, prettierDeclared: enabled.some(({ adapter }) => adapter.id === "prettier"), root });

        return;
    }

    const bundled = decideFmtEngine(engineInput).engine === "bundled";
    const format = options.format ?? "human";
    const announce = format === "human" && !options.quiet;

    let resolution: FmtResolution | undefined;
    let eligible = enabled;

    if (bundled) {
        // The bundled oxfmt is the only formatter that runs, so no file is formatted twice.
        resolution = await resolveFmtOptions({ fmtConfig, loadModule: importTs, prettierDeclared: enabled.some(({ adapter }) => adapter.id === "prettier"), root });
        eligible = [{ adapter: oxfmtAdapter, presence: detected.get("oxfmt") ?? { adapter: "oxfmt", declared: false, root } }];

        for (const warning of resolution.warnings) {
            logger.warn(`vis fmt: ${warning}`);
        }

        if (fmtConfig?.engine !== "oxfmt" && (resolution.source === "prettier" || enabled.some(({ adapter }) => adapter.id === "prettier"))) {
            logger.warn('vis fmt: formatting with the bundled oxfmt instead of Prettier; the output can differ. Set `fmt.engine: "prettier"` in vis.config to keep running Prettier.');
        }

        if (announce) {
            logger.info(
                resolution.source === "defaults" ? "vis fmt: no config found, using oxfmt defaults" : `vis fmt: formatting with ${describeFmtSource(resolution, root)}`,
            );

            // Only a config with globs is written to the workspace root; any other lives in the vis cache.
            if (resolution.config !== undefined && hasGlobs(resolution.config)) {
                hintGitignore(root, logger);
            }
        }
    } else if (eligible.length === 0) {
        logger.warn("vis fmt: no formatter detected in this workspace (looked for: oxfmt, biome, dprint, prettier, ruff).");

        return;
    }

    const baseExtraArgs = (adapterId: AdapterJob["adapter"]["id"]): string[] | undefined => {
        const extra = fmtConfig?.adapters?.[adapterId as FmtAdapterId]?.extraArgs;

        return extra && extra.length > 0 ? [...extra] : undefined;
    };

    const runOptions: AdapterRunOptions = { quiet: options.quiet ?? false };
    const positional = collectPositional(options);
    const mode: "check" | "fix" = options.check ? "check" : "fix";

    let sinceFiles: string[] | undefined;

    if (options.staged) {
        sinceFiles = stagedFiles(root)?.filter((file) => !isTransientConfig(file));

        if (sinceFiles === undefined) {
            logger.warn("vis fmt: could not resolve --staged (not a git repo or git unavailable). Falling back to a workspace-wide run.");
        } else if (sinceFiles.length === 0) {
            logger.info(green("✓ fmt: no staged files"));

            return;
        }
    } else if (typeof options.since === "string" && options.since.length > 0) {
        sinceFiles = changedFilesSince(root, options.since)?.filter((file) => !isTransientConfig(file));

        if (sinceFiles === undefined) {
            logger.warn(`vis fmt: could not resolve --since ${options.since} (not a git repo or unknown ref). Falling back to a workspace-wide run.`);
        } else if (sinceFiles.length === 0) {
            logger.info(green(`✓ fmt: no files changed since ${options.since}`));

            return;
        }
    }

    const cacheRoot = resolveSharedCacheDirectory(root, undefined, undefined, true);

    if (format === "human" && options.output !== undefined) {
        logger.warn("vis fmt: --output is ignored for the human format; pass --format json|minimal|sarif|junit|github to redirect findings to a file.");
    }

    const runCycle = async (cycleFiles: string[] | undefined): Promise<void> => {
        // Resolution precedence: explicit positional > cycle files (flag-derived or watch event) > workspace-wide.
        const explicit = positional.length > 0 ? positional : cycleFiles;
        const jobs: AdapterJob[] = [];

        if (explicit) {
            // Route each explicit file to the adapter that owns its extension. The bundled oxfmt takes every
            // file and skips the ones it does not format itself.
            const grouped = bundled ? new Map<AdapterId, string[]>([["oxfmt", explicit]]) : routeFilesByExtension(explicit, eligible, fmtConfig?.extensionOverrides);

            for (const { adapter, presence } of eligible) {
                const files = grouped.get(adapter.id);

                if (!files || files.length === 0) {
                    continue;
                }

                const extra = baseExtraArgs(adapter.id);
                const job: AdapterJob = { adapter, files, presence };

                if (extra) {
                    job.options = { ...runOptions, extraArgs: extra };
                }

                jobs.push(job);
            }
        } else {
            // No explicit file list — each adapter runs against `.` so its own
            // ignore semantics filter the workspace.
            for (const { adapter, presence } of eligible) {
                const extra = baseExtraArgs(adapter.id);
                const job: AdapterJob = { adapter, files: ["."], presence };

                if (extra) {
                    job.options = { ...runOptions, extraArgs: extra };
                }

                jobs.push(job);
            }
        }

        if (jobs.length === 0) {
            return;
        }

        const rawResults = bundled
            ? [await runOxfmt({ config: resolution?.config, extraArgs: jobs[0]!.options?.extraArgs, files: jobs[0]!.files, mode, root })]
            : await runAdaptersParallel(jobs, runOptions, mode, { cacheRoot });
        const toolFailure = bundled ? reportToolFailure(rawResults[0]!, logger) : false;
        const runs = jobs.map((job, index) => {
            const raw = rawResults[index]!;
            // A transient config a killed run left behind is not the user's file, whatever oxfmt says about it.
            const findings = job.adapter.parse(raw, job.presence).filter((finding) => !bundled || !isTransientConfig(finding.file));

            return { adapter: job.adapter, durationMs: raw.durationMs, exitCode: raw.exitCode, findings };
        });

        const result = aggregate(
            runs.map((run) => {
                return {
                    adapter: run.adapter.id,
                    durationMs: run.durationMs,
                    exitCode: run.exitCode,
                    findingCount: run.findings.length,
                    findings: run.findings,
                };
            }),
        );

        const sink = format === "human" ? undefined : resolveOutput({ cwd: root, target: options.output });

        try {
            switch (format) {
                case "github": {
                    sink!.write(
                        emitGitHub({
                            runs: runs.map((run) => {
                                return { findings: run.findings };
                            }),
                            workspaceRoot: root,
                        }),
                    );

                    break;
                }
                case "json": {
                    sink!.write(`${JSON.stringify({ findings: result.findings, mode, runs: result.runs }, null, 2)}\n`);

                    break;
                }
                case "junit": {
                    sink!.write(
                        emitJUnit({
                            runs: runs.map((run) => {
                                return { adapter: run.adapter.id, durationMs: run.durationMs, findings: run.findings };
                            }),
                            workspaceRoot: root,
                        }),
                    );

                    break;
                }
                case "minimal": {
                    printMinimal(result.findings, root, sink!);

                    break;
                }
                case "sarif": {
                    sink!.write(
                        emitSarif({
                            runs: runs.map((run) => {
                                return {
                                    adapter: run.adapter.id,
                                    findings: run.findings,
                                    presence: jobs.find((job) => job.adapter.id === run.adapter.id)?.presence,
                                };
                            }),
                            workspaceRoot: root,
                        }),
                    );

                    break;
                }
                default: {
                    printHuman(result.findings, root, mode, logger, bundled);
                }
            }
        } finally {
            sink?.close();
        }

        // In `fix` mode, "would change" findings shouldn't fail the run — the
        // tool just wrote them. Only escalate when the user asked for `--check`.
        const exitCode = toolFailure
            ? 1
            : mode === "fix"
                ? (result.hadProcessFailure ? 1 : 0)
                : exitCodeFor({ ...result, maxSeverity: result.findings.length > 0 ? "error" : undefined });

        if (exitCode !== 0) {
            process.exitCode = exitCode;
        }
    };

    if (options.watch) {
        const extensions = bundled ? [...BUNDLED_OXFMT_EXTENSIONS] : [...new Set(eligible.flatMap(({ adapter }) => adapter.extensions))];

        await runWatchLoop({
            extensions,
            ignore: isTransientConfig,
            initialFiles: sinceFiles,
            label: "fmt",
            log: (message) => {
                logger.info(message);
            },
            runCycle,
            workspaceRoot: root,
        });

        return;
    }

    await runCycle(sinceFiles);
};

interface DoctorInput {
    engineInput: Parameters<typeof decideFmtEngine>[0];
    fmtConfig: NonNullable<Toolbox["visConfig"]>["fmt"];
    format: string;
    logger: Toolbox["logger"];
    output: string | undefined;
    prettierDeclared: boolean;
    root: string;
}

/** `vis fmt --doctor`: reports the engine and config source without formatting or writing anything. Exit 2 when the config cannot be read. */
const runDoctor = async ({ engineInput, fmtConfig, format, logger, output, prettierDeclared, root }: DoctorInput): Promise<void> => {
    try {
        const engine = decideFmtEngine(engineInput);
        const resolution = engine.engine === "bundled" ? await resolveFmtOptions({ fmtConfig, loadModule: importTs, prettierDeclared, root }) : undefined;
        const report = collectFmtDoctor({ adapters: engineInput.detected, engine, resolution, root, visConfigFile: findVisConfigFile(root) });

        if (format === "json") {
            const sink = resolveOutput({ cwd: root, target: output });

            try {
                sink.write(`${JSON.stringify(report, null, 2)}\n`);
            } finally {
                sink.close();
            }

            return;
        }

        for (const line of formatFmtDoctor(report)) {
            logger.info(line);
        }
    } catch (error) {
        logger.error(`vis fmt --doctor: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
    }
};

const isTransientConfig = (file: string): boolean => basename(file).startsWith(TRANSIENT_CONFIG_PREFIX);

/** Prints oxfmt's own error output when it failed (exit other than 0 or 1); true when it did. */
const reportToolFailure = (raw: RunResult, logger: Toolbox["logger"]): boolean => {
    if (raw.exitCode === 0 || raw.exitCode === 1) {
        return false;
    }

    logger.error(raw.stderr.trim() || `vis fmt: oxfmt exited with ${raw.exitCode === null ? "no exit code" : `code ${String(raw.exitCode)}`}.`);

    return true;
};

const hintGitignore = (root: string, logger: Toolbox["logger"]): void => {
    // Exit 1 means "not ignored"; 128 (not a repository) and a missing git stay quiet.
    if (spawnSync("git", ["check-ignore", "-q", `${TRANSIENT_CONFIG_PREFIX}x.json`], { cwd: root }).status === 1) {
        logger.info(dim(`vis fmt: a temporary ${TRANSIENT_CONFIG_PATTERN} is written to the workspace root while it runs; add it to .gitignore.`));
    }
};

const collectPositional = (options: FmtOptions): string[] => {
    const bag = options as unknown as { _?: ReadonlyArray<string>; args?: ReadonlyArray<string> };

    return [...(bag._ ?? bag.args ?? [])];
};

// `oxfmt --write` does not report what it rewrote, so the bundled fix run cannot say "nothing to change".
const printHuman = (findings: ReadonlyArray<Finding>, root: string, mode: "check" | "fix", logger: Toolbox["logger"], bundled: boolean): void => {
    if (findings.length === 0) {
        logger.info(green(mode === "check" ? "✓ fmt: all files already formatted" : bundled ? "✓ fmt: formatted with oxfmt" : "✓ fmt: nothing to change"));

        return;
    }

    const grouped = groupFindingsByFile(findings);
    const heading = mode === "fix" ? cyan(bold("Formatted:")) : bold("Would change:");

    logger.info(heading);

    for (const file of grouped.keys()) {
        logger.info(`  ${dim("·")} ${relative(root, file)}`);
    }

    if (mode === "check") {
        logger.info("");
        logger.info(dim(`Run \`vis fmt\` to apply changes (${String(grouped.size)} file${grouped.size === 1 ? "" : "s"}).`));
    }
};

const printMinimal = (findings: ReadonlyArray<Finding>, root: string, sink: OutputSink): void => {
    for (const finding of findings) {
        sink.write(`${finding.adapter}\t${relative(root, finding.file)}\n`);
    }
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
