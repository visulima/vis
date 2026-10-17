import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import { join } from "@visulima/path";

import { VisUserError } from "../../errors/vis-user-error";
import { typecheckAdapter } from "../../lint-fmt/adapters/typecheck";
import { detectAdapters } from "../../lint-fmt/detect";
import type { FmtOptions } from "../fmt";
import fmtExecute from "../fmt/handler";
import type { LintOptions } from "../lint";
import lintExecute from "../lint/handler";
import type { CheckOptions } from "./index";

/**
 * Runs `vis lint` then `vis fmt --check` over the same scope. The type check is
 * opt-in in lint; it is turned on here only when TypeScript is detected, and an
 * explicit `lint.adapters.typecheck.enabled` in config always wins. Both handlers
 * only set `process.exitCode` when they fail, so a failure from either one survives.
 */
const execute = async ({ argument, fs, options, visConfig, workspaceRoot, ...toolbox }: Toolbox<Console, CheckOptions>): Promise<void> => {
    const root = workspaceRoot ?? process.cwd();
    const files = argument ?? [];

    // Dependency checks used to live on this name. Without this, `vis check react`
    // would hand "react" to lint and fmt as a path they silently skip.
    for (const file of files) {
        try {
            await fs.access(join(root, file));
        } catch {
            throw new VisUserError(`"${file}" is not a file or directory. Dependency checks moved to \`vis outdated\`.`);
        }
    }

    const lintConfig = visConfig?.lint;
    const typecheckDetected = detectAdapters(root, [typecheckAdapter]).has(typecheckAdapter.id);
    const scope = { _: files, since: options.since, staged: options.staged };

    const lintOptions: LintOptions = {
        ...scope,
        fix: options.fix,
        format: "human",
        maxWarnings: undefined,
        output: undefined,
        quiet: false,
        watch: false,
    };

    await lintExecute({
        ...toolbox,
        fs,
        options: lintOptions,
        visConfig: {
            ...visConfig,
            lint: {
                ...lintConfig,
                adapters: {
                    ...lintConfig?.adapters,
                    typecheck: { ...lintConfig?.adapters?.typecheck, enabled: lintConfig?.adapters?.typecheck?.enabled ?? typecheckDetected },
                },
            },
        },
        workspaceRoot,
    } as unknown as Toolbox<Console, LintOptions>);

    const fmtOptions: FmtOptions = {
        ...scope,
        check: !options.fix,
        format: "human",
        output: undefined,
        quiet: false,
        watch: false,
    };

    await fmtExecute({ ...toolbox, fs, options: fmtOptions, visConfig, workspaceRoot } as unknown as Toolbox<Console, FmtOptions>);
};

// fallow-ignore-next-line unused-export -- lazy-loaded command entry (cerebro loader/lazyNamed dynamic import)
export default execute as CommandExecute<Toolbox>;
