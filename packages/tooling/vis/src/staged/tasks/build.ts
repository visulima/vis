import { isAbsolute, relative, resolve } from "@visulima/path";

import { quoteArgument } from "../../util/command-string";
import { ConfigError } from "../errors";
import { matchFiles } from "../match";
import type { CommandDescriptor, CommandTask, CustomTask, PatternDescriptor, StagedTask } from "../types";

const isCustomTask = (value: unknown): value is CustomTask =>
    typeof value === "object" && value !== null && typeof (value as CustomTask).title === "string" && typeof (value as CustomTask).task === "function";

/**
 * A command task carries a `command` string and, unlike {@link CustomTask},
 * no `task` function. The `task`-absent check keeps the two object forms
 * unambiguous so a `{ title, task }` custom task is never misread as a
 * command task.
 */
const isCommandTask = (value: unknown): value is CommandTask =>
    typeof value === "object"
    && value !== null
    && typeof (value as CommandTask).command === "string"
    && typeof (value as Partial<CustomTask>).task !== "function";

/** True when `file` is `dir` itself or nested anywhere beneath it. Separator-agnostic. */
const isUnder = (dir: string, file: string): boolean => {
    const rel = relative(dir, file);

    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Returns the deepest workspace package directory that contains `file`, or
 * `undefined` when the file sits under none of them. Deepest wins so a
 * package nested inside another (e.g. `packages/group/pkg`) claims its own
 * files instead of the outer directory.
 */
const ownerPackage = (file: string, packageDirs: ReadonlyArray<string>): string | undefined => {
    let best: string | undefined;

    for (const dir of packageDirs) {
        if (isUnder(dir, file) && (best === undefined || dir.length > best.length)) {
            best = dir;
        }
    }

    return best;
};

/**
 * The targets named by the `^`-prefixed entries of `dependsOn`. Anything else is a
 * `ConfigError` rather than ignored: a dependency that silently never builds
 * leaves the lint reading `any` types, which is the failure the option exists
 * to prevent. `validateConfig` calls it up front, and expansion calls it again
 * for the command tasks a task function returns, which `validateConfig` never sees.
 */
const dependencyTargets = (value: CommandTask): string[] => {
    if (value.dependsOn === undefined) {
        return [];
    }

    if (!Array.isArray(value.dependsOn)) {
        throw new ConfigError(`\`dependsOn\` of "${value.command}" must be an array such as ["^build"].`);
    }

    return value.dependsOn.map((entry: unknown) => {
        if (typeof entry !== "string" || !/^\^[^\s^:-][^\s^]*$/.test(entry)) {
            throw new ConfigError(
                `\`dependsOn\` entry ${JSON.stringify(entry)} of "${value.command}" is not supported — staged tasks only take the dependency form "^<target>", e.g. "^build".`,
            );
        }

        return entry.slice(1);
    });
};

/**
 * The `vis run` that builds `target` for the dependencies of every owning
 * package. Path selectors (`{packages/a}^...`) use the directories already
 * resolved for `perPackage`, so no package name has to be read.
 *
 * - `:target` is the all-projects form; a bare `type-check:emit` would read as
 *   project `type-check`, target `emit`.
 * - `--if-present` keeps a package without workspace dependencies (an empty
 *   selection) from failing the hook.
 * - The lockfile and toolchain preflights are skipped: the hook hides unstaged
 *   changes, so a staged `package.json` without its lockfile reads as drift,
 *   which fails in CI and would skip every staged command.
 */
const dependencyBuildCommand = (target: string, packageDirectories: ReadonlyArray<string>, cwd: string, visEntry: ReadonlyArray<string>): string =>
    [
        ...visEntry.map((argument) => quoteArgument(argument)),
        "run",
        quoteArgument(`:${target}`),
        "--if-present",
        "--no-preflight",
        "--skip-toolchain",
        ...packageDirectories.flatMap((directory) => ["-F", quoteArgument(`{${relative(cwd, directory)}}^...`)]),
    ].join(" ");

export interface BuildTaskGraphOptions {
    /** Match globs case-insensitively — enable on HFS+/APFS (macOS) and NTFS (Windows). */
    readonly caseInsensitive?: boolean;
    readonly config: Readonly<Record<string, StagedTask>>;
    readonly cwd: string;
    readonly files: ReadonlyArray<string>;
    readonly relative?: boolean;

    /** Program and leading arguments that start the vis CLI; required when a task sets `dependsOn`. */
    readonly visEntry?: ReadonlyArray<string>;

    /** Receives a warning when a `dependsOn` build cannot be set up, such as an unresolved workspace. */
    readonly warn?: (message: string) => void;
    /** Absolute workspace package directories, used to fan out `perPackage` command tasks. */
    readonly workspacePackages?: ReadonlyArray<string>;
}

/** Builds the list of pattern descriptors that the runner will execute. */
export const buildTaskGraph = async (options: BuildTaskGraphOptions): Promise<PatternDescriptor[]> => {
    // Counters are scoped to this call so ids don't leak across invocations and the module stays side-effect-free.
    let patternCounter = 0;
    let commandCounter = 0;

    const nextPatternId = (): string => {
        patternCounter += 1;

        return `pattern-${patternCounter}`;
    };

    const nextCommandId = (): string => {
        commandCounter += 1;

        return `cmd-${commandCounter}`;
    };

    const dependency = { packages: new Set<string>(), targets: new Set<string>() };

    /** Records the owning packages of `absoluteFiles` for the shared `dependsOn` build. Files under no package add nothing. */
    const collectDependencies = (value: CommandTask, absoluteFiles: ReadonlyArray<string>): void => {
        const targets = dependencyTargets(value);

        if (targets.length === 0) {
            return;
        }

        for (const target of targets) {
            dependency.targets.add(target);
        }

        for (const file of absoluteFiles) {
            const owner = ownerPackage(file, options.workspacePackages ?? []);

            if (owner !== undefined && relative(options.cwd, owner) !== "") {
                dependency.packages.add(owner);
            }
        }
    };

    /**
     * Expands a command task into one descriptor per execution unit:
     *
     * - `perPackage` groups the absolute matched files by owning workspace
     *   package and emits a descriptor per package (cwd = package dir, files
     *   relative to it). Files under no package collapse into a single
     *   root-cwd run.
     * - a fixed `cwd` emits one descriptor with that cwd and absolute file
     *   paths so they resolve from wherever the command runs.
     * - neither set behaves exactly like a bare command string.
     */
    const expandCommandTask = (value: CommandTask, view: ReadonlyArray<string>, absoluteFiles: ReadonlyArray<string>, commands: CommandDescriptor[]): void => {
        collectDependencies(value, absoluteFiles);

        if (value.perPackage === true) {
            const packageDirs = options.workspacePackages ?? [];
            const groups = new Map<string, string[]>();

            for (const file of absoluteFiles) {
                const dir = ownerPackage(file, packageDirs) ?? options.cwd;
                const bucket = groups.get(dir) ?? [];

                bucket.push(relative(dir, file));
                groups.set(dir, bucket);
            }

            for (const dir of [...groups.keys()].sort()) {
                const label = relative(options.cwd, dir) || ".";

                commands.push({
                    command: value.command,
                    cwd: dir,
                    files: groups.get(dir) ?? [],
                    id: nextCommandId(),
                    source: "string",
                    title: `${value.command} — ${label}`,
                });
            }

            return;
        }

        if (value.cwd !== undefined) {
            const dir = resolve(options.cwd, value.cwd);

            commands.push({
                command: value.command,
                cwd: dir,
                // Absolute paths so the files resolve no matter the cwd.
                files: absoluteFiles,
                id: nextCommandId(),
                source: "string",
                title: `${value.command} — ${relative(options.cwd, dir) || "."}`,
            });

            return;
        }

        commands.push({
            command: value.command,
            files: view,
            id: nextCommandId(),
            source: "string",
            title: value.command,
        });
    };

    const expandTask = async (
        value: StagedTask,
        files: ReadonlyArray<string>,
        absoluteFiles: ReadonlyArray<string>,
        commands: CommandDescriptor[],
    ): Promise<void> => {
        if (typeof value === "string") {
            commands.push({
                command: value,
                files,
                id: nextCommandId(),
                source: "string",
                title: value,
            });

            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                await expandTask(item as StagedTask, files, absoluteFiles, commands);
            }

            return;
        }

        if (isCommandTask(value)) {
            expandCommandTask(value, files, absoluteFiles, commands);

            return;
        }

        if (typeof value === "function") {
            const generated = await value([...files]);

            if (typeof generated === "string") {
                commands.push({
                    command: generated,
                    files,
                    id: nextCommandId(),
                    source: "function",
                    title: generated,
                    verbatim: true,
                });

                return;
            }

            if (Array.isArray(generated)) {
                for (const item of generated) {
                    if (typeof item === "string") {
                        commands.push({
                            command: item,
                            files,
                            id: nextCommandId(),
                            source: "function",
                            title: item,
                            verbatim: true,
                        });
                    } else if (isCommandTask(item)) {
                        expandCommandTask(item, files, absoluteFiles, commands);
                    } else if (isCustomTask(item)) {
                        commands.push({
                            files,
                            id: nextCommandId(),
                            run: item.task,
                            source: "custom",
                            title: item.title,
                        });
                    } else {
                        throw new ConfigError(
                            "Task function returned an array with an unsupported entry — expected strings, { command, … }, or { title, task }.",
                        );
                    }
                }

                return;
            }

            if (isCommandTask(generated)) {
                expandCommandTask(generated, files, absoluteFiles, commands);

                return;
            }

            if (isCustomTask(generated)) {
                commands.push({
                    files,
                    id: nextCommandId(),
                    run: generated.task,
                    source: "custom",
                    title: generated.title,
                });

                return;
            }

            throw new ConfigError("Task function returned an unsupported value — expected string, string[], { command, … }, or { title, task }.");
        }

        if (isCustomTask(value)) {
            commands.push({
                files,
                id: nextCommandId(),
                run: value.task,
                source: "custom",
                title: value.title,
            });

            return;
        }

        throw new ConfigError("Unsupported task value — expected string, string[], function, { command, … }, or { title, task }.");
    };

    const patterns: PatternDescriptor[] = [];

    for (const [pattern, value] of Object.entries(options.config)) {
        const matched = matchFiles(pattern, options.files, options.cwd, { caseInsensitive: options.caseInsensitive === true });

        if (matched.length === 0) {
            continue;
        }

        const view = options.relative ? matched.map((file) => relative(options.cwd, file)) : matched;
        const commands: CommandDescriptor[] = [];

        // `matched` is always absolute; per-package fan-out groups by it
        // regardless of the `relative` view passed to plain commands.
        await expandTask(value, view, matched, commands);

        if (commands.length === 0) {
            continue;
        }

        patterns.push({
            commands,
            files: view,
            id: nextPatternId(),
            pattern,
            title: `${pattern} — ${matched.length} file${matched.length === 1 ? "" : "s"}`,
        });
    }

    if (dependency.targets.size === 0 || patterns.length === 0) {
        return patterns;
    }

    if ((options.workspacePackages ?? []).length === 0) {
        options.warn?.("`dependsOn` is set, but no workspace packages were found, so their dependencies were not built.");

        return patterns;
    }

    if (dependency.packages.size === 0) {
        return patterns;
    }

    const { visEntry } = options;

    if (visEntry === undefined) {
        throw new Error("buildTaskGraph needs `visEntry` to build `dependsOn` targets.");
    }

    const packages = [...dependency.packages].sort();
    const label = `${packages.length} package${packages.length === 1 ? "" : "s"}`;

    // One prerequisite per target; runTasks runs them in order before anything else.
    const prerequisites = [...dependency.targets].map((target): PatternDescriptor => {
        const title = `${target} dependencies of ${label}`;
        const command = dependencyBuildCommand(target, packages, options.cwd, visEntry);

        return {
            commands: [{ command, files: [], id: nextCommandId(), source: "string", title, verbatim: true }],
            files: [],
            id: nextPatternId(),
            pattern: "dependsOn",
            prerequisite: true,
            title,
        };
    });

    return [...prerequisites, ...patterns];
};

export { dependencyTargets, isCommandTask, isCustomTask };
