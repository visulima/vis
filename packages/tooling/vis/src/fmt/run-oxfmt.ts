import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

import { basename, dirname, join } from "@visulima/path";

import type { RunResult } from "../lint-fmt/config-types";
import type { OxfmtConfig } from "./options";

/** Prefix of the transient config a run writes into the workspace root. */
export const TRANSIENT_CONFIG_PREFIX = ".vis-fmt-";

/** Where a config without globs is kept, relative to the workspace root. oxfmt skips `node_modules`, so the file is never formatted. */
const CACHED_CONFIG_DIRECTORY = "node_modules/.cache/vis/fmt";

/** Glob matching every transient config, including one a crashed run left behind. */
export const TRANSIENT_CONFIG_PATTERN = `${TRANSIENT_CONFIG_PREFIX}*.json`;

/**
 * Locates the `oxfmt` binary shipped as a dependency of vis. The `bin` file is a plain Node script
 * (the platform binary is loaded by it), so it is run with the current Node rather than through `pnpm exec`.
 * @returns Absolute path of the oxfmt CLI entry.
 */
export const resolveOxfmtBin = (): string => {
    const manifestPath = createRequire(import.meta.url).resolve("oxfmt/package.json");
    const { bin } = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: string | Record<string, string> };

    return join(dirname(manifestPath), typeof bin === "string" ? bin : bin.oxfmt!);
};

export interface OxfmtArgsInput {
    /** Path of the config to pass with `-c`, relative to the working directory; omit to let oxfmt discover its own. */
    configPath?: string;
    extraArgs?: ReadonlyArray<string>;
    files: ReadonlyArray<string>;
    mode: "check" | "fix";
}

/**
 * Builds the oxfmt argument list. `--no-error-on-unmatched-pattern` is always set so a path oxfmt does
 * not format (an image, a deleted file, an ignored file) is not an error. `--disable-nested-config` goes
 * with `-c` so the config vis resolved is the only one in play.
 * @param input Mode, files and optional config path.
 * @param input.configPath Config to pass with `-c`, relative to the working directory.
 * @param input.extraArgs Extra arguments, placed before the files.
 * @param input.files Paths to format.
 * @param input.mode `check` lists differing files, `fix` writes.
 * @returns The argument vector, without the binary.
 */
export const buildOxfmtArgs = ({ configPath, extraArgs = [], files, mode }: OxfmtArgsInput): string[] => [
    mode === "fix" ? "--write" : "--list-different",
    "--no-error-on-unmatched-pattern",
    ...(configPath === undefined ? [] : ["-c", configPath, "--disable-nested-config"]),
    ...extraArgs,
    ...files,
];

export interface RunOxfmtOptions {
    /** Test seam: a different CLI entry to run instead of the bundled oxfmt. */
    binPath?: string;

    /**
     * Config to hand to oxfmt. A config with `ignorePatterns` or `overrides` goes through a transient file
     * in `root`, because oxfmt reads those globs relative to the config's directory; any other config is
     * kept in the vis cache. Leave unset when oxfmt should discover its own config (or use its defaults).
     */
    config?: OxfmtConfig;
    extraArgs?: ReadonlyArray<string>;
    files: ReadonlyArray<string>;
    mode: "check" | "fix";

    /** Test seam: called instead of re-raising a caught signal on the process. */
    reRaiseSignal?: (signal: NodeJS.Signals) => void;
    root: string;
}

const SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM"];

/** Whether the config carries a glob that oxfmt reads relative to the config's own directory, so the file has to sit in the workspace root. */
export const hasGlobs = (config: OxfmtConfig): boolean => (config.ignorePatterns?.length ?? 0) > 0 || (config.overrides?.length ?? 0) > 0;

const cachedConfigContent = (config: OxfmtConfig): string => `${JSON.stringify(config, null, 2)}\n`;

/**
 * Where a config without globs is kept: a file named by a hash of its content in `node_modules/.cache/vis/fmt`.
 * @param config Config without `ignorePatterns` or `overrides`.
 * @returns Path of the file, relative to the workspace root.
 */
export const cachedConfigPath = (config: OxfmtConfig): string =>
    join(CACHED_CONFIG_DIRECTORY, `${createHash("sha256").update(cachedConfigContent(config)).digest("hex").slice(0, 16)}.json`);

/**
 * Keeps a config without globs in the vis cache, named by a hash of its content: a run with the same
 * config reuses the file, concurrent runs write identical content, and nothing is removed afterwards.
 * @param root Workspace root.
 * @param config Config without `ignorePatterns` or `overrides`.
 * @returns Path of the file, relative to `root`.
 */
const writeCachedConfig = (root: string, config: OxfmtConfig): string => {
    const content = cachedConfigContent(config);
    const relativePath = cachedConfigPath(config);
    const path = join(root, relativePath);

    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });

        // Written under a private name and renamed, so a concurrent run never reads a half-written file.
        const pending = `${path}.${String(process.pid)}.tmp`;

        writeFileSync(pending, content);
        renameSync(pending, path);
    }

    return relativePath;
};

const writeTransientConfig = (root: string, config: OxfmtConfig): string => {
    const path = join(root, `${TRANSIENT_CONFIG_PREFIX}${String(process.pid)}-${randomBytes(3).toString("hex")}.json`);
    const ignorePatterns = [...(config.ignorePatterns ?? []), TRANSIENT_CONFIG_PATTERN];

    writeFileSync(path, `${JSON.stringify({ ...config, ignorePatterns }, null, 2)}\n`);

    return path;
};

const removeQuietly = (path: string): void => {
    try {
        unlinkSync(path);
    } catch {
        // Already gone, or not removable: the pattern in its own `ignorePatterns` keeps a leftover harmless.
    }
};

/** The name `writeTransientConfig` gives its files: prefix, pid, random id. */
const TRANSIENT_CONFIG_NAME = /^\.vis-fmt-(\d+)-[0-9a-f]{6}\.json$/;

const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

/**
 * Removes transient configs that a killed run left in the workspace root. A file is stale when the
 * process that wrote it is gone; one owned by a live process (a concurrent run) is left alone.
 * Without this, a leftover would be formatted and reported like any other JSON file whenever the
 * current run has no transient config of its own whose `ignorePatterns` hides it.
 * @param root Workspace root.
 */
const removeStaleTransientConfigs = (root: string): void => {
    let names: string[];

    try {
        names = readdirSync(root);
    } catch {
        return;
    }

    for (const name of names) {
        const pid = TRANSIENT_CONFIG_NAME.exec(name)?.[1];

        if (pid !== undefined && !isProcessAlive(Number(pid))) {
            removeQuietly(join(root, name));
        }
    }
};

/**
 * Runs the bundled oxfmt. When `config` is given with `ignorePatterns` or `overrides` it is written to a
 * transient file in the workspace root (so those globs keep their meaning), and removed when the run ends:
 * on success, on failure, on a spawn error, and on SIGINT / SIGTERM. Any other config is kept in the vis cache.
 * @param options What to run and with which config.
 * @returns Exit code, output and duration; `exitCode` is `null` when the process could not start.
 */
export const runOxfmt = async (options: RunOxfmtOptions): Promise<RunResult> => {
    const { binPath = resolveOxfmtBin(), config, extraArgs, files, mode, reRaiseSignal, root } = options;
    const start = Date.now();
    let transientPath: string | undefined;
    let configPath: string | undefined;

    const cleanup = (): void => {
        if (transientPath !== undefined) {
            removeQuietly(transientPath);
        }
    };

    removeStaleTransientConfigs(root);

    try {
        if (config !== undefined) {
            if (hasGlobs(config)) {
                transientPath = writeTransientConfig(root, config);
                configPath = basename(transientPath);
            } else {
                configPath = writeCachedConfig(root, config);
            }
        }

        // Relative to `root` (the child's cwd): oxfmt matches `ignorePatterns` against a canonical cwd, so an
        // absolute path through a symlinked root (macOS `/var` -> `/private/var`) would stop the config ignoring itself.
        const args = buildOxfmtArgs({ configPath, extraArgs, files, mode });

        return await new Promise<RunResult>((resolve) => {
            const child = spawn(process.execPath, [binPath, ...args], { cwd: root, windowsHide: true });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];

            const onSignal = (signal: NodeJS.Signals): void => {
                child.kill(signal);
                cleanup();
                detach();

                if (process.listenerCount(signal) === 0) {
                    (reRaiseSignal ?? ((raised) => process.kill(process.pid, raised)))(signal);
                }
            };

            const listeners = SIGNALS.map(
                (signal) =>
                    [
                        signal,
                        () => {
                            onSignal(signal);
                        },
                    ] as const,
            );

            // `exit` covers `process.exit()` and uncaught errors, where the `finally` below never runs.
            process.on("exit", cleanup);

            for (const [signal, listener] of listeners) {
                process.on(signal, listener);
            }

            const detach = (): void => {
                process.off("exit", cleanup);

                for (const [signal, listener] of listeners) {
                    process.off(signal, listener);
                }
            };

            child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
            child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

            child.on("error", (error) => {
                detach();
                resolve({ durationMs: Date.now() - start, exitCode: null, stderr: error.message, stdout: "" });
            });

            child.on("close", (code) => {
                detach();
                resolve({
                    durationMs: Date.now() - start,
                    exitCode: code,
                    stderr: Buffer.concat(stderr).toString("utf8"),
                    stdout: Buffer.concat(stdout).toString("utf8"),
                });
            });
        });
    } finally {
        cleanup();
    }
};
