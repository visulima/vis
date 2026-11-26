/**
 * Native bindings for performance-critical operations.
 *
 * The native addon (Rust via napi-rs) provides:
 * - Parallel file hashing using rayon + xxHash xxh3-128
 * - Optimized task hash computation
 * - Fast graph operations (cycle detection, topological sort)
 *
 * The addon is REQUIRED: every supported platform ships a prebuilt binding,
 * so {@link loadNativeBindings} hard-fails with an actionable error when it
 * cannot be loaded rather than degrading. (The concurrent runner's pure-JS
 * path is unrelated — it is capability code for stdin/PTY/streaming the addon
 * can't do, used when the addon IS present.)
 *
 * Build with: pnpm build:native
 * The napi v3 CLI outputs the .node file to the package root.
 */

import loadNativeRootBinding from "./load-native-root-binding";

interface NativeFileHash {
    hash: string;
    path: string;
}

interface NativeTaskHashDetails {
    command: string;
    // NAPI camelCases Rust snake_case struct fields, so the runtime key is `implicitDeps`
    // (see generated index.d.ts). Passing `implicit_deps` would silently drop the value
    // and break lockfile/dependency cache invalidation.
    implicitDeps?: string[][];
    nodes: string[][];
    runtime?: string[][];
}

interface NativeTaskGraph {
    edges: string[][];
    task_ids: string[];
}

interface NativeCycleResult {
    cycle: string[];
    has_cycle: boolean;
}

interface NativeConcurrentCommandConfig {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    inheritEnv?: boolean;
    name?: string;
    ptySize?: { cols: number; rows: number };
    shell?: boolean;
    stdin?: string;
}

interface NativeConcurrentRunnerOptions {
    killOthers?: string[];
    killSignal?: string;
    killTimeout?: number;
    maxProcesses?: number;
    shellPath?: string;
    streamOutput?: boolean;
    successCondition?: string;
}

interface NativeProcessEvent {
    commandName?: string;

    /**
     * stdout/stderr only: above 1, `text` holds that many lines joined with `\n` (the host splits
     * it); absent means one line. A pty chunk is never folded.
     */
    count?: number;
    durationMs?: number;
    exitCode?: number;
    index: number;
    killed?: boolean;
    kind: string;
    message?: string;
    pid?: number;
    text?: string;
}

/**
 * What `startConcurrent` hands its callback: events in the order they happened and, as the very
 * last batch, how the run ended. Every event is delivered before the batch with `result` or `error`.
 */
interface NativeProcessEventBatch {
    error?: string;
    events: NativeProcessEvent[];
    result?: NativeConcurrentRunResult;
}

interface NativeConcurrentCloseEvent {
    command: string;
    durationMs: number;
    exitCode: number;
    index: number;
    killed: boolean;
    name?: string;
}

interface NativeConcurrentRunResult {
    closeEvents: NativeConcurrentCloseEvent[];
    success: boolean;
}

/**
 * A concurrent run that is in progress, as returned by `startConcurrent`. The addon installs
 * no signal handlers; the host forwards whatever it treats as "stop" to `abort`.
 */
interface NativeConcurrentRun {
    /**
     * Kill every running command and start no queued one. `"interrupt"` (Ctrl+C) closes every
     * command with exit code 0 and `killed: true` in the result (the `close` events keep the real
     * exit codes); `"terminate"` (the default) keeps the exit codes in the result too. Repeated
     * calls, and calls after the run finished, do nothing.
     */
    abort: (mode?: "interrupt" | "terminate") => void;
    /** Resolves once every command has finished; may be awaited more than once. */
    done: () => Promise<NativeConcurrentRunResult>;
    /** Signal one command's process tree. False when the run has already finished. */
    kill: (index: number, signal?: string | null) => boolean;
    /** Resize a running pty command's terminal. False when the run has already finished. */
    resize: (index: number, cols: number, rows: number) => boolean;
    /** Write to a running command's stdin (a pipe or a pty). False when the run has already finished. */
    write: (index: number, data: string) => boolean;
}

interface NativeBindings {
    collectFiles: (directory: string) => string[];
    computeTaskHash: (details: NativeTaskHashDetails) => string;
    findAllCycles: (graph: NativeTaskGraph) => string[][];
    findBackEdges: (graph: NativeTaskGraph) => string[][];
    // Graph operations
    findCycle: (graph: NativeTaskGraph) => NativeCycleResult;
    getDependentTasks: (graph: NativeTaskGraph, taskId: string) => string[];

    // Worktree detection (returns the main worktree root for a linked git
    // worktree, or undefined for primary checkouts / non-git directories).
    getMainWorktreeRoot: (workspaceRoot: string) => string | undefined | null;
    getTransitiveDeps: (graph: NativeTaskGraph, taskId: string) => string[];
    // Task hashing
    hashCommand: (project: string, target: string, configuration: string | undefined, overridesJson: string) => string;
    hashEnvVar: (name: string, value: string) => string;
    // File hashing
    hashFile: (filePath: string) => string;

    hashFilesBatch: (filePaths: string[], workspaceRoot: string) => NativeFileHash[];
    hashFilesInDirectory: (directory: string, workspaceRoot: string) => NativeFileHash[];
    hashGlobalInputs: (workspaceRoot: string, names: string[], extra: string[]) => string | null | undefined;
    hashString: (input: string) => string;
    hashStrings: (inputs: string[]) => string;
    hashTaskCommand: (
        project: string,
        target: string,
        configuration: string | undefined,
        commandJson: string,
        outputs: string,
        overridesJson: string,
    ) => string;
    isLinkedWorktree: (workspaceRoot: string) => boolean;

    resetWorktreeCache: () => void;
    // Concurrent process runner
    runConcurrent: (
        commands: NativeConcurrentCommandConfig[],
        options: NativeConcurrentRunnerOptions,
        onEvent: (event: NativeProcessEvent) => void,
    ) => Promise<NativeConcurrentRunResult>;
    runConcurrentBatch: (
        commands: NativeConcurrentCommandConfig[],
        options: NativeConcurrentRunnerOptions,
        onLifecycle?: ((event: NativeProcessEvent) => void) | null,
    ) => Promise<NativeConcurrentRunResult>;
    startConcurrent: (
        commands: NativeConcurrentCommandConfig[],
        options: NativeConcurrentRunnerOptions,
        onBatch?: ((batch: NativeProcessEventBatch) => void) | null,
    ) => NativeConcurrentRun;
    topologicalSort: (graph: NativeTaskGraph) => string[];

    /**
     * Windows-only: spawn the directly-exec'd `argv` suspended, inject
     * the `fspy_windows` DLL (at `dllPath`) via
     * `CreateRemoteThread(LoadLibraryW)`, and collect the IAT-hooked
     * accesses streamed over a named pipe. Same result shape as
     * `trackWithSeccomp`. Present only when the addon was built for a
     * Windows target.
     */
    trackWithIatHook?: (
        argv: string[],
        dllPath: string,
        options?: NativeSeccompSpawnOptions,
        onStarted?: (pid: number) => void,
    ) => Promise<NativeSeccompTrackingResult>;

    /**
     * macOS-only: spawn the directly-exec'd `argv` with the
     * `fspy_macos` interpose dylib (at `dylibPath`) injected via
     * `DYLD_INSERT_LIBRARIES` and collect reported accesses. Same
     * result shape as `trackWithSeccomp`. Present only when the
     * addon was built for a macOS target.
     */
    trackWithInterpose?: (
        argv: string[],
        dylibPath: string,
        options?: NativeSeccompSpawnOptions,
        onStarted?: (pid: number) => void,
    ) => Promise<NativeSeccompTrackingResult>;

    /**
     * Linux-only: spawn `argv` under seccomp_unotify tracking via
     * the helper binary at `helperPath`. Resolves once the child
     * exits with the gathered file accesses.
     *
     * `onStarted` (when supplied) fires once with the helper PID
     * as soon as the spawn succeeds. The PID survives the
     * helper→target execve, so callers can SIGTERM it via
     * `process.kill(pid)` to abort the traced command.
     *
     * Undefined when the addon was built on a non-Linux target.
     */
    trackWithSeccomp?: (
        argv: string[],
        helperPath: string,
        options?: NativeSeccompSpawnOptions,
        onStarted?: (pid: number) => void,
    ) => Promise<NativeSeccompTrackingResult>;
}

interface NativeSeccompSpawnOptions {
    cwd?: string;
    /** Extra env vars merged on top of the parent's. */
    env?: Record<string, string>;
}

interface NativeSeccompFileAccess {
    kind: "missing" | "read" | "readdir" | "stat" | "write";
    path: string;
}

interface NativeSeccompTrackingResult {
    accesses: NativeSeccompFileAccess[];
    exitCode: number;

    /**
     * Some accesses could not be recorded (an argument of a tracked syscall was unreadable, or a
     * process ran under an ABI the tracker does not decode), so `accesses` is a lower bound.
     * Absent on an addon built before the field existed.
     */
    incomplete?: boolean;
    stderr: Buffer;
    stdout: Buffer;
}

let nativeBindings: NativeBindings | undefined;
let loadAttempted = false;
let loadError: Error | undefined;

/**
 * Builds the hard-failure error for a missing/unusable native addon. The
 * addon is required: every supported platform ships a prebuilt binding, so a
 * load failure means a broken `optionalDependencies` install or a stale/
 * mismatched binary, not an unsupported environment. Failing loudly here (and
 * consistently with the other native packages) surfaces the gap instead of
 * masking it behind a slower, separately-maintained pure-JS path.
 */
const buildLoadError = (cause: unknown): Error => {
    const detail = cause instanceof Error ? cause.message : "native addon not found";

    return new Error(
        `@visulima/task-runner: native addon could not be loaded (${detail}). This package requires its platform binding. `
        + "Install the matching @visulima/task-runner-binding-* package, or build it with `pnpm build:native`.",
        { cause },
    );
};

/**
 * Loads the native addon, caching the result after the first attempt.
 *
 * napi v3 outputs the .node file to the package root as
 * `task-runner-native.&lt;platform>.node`. The napi-generated index.js handles
 * platform detection automatically; {@link loadNativeRootBinding} resolves and
 * requires it from the package root regardless of how packem nests this module
 * under dist/.
 *
 * Throws a clear, actionable error when the addon cannot be loaded (missing
 * binding or stale binary) rather than degrading silently. The
 * `| undefined` return is retained so the many `if (native)` / `native?.x`
 * call sites stay valid; in practice this never returns undefined — it either
 * returns the bindings or throws.
 */
const loadNativeBindings = (): NativeBindings | undefined => {
    if (loadAttempted) {
        if (loadError) {
            throw loadError;
        }

        return nativeBindings;
    }

    loadAttempted = true;

    try {
        const loaded = loadNativeRootBinding(import.meta.url) as NativeBindings;

        // Validate that the loaded binding has the expected API surface.
        // A stale .node binary may load successfully but be missing functions.
        if (
            typeof loaded.hashCommand === "function"
            && typeof loaded.hashTaskCommand === "function"
            && typeof loaded.hashGlobalInputs === "function"
            && typeof loaded.hashFile === "function"
            && typeof loaded.runConcurrent === "function"
        ) {
            nativeBindings = loaded;
        } else {
            loadError = buildLoadError(new Error("native addon loaded but is missing expected exports (stale or version-mismatched binary)"));
        }
    } catch (error) {
        loadError = buildLoadError(error);
    }

    if (loadError) {
        throw loadError;
    }

    return nativeBindings;
};

/**
 * Returns true if the native addon loads, false otherwise. Unlike
 * {@link loadNativeBindings} this never throws — it is a safe probe for
 * callers that want to branch on availability rather than hard-fail.
 */
const isNativeAvailable = (): boolean => {
    try {
        return loadNativeBindings() !== undefined;
    } catch {
        return false;
    }
};

export type {
    NativeBindings,
    NativeConcurrentCloseEvent,
    NativeConcurrentCommandConfig,
    NativeConcurrentRun,
    NativeConcurrentRunnerOptions,
    NativeConcurrentRunResult,
    NativeCycleResult,
    NativeFileHash,
    NativeProcessEvent,
    NativeProcessEventBatch,
    NativeSeccompFileAccess,
    NativeSeccompSpawnOptions,
    NativeSeccompTrackingResult,
    NativeTaskGraph,
    NativeTaskHashDetails,
};
export { isNativeAvailable, loadNativeBindings };
