import { createShellRunner } from "../shell-runner";

/**
 * Run a configured shell hook command (preVersionCommand / postVersionCommand /
 * prePublishCommand / postPublishCommand). Empty string skips silently.
 * Throws if the command exits non-zero.
 *
 * Cross-platform: uses `cmd /c &lt;cmd>` on Windows, `sh -c &lt;cmd>` elsewhere.
 */
export const runHook = async (cwd: string, command: string, label: string): Promise<void> => {
    if (!command || command.trim() === "") {
        return;
    }

    const runner = createShellRunner();
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd" : "sh";
    const shellArgs = isWindows ? ["/c", command] : ["-c", command];

    const result = await runner.run(shell, shellArgs, { cwd, silent: false });

    if (result.exitCode !== 0) {
        throw new Error(`${label} failed (exit ${result.exitCode}): ${command}`);
    }
};
