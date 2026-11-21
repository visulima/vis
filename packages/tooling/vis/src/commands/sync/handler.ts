import { isDeepStrictEqual } from "node:util";

import type { CerebroFs, CommandExecute, Toolbox } from "@visulima/cerebro";
import { writeJsonSync } from "@visulima/fs";
import { join, relative } from "@visulima/path";
import { parse as parseYaml } from "@visulima/yaml";
import zeptomatch from "zeptomatch";

import type { CodeownersSource } from "../../config/workspace";
import { discoverWorkspace } from "../../config/workspace";
import { VisUserError } from "../../errors/vis-user-error";
import { detectPackageManager } from "../../preflight/lockfile";
import { buildCiWorkflowPlan, isCiWorkflowProvider, renderCiWorkflows } from "../../util/ci-workflow";
import { detectEcosystems } from "../../util/ci-workflow/ecosystems";
import { gitlabMissingToolchains } from "../../util/ci-workflow/gitlab";
import { resolveCiWorkflowProviders } from "../../util/ci-workflow/providers";
import type { CodeownersLine } from "../../util/codeowners";
import { buildCodeownersLines, DEFAULT_BLOCK_MARKER, mergeIntoExisting, renderCodeowners, renderCodeownersBlock } from "../../util/codeowners";
import { collectMaintainerLines, collectNestedCodeownersLines } from "../../util/codeowners-sources";
import { resolveIndentForExistingFile } from "../../util/editorconfig";
import { syncGeneratedFiles } from "../../util/generated-files";
import getPackageVersion from "../../util/package-version";
import type { SyncFieldsChange } from "../../util/sync-package-json-fields";
import { applyFieldChanges, computeFieldChanges, DEFAULT_SYNCED_FIELDS } from "../../util/sync-package-json-fields";
import { collectWorkspaceDirectories, readPkg } from "../../util/workspace-deps";
import type { RestrictedProject } from "../../util/write-guard";
import { buildWriteGuardArtifacts } from "../../util/write-guard";
import type { SyncOptions } from "./index";

const KNOWN_SOURCES: ReadonlySet<CodeownersSource> = new Set<CodeownersSource>(["nested-codeowners", "package-json-maintainers", "project-json"]);

/**
 * Parses a repeated CLI flag like `--fields license,engines --fields author`
 * into a deduped string list. `cerebro` returns one entry per flag
 * occurrence; users typically write a single comma-separated value, so
 * we split each entry too. Falls back to the supplied default when the
 * normalised list is empty. The optional `validate` hook rejects unknown
 * tokens (used by `--from` to gate codeowners sources).
 */
const parseCsvOption = <T extends string>(raw: string[] | undefined, fallback: ReadonlyArray<T>, validate?: (value: string) => value is T): T[] => {
    const seen = new Set<T>();
    const out: T[] = [];

    for (const entry of raw ?? []) {
        for (const piece of entry.split(",")) {
            const name = piece.trim();

            if (name.length === 0) {
                continue;
            }

            if (validate && !validate(name)) {
                throw new Error(`Unknown codeowners source: "${name}". Known: ${[...KNOWN_SOURCES].join(", ")}.`);
            }

            const typed = name as T;

            if (seen.has(typed)) {
                continue;
            }

            seen.add(typed);
            out.push(typed);
        }
    }

    return out.length > 0 ? out : [...fallback];
};

const isCodeownersSource = (value: string): value is CodeownersSource => KNOWN_SOURCES.has(value as CodeownersSource);

const KNOWN_KINDS = ["ci-workflow", "codeowners", "package-json-fields"] as const;

interface PackageWrite {
    filePath: string;
    packageJsonPath: string;
    packageName: string | undefined;
    pkg: Record<string, unknown>;
    pkgChanges: SyncFieldsChange[];
}

interface PackageJsonReportChange {
    after: unknown;
    before: unknown;
    field: string;
    packageJsonPath: string;
    packageName: string | undefined;
}

interface PackageJsonReport {
    changes: PackageJsonReportChange[];
    fields: string[];
    kind: "package-json-fields";
    mode: "check" | "write";
    totalChanges: number;
    totalPackages: number;
}

const matchesAnyGlob = (name: string, globs: string[]): boolean => globs.some((pattern) => zeptomatch(pattern, name));

/**
 * Emits (or, in check mode, verifies) the GitHub + GitLab Write Guard
 * CI artefacts for every project flagged `restricted: true`. Runs
 * independently of the CODEOWNERS sync so it still fires when there
 * are no `owners` entries. No-ops silently when nothing is restricted.
 */
const handleWriteGuard = async (
    fs: CerebroFs,
    logger: Console,
    root: string,
    workspace: { projects: Record<string, { restricted?: boolean; root?: string }> },
    checkMode: boolean,
): Promise<void> => {
    const restricted: RestrictedProject[] = Object.entries(workspace.projects)
        .filter(([, project]) => project.restricted === true)
        .map(([name, project]) => {
            return { name, root: project.root ?? name };
        });

    const artifacts = buildWriteGuardArtifacts(restricted);

    if (artifacts.length === 0) {
        logger.info("No projects flagged `restricted: true` in project.json. Skipping Write Guard.");

        return;
    }

    const { stale } = await syncGeneratedFiles(artifacts, {
        fs,
        logger,
        mode: checkMode ? "check" : "write",
        regenerateCommand: "vis sync codeowners --write-guard",
        root,
    });

    if (checkMode) {
        if (stale.length > 0) {
            process.exitCode = 1;
        } else {
            logger.info(`Write Guard CI is up to date (${artifacts.length} files, ${restricted.length} restricted projects).`);
        }

        return;
    }

    logger.info(`Write Guard CI scoped to ${restricted.length} restricted project${restricted.length === 1 ? "" : "s"}.`);
};

const runCodeowners = async ({ fs, logger, options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, SyncOptions>): Promise<void> => {
    const root = wsRoot as string;
    const { workspace } = discoverWorkspace(root, visConfig);
    const codeownersConfig = visConfig?.codeowners;

    if (options.writeGuard) {
        await handleWriteGuard(fs, logger, root, workspace, options.check);
    }

    const sources = parseCsvOption<CodeownersSource>(options.from, codeownersConfig?.sources ?? ["project-json"], isCodeownersSource);
    const regenerationCommand = options.regenerationCommand ?? codeownersConfig?.regenerationCommand;
    const preserveBlock = options.preserveBlock || codeownersConfig?.preserveBlock === true;
    const marker = codeownersConfig?.blockMarker ?? DEFAULT_BLOCK_MARKER;
    const nestedIncludes = options.nestedIncludes ?? codeownersConfig?.nestedIncludes;
    const outRelative = options.out ?? "CODEOWNERS";

    const extraLines: CodeownersLine[] = [];

    if (sources.includes("nested-codeowners")) {
        const nestedLines = await collectNestedCodeownersLines(root, nestedIncludes, outRelative);

        for (const line of nestedLines) {
            extraLines.push({ ...line, source: "nested" });
        }
    }

    if (sources.includes("package-json-maintainers")) {
        const maintainerLines = collectMaintainerLines(workspace, root);

        for (const line of maintainerLines) {
            extraLines.push({ ...line, source: "maintainers" });
        }
    }

    const lines = sources.includes("project-json")
        ? buildCodeownersLines(workspace, codeownersConfig, extraLines)
        : buildCodeownersLines({ projects: {} }, codeownersConfig, extraLines);

    if (lines.length === 0) {
        logger.info("No `owners` entries found in any source. Nothing to sync.");

        return;
    }

    const outPath = join(root, outRelative);

    let existing = "";

    try {
        existing = await fs.readFile(outPath, "utf8");
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }

    const renderOptions = { regenerationCommand };
    const rendered = preserveBlock
        ? mergeIntoExisting(existing, renderCodeownersBlock(lines, marker, renderOptions), marker)
        : renderCodeowners(lines, renderOptions);

    const { stale } = await syncGeneratedFiles([{ content: rendered, path: relative(root, outPath) }], {
        fs,
        logger,
        mode: options.check ? "check" : "write",
        regenerateCommand: "vis sync codeowners",
        root,
    });

    if (stale.length > 0) {
        process.exitCode = 1;
    } else if (options.check) {
        logger.info(`${outPath} is up to date.`);
    } else {
        logger.info(`Wrote ${lines.length} entries to ${outPath}`);
    }
};

const runPackageJsonFields = ({ logger, options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, SyncOptions>): void => {
    const root = wsRoot as string;
    const useEditorconfig = visConfig?.editorconfig ?? true;
    const rootPkg = readPkg(join(root, "package.json"));

    if (!rootPkg) {
        logger.error("Could not read root package.json. Nothing to sync.");
        process.exitCode = 1;

        return;
    }

    const fields = parseCsvOption(options.fields, DEFAULT_SYNCED_FIELDS);
    const ignoreGlobs = options.ignorePackageName ?? [];
    const checkMode = options.check;
    const format = (options.format ?? "human").toLowerCase();
    const { quiet } = options;

    const packageDirs = collectWorkspaceDirectories(root).filter((dir) => dir !== ".");
    const writes: PackageWrite[] = [];
    let scanned = 0;

    for (const dir of packageDirs) {
        const filePath = join(root, dir, "package.json");
        const pkg = readPkg(filePath);

        if (!pkg) {
            continue;
        }

        const pkgName = typeof pkg.name === "string" ? pkg.name : undefined;

        if (pkgName !== undefined && ignoreGlobs.length > 0 && matchesAnyGlob(pkgName, ignoreGlobs)) {
            continue;
        }

        scanned += 1;

        const pkgChanges = computeFieldChanges(rootPkg, pkg, { fields });

        if (pkgChanges.length === 0) {
            continue;
        }

        writes.push({
            filePath,
            packageJsonPath: relative(root, filePath),
            packageName: pkgName,
            pkg,
            pkgChanges,
        });
    }

    if (!checkMode) {
        for (const write of writes) {
            applyFieldChanges(write.pkg, write.pkgChanges);
            writeJsonSync(write.filePath, write.pkg, { indent: resolveIndentForExistingFile(write.filePath, { useEditorconfig }), overwrite: true });
        }
    }

    const reportChanges: PackageJsonReportChange[] = writes.flatMap((write) =>
        write.pkgChanges.map((change) => {
            return {
                after: change.after,
                before: change.before,
                field: change.field,
                packageJsonPath: write.packageJsonPath,
                packageName: write.packageName,
            };
        }),
    );

    const report: PackageJsonReport = {
        changes: reportChanges,
        fields,
        kind: "package-json-fields",
        mode: checkMode ? "check" : "write",
        totalChanges: reportChanges.length,
        totalPackages: scanned,
    };

    if (format === "json") {
        process.stdout.write(`${JSON.stringify(report, null, 4)}\n`);
    } else if (reportChanges.length === 0) {
        logger.info(`All ${scanned} package${scanned === 1 ? "" : "s"} in sync (fields: ${fields.join(", ")}).`);
    } else if (checkMode) {
        if (!quiet) {
            for (const change of reportChanges) {
                logger.error(`${change.packageJsonPath}: ${change.field} drifts from root`);
            }
        }

        logger.error(
            `Found ${reportChanges.length} field drift${reportChanges.length === 1 ? "" : "s"} across ${writes.length} package${writes.length === 1 ? "" : "s"}. Run \`vis sync package-json-fields\` to fix.`,
        );
    } else {
        if (!quiet) {
            for (const write of writes) {
                logger.info(`${write.packageJsonPath}: synced ${write.pkgChanges.map((c) => c.field).join(", ")}`);
            }
        }

        logger.info(
            `Synced ${reportChanges.length} field${reportChanges.length === 1 ? "" : "s"} across ${writes.length} package${writes.length === 1 ? "" : "s"}.`,
        );
    }

    if (checkMode && reportChanges.length > 0) {
        process.exitCode = 1;
    }
};

/** Compared as parsed YAML, so a formatter re-indenting or re-quoting the committed file is not drift. */
const sameYaml = (existing: string, generated: string): boolean => {
    try {
        return isDeepStrictEqual(parseYaml(existing), parseYaml(generated));
    } catch {
        return false;
    }
};

/**
 * Generates (or, with --check, verifies) the CI workflow described by
 * `ci.workflow` in vis.config.ts: a GitHub Actions workflow that runs the
 * targets as parallel steps and/or an includable GitLab CI file.
 */
const runCiWorkflow = async ({ fs, logger, options, visConfig, workspaceRoot: wsRoot }: Toolbox<Console, SyncOptions>): Promise<void> => {
    const root = wsRoot as string;
    const { config, workspace } = discoverWorkspace(root, visConfig);
    const settings = config.ci?.workflow ?? {};
    const flag = options.provider === undefined ? undefined : parseCsvOption(options.provider, []);
    const unknown = [...(flag ?? []), ...(settings.providers ?? [])].filter((provider) => !isCiWorkflowProvider(provider));

    if (unknown.length > 0) {
        throw new VisUserError(`Unknown CI provider: ${unknown.map((provider) => `"${provider}"`).join(", ")}. Known: github, gitlab.`);
    }

    const { providers, reason } = await resolveCiWorkflowProviders({
        configured: settings.providers,
        detectRemote: async () => {
            const [{ detectKnownRemoteProvider }, { createShellRunner }] = await Promise.all([
                import("../../release/core/remote/detect"),
                import("../../release/core/shell-runner"),
            ]);

            return detectKnownRemoteProvider(root, createShellRunner());
        },
        exists: async (path) => {
            try {
                await fs.stat(join(root, path));

                return true;
            } catch {
                return false;
            }
        },
        flag: flag?.filter(isCiWorkflowProvider),
        prompt:
            options.check || !process.stdout.isTTY || process.env["CI"] === "true"
                ? undefined
                : async () => {
                    const { multiSelectPrompt } = await import("../../release/core/prompts");

                    return multiSelectPrompt("Which CI providers should vis generate a workflow for?", [
                        { label: "GitHub Actions", value: "github" },
                        { label: "GitLab CI", value: "gitlab" },
                    ]);
                },
    });

    if (providers.length === 0) {
        throw new VisUserError("No CI provider selected. Pass --provider=github,gitlab or set ci.workflow.providers.");
    }

    logger.info(`▸ CI providers: ${providers.join(", ")} (${reason})`);

    // The workspace root plus every project root, with the files directly in each.
    const directories = await Promise.all(
        [...new Set([".", ...Object.values(workspace.projects).map((project) => project.root ?? ".")])].toSorted().map(async (path) => {
            return { files: await fs.readdir(join(root, path)).catch(() => []), path };
        }),
    );
    const rootFiles = new Set(directories.find(({ path }) => path === ".")?.files);

    const { buildFirstOrdered, plan } = buildCiWorkflowPlan({
        cacheDirectory: config.taskRunner?.cacheDirectory,
        defaultBase: config.defaultBase,
        ecosystems: detectEcosystems(directories),
        packageManager: detectPackageManager(root)?.manager,
        projects: workspace.projects,
        rootFiles,
        settings,
        targetDefaults: config.tasks,
        toolchainPins: config.toolchain?.tools,
        visVersion: getPackageVersion(),
    });

    if (plan.ecosystems.length > 0) {
        logger.info(`▸ Toolchains: ${plan.ecosystems.map(({ name }) => name).join(", ")}`);
    }

    const missing = providers.includes("gitlab") ? gitlabMissingToolchains(plan) : [];

    if (missing.length > 0) {
        logger.warn(
            `GitLab jobs run in a node image without ${missing.join(", ")}. Pin go, python, ruby or rust in toolchain.tools so vis installs them, or give .vis-ci-base an image that has them.`,
        );
    }

    if (buildFirstOrdered.length > 0) {
        logger.info(`▸ Running build before ${buildFirstOrdered.join(", ")} (ci.workflow.buildFirst; set it to false if dependsOn already says what needs build).`);
    }

    const { stale } = await syncGeneratedFiles(renderCiWorkflows(plan, providers), {
        fs,
        isCurrent: sameYaml,
        logger,
        mode: options.check ? "check" : "write",
        regenerateCommand: "vis sync ci-workflow",
        root,
    });

    if (stale.length > 0) {
        process.exitCode = 1;

        return;
    }

    logger.info(`CI workflow ${options.check ? "is up to date" : "generated"}: ${plan.layers.map((layer) => layer.map(({ name }) => name).join(" + ")).join(" → ")}`);
};

const execute = async (toolbox: Toolbox<Console, SyncOptions>): Promise<void> => {
    const kind = toolbox.argument[0];

    if (!kind) {
        throw new Error(`Missing sync kind. Usage: vis sync <kind> (known kinds: ${KNOWN_KINDS.join(", ")})`);
    }

    if (!toolbox.workspaceRoot) {
        throw new Error("Could not determine workspace root. Run inside a monorepo.");
    }

    if (kind !== "ci-workflow" && toolbox.options.provider !== undefined) {
        throw new VisUserError(`--provider only applies to \`vis sync ci-workflow\`, not ${kind}.`);
    }

    if (kind === "ci-workflow") {
        await runCiWorkflow(toolbox);

        return;
    }

    if (kind === "codeowners") {
        await runCodeowners(toolbox);

        return;
    }

    if (kind === "package-json-fields") {
        runPackageJsonFields(toolbox);

        return;
    }

    throw new Error(`Unknown sync kind: "${kind}". Known kinds: ${KNOWN_KINDS.join(", ")}.`);
};

export default execute as CommandExecute<Toolbox>;
