import type { Plugin } from "@visulima/cerebro";
import { isAccessibleSync } from "@visulima/fs";
import { join } from "@visulima/path";

import { showMcpPromote } from "../util/mcp-promote";
import { showSponsorNotice } from "../util/sponsor";
import { showTip } from "../util/tips";

/**
 * After-command hooks (upgrade notice, tip, sponsor and MCP notices).
 *
 * `effectiveArgs` are the arguments of the command that actually ran, when they differ from
 * `process.argv`: a command group runs as `vis help` plus the group, so it gets the `help` opt-outs.
 */
const postCommandPlugin = (upgradeCheckCallback?: () => void, effectiveArgs?: string[]): Plugin => {
    return {
        afterCommand: async (toolbox) => {
            const args = effectiveArgs ?? process.argv.slice(2);
            const command = args[0] ?? "";
            const success = process.exitCode === undefined || process.exitCode === 0;

            if (upgradeCheckCallback) {
                upgradeCheckCallback();
            }

            const root = (toolbox as { workspaceRoot?: string }).workspaceRoot ?? process.cwd();

            showTip({
                args,
                command,
                hasDockerfile: isAccessibleSync(join(root, "Dockerfile")),
                hasDockerignore: isAccessibleSync(join(root, ".dockerignore")),
                hasVercelConfig: isAccessibleSync(join(root, "vercel.json")) || isAccessibleSync(join(root, ".vercel")),
                hasVisConfig: toolbox.visConfig !== undefined && Object.keys(toolbox.visConfig).length > 0,
                success,
            });

            showSponsorNotice({ success, visConfig: toolbox.visConfig });
            showMcpPromote({ command, success, visConfig: toolbox.visConfig });
        },
        name: "post-command",
    };
};

export default postCommandPlugin;
