import { splitCommandString } from "../util/command-string";

/*
 * A root project's scripts become its targets. Some of them only re-run their
 * own name somewhere else, and as targets they run that work twice or forever:
 *
 * - `"build": "vis run build"` selects the root project again and recurses. It
 *   is dropped wherever `vis run <name>` appears, compound command or not.
 * - `"e2e": "pnpm --filter @org/e2e e2e"` runs the e2e project's script a
 *   second time, next to that project's own target. It is dropped only when it
 *   is the whole command, adds no arguments, and another project has a
 *   `package.json` script of that name: pnpm also runs built-ins
 *   (`pnpm -r outdated`) and, when no script matches, package binaries
 *   (`pnpm --filter a eslint`) this way. A target alone (inferred, or from a
 *   task default) is not enough, since pnpm never runs it, and dropping such
 *   a root script loses the only target that runs it.
 */

const VIS_RUN_RE = /(?:^|[\s;&|(])(?:vis|v)\s+run\s+([^;&|)]*)/g;
const SHELL_SYNTAX_RE = /[\n\r;&|`<>]|\$\(/;

/** pnpm flags that point a command at other workspace projects; each takes a value. */
const PNPM_PROJECT_FLAGS = new Set(["--dir", "--filter", "-C", "-F"]);
/** pnpm flags that take no value and may sit between the selector and the script. */
const PNPM_SWITCHES = new Set(["--if-present", "--parallel", "--reporter-hide-prefix", "--sequential", "--silent", "--stream", "-s"]);

const runsItselfThroughVis = (name: string, command: string): boolean => {
    for (const match of command.matchAll(VIS_RUN_RE)) {
        const tokens = match[1]!.split(/\s+/);

        if (tokens.find((token) => token.length > 0 && !token.startsWith("-")) === name) {
            return true;
        }
    }

    return false;
};

/**
 * The script a plain `pnpm --filter|-F|--dir|-C|-r … [run] &lt;script>` hands to
 * other projects, or `undefined` for any other command, including one that
 * passes arguments on.
 */
const pnpmForwardedScript = (command: string): string | undefined => {
    if (SHELL_SYNTAX_RE.test(command)) {
        return undefined;
    }

    let tokens: string[];

    try {
        tokens = splitCommandString(command);
    } catch {
        return undefined;
    }

    if (tokens[0] !== "pnpm") {
        return undefined;
    }

    let forwards = false;
    let index = 1;

    while (index < tokens.length) {
        const token = tokens[index] as string;
        const flag = token.split("=", 1)[0] as string;

        if (PNPM_PROJECT_FLAGS.has(flag)) {
            forwards = true;
            index += token.includes("=") ? 1 : 2;
        } else if (token === "-r" || token === "--recursive") {
            forwards = true;
            index += 1;
        } else if (PNPM_SWITCHES.has(token)) {
            index += 1;
        } else {
            break;
        }
    }

    if (tokens[index] === "run") {
        index += 1;
    }

    const script = tokens[index];

    return forwards && script !== undefined && !script.startsWith("-") && index === tokens.length - 1 ? script : undefined;
};

/**
 * The root scripts left once those that only forward their own name are
 * removed. `scriptsElsewhere` holds the `package.json` script names of every
 * other project.
 */
const withoutForwardingScripts = (scripts: Record<string, string> | undefined, scriptsElsewhere: ReadonlySet<string>): Record<string, string> | undefined => {
    if (scripts === undefined) {
        return undefined;
    }

    return Object.fromEntries(
        Object.entries(scripts).filter(
            ([name, command]) => !runsItselfThroughVis(name, command) && !(pnpmForwardedScript(command) === name && scriptsElsewhere.has(name)),
        ),
    );
};

export { pnpmForwardedScript, withoutForwardingScripts };
