import { createShellRunner } from "../shell-runner";
import type { OrchestratorContext } from "./context";

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

/**
 * Run the group-scoped preVersion commands (`groupPreVersionCommands["group-&lt;index>"]`)
 * for every `fixed`/`linked` group with at least one package in this wave.
 */
export const runGroupPreVersionCommands = async (context: OrchestratorContext, commands: Record<string, string>): Promise<void> => {
    const { normaliseGroup } = await import("../../types");
    const allGroups = [...(context.config.fixed ?? []), ...(context.config.linked ?? [])].map((g) => normaliseGroup(g));
    const { default: zeptomatch } = await import("zeptomatch");

    for (const [groupKey, command] of Object.entries(commands)) {
        const groupIndex = Number.parseInt(groupKey.replace(/^group-/, ""), 10);
        const group = allGroups[groupIndex];

        if (!group) {
            continue;
        }

        // Only run if the group has at least one package being released this wave.
        // Group entries can be literal names OR glob patterns — match both.
        const groupTouched = context.plan.releases.some((r) =>
            group.packages.some((memberPattern) => r.name === memberPattern || zeptomatch(memberPattern, r.name)),
        );

        if (!groupTouched) {
            continue;
        }

        await runHook(context.cwd, command, `groupPreVersionCommand[${groupKey}]`);
    }
};
