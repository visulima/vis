import type { Task } from "@visulima/task-runner";

import type { detectCurrentOs, VisTargetOptions } from "../../task/target-options";
import { resolveTargetShell } from "../../task/target-options";
import { getTaskOptions } from "./task-env";

/**
 * Wraps a string in single quotes for safe POSIX shell execution.
 * Used when we know the consumer is a POSIX shell — e.g. when forwarding
 * a value as the argument of `&lt;shell> -c &lt;value>` regardless of OS.
 */
const singleQuoteEscape = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

/**
 * Wraps a string for safe shell execution by the platform's default
 * shell. POSIX uses single quotes (prevents `$VAR` / `\n` / backtick
 * expansion). Windows cmd.exe treats single quotes as literal characters
 * — they would survive into the child process's argv — so we use
 * double-quote escaping with inner `"` doubled per cmd.exe parsing rules.
 */
const shellQuote = (value: string): string => {
    if (process.platform === "win32") {
        if (value.length > 0 && !/[\s"&|<>^()%!]/.test(value)) {
            return value;
        }

        return `"${value.replaceAll("\"", "\"\"")}"`;
    }

    return singleQuoteEscape(value);
};

/** Builds the command args list for `affectedFiles` forwarding. */
const buildAffectedFilesArgs = (command: string, affectedFiles: string[] | undefined, mode: VisTargetOptions["affectedFiles"]): string => {
    if (!affectedFiles || affectedFiles.length === 0 || mode === false || mode === undefined) {
        return command;
    }

    if (mode === "args" || mode === "both") {
        const quoted = affectedFiles.map((file) => shellQuote(file)).join(" ");

        return `${command} ${quoted}`;
    }

    return command;
};

/** Override key carrying CLI args that should only reach the target task. */
export const FORWARDED_ARGS_KEY = "visForwardedArgs";

/**
 * Appends forwarded positional args (`vis run test --reporter=verbose`)
 * to the task's command. Only the user-invoked target task carries this
 * override — `dependsOn` dependencies see an empty overrides object
 * because `resolveStringDependency` in task-runner strips them.
 */
const appendForwardedArgs = (command: string, task: Task): string => {
    const args = task.overrides[FORWARDED_ARGS_KEY];

    if (!Array.isArray(args) || args.length === 0) {
        return command;
    }

    const quoted = (args as string[]).map((argument) => shellQuote(argument)).join(" ");

    return `${command} ${quoted}`;
};

/**
 * The shell command a task spawns: its configured command with the forwarded
 * arguments and `affectedFiles: "args"` appended, then wrapped in the target's
 * custom shell. The executor and the traced run both spawn this string, and the
 * traced key hashes it, so the two cannot drift.
 */
export const resolveTaskCommand = (task: Task, affectedFiles: string[] | undefined, currentOs: ReturnType<typeof detectCurrentOs>): string | undefined => {
    // `overrides.command` is already token-expanded at the build site so the
    // cache hasher sees the resolved form.
    const expandedCommand = task.overrides["command"] as string | undefined;

    if (!expandedCommand) {
        return undefined;
    }

    const visOptions = getTaskOptions(task);

    // Forwarded args and `affectedFiles: "args"` belong to the end of the
    // whole `&&` chain, so only the last segment of a split target gets them.
    const isChainHead = task.segment !== undefined && task.segment.index < task.segment.count;
    const commandWithArgs = isChainHead ? expandedCommand : appendForwardedArgs(expandedCommand, task);
    const commandWithAffected = isChainHead ? commandWithArgs : buildAffectedFilesArgs(commandWithArgs, affectedFiles, visOptions?.affectedFiles);

    const customShell = resolveTargetShell(visOptions, currentOs);
    // `shellArgs` lets a target pick a non-`-c` interpreter (e.g.
    // `shell: "node", shellArgs: ["-e"]` runs the command as inline JS).
    // An empty array would drop the flag entirely (turning `node 'cmd'`
    // into a file lookup), so fall back to `-c`.
    const shellArgs = visOptions?.shellArgs;
    const shellInvokeArgs = shellArgs && shellArgs.length > 0 ? shellArgs.join(" ") : "-c";
    // `shellQuote` is platform-aware (POSIX single-quote / cmd.exe
    // double-quote) — `singleQuoteEscape` would leave literal `'…'` around
    // the command under cmd.exe, breaking e.g. `node -e` on Windows.

    return customShell ? `${customShell} ${shellInvokeArgs} ${shellQuote(commandWithAffected)}` : commandWithAffected;
};
