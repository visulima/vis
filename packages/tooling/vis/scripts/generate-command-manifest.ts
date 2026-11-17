#!/usr/bin/env node
/**
 * Regenerate `native/cli/src/manifest.json`: the machine-readable list of every
 * `vis` command (name, group, aliases, description, options, positionals,
 * examples) that the native CLI renders help, completions and unknown-command
 * hints from.
 *
 * Usage:
 *   pnpm --filter @visulima/vis run generate:command-manifest
 *
 * The manifest is recorded from the real command definitions: `register-commands.ts`
 * is registered on a real cerebro instance and the resulting command map is
 * serialised. No command handler is loaded or run (handlers sit behind lazy
 * `import()`s, which this script leaves unresolved), and no workspace package has
 * to be built: every bare import other than cerebro is replaced by an inert stub,
 * because command *definitions* only use cerebro's `defineCommand` / `lazyNamed`.
 *
 * Do not hand-edit the output. `__tests__/native/command-manifest.test.ts` fails when it drifts
 * (CI runs it through the package's tests); `check:command-manifest-drift` is the local equivalent.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_FILE = resolve(PACKAGE_ROOT, "native/cli/src/manifest.json");
const CLI_MAIN = resolve(PACKAGE_ROOT, "src/cli-main.ts");
const CLI_EXEC = resolve(PACKAGE_ROOT, "src/cli-exec.ts");
const BIN = resolve(PACKAGE_ROOT, "src/bin.ts");
const SCRATCH_ROOT = resolve(PACKAGE_ROOT, "node_modules/.cache/vis-command-manifest");

/**
 * The global options `cli-main.ts` adds on top of cerebro's built-ins. They are
 * declared inline there (not importable), so they are mirrored here and
 * `assertMirrorsSources` fails the run when the two drift.
 */
const EXTRA_GLOBAL_OPTIONS = [
    { description: "Override workspace root directory", name: "cwd", type: String },
    {
        description: "Target JS runtime: node (default) or bun. Overrides VIS_RUNTIME and config; falls back to lockfile detection.",
        name: "runtime",
        type: String,
    },
    { description: "Path to a vis config file (overrides discovery)", name: "config", type: String },
    {
        description: "Path to a CA bundle (PEM) to trust for HTTPS — for corporate proxies. Equivalent to NODE_EXTRA_CA_CERTS.",
        name: "ca-cert",
        type: String,
    },
];

/**
 * `dlx` and `exec` run through a lean entry (`cli-exec.ts`, dispatched from
 * `bin.ts`) whose cerebro instance has only cerebro's built-in global options
 * plus a shorter `--runtime`. Their `--help` therefore lists those instead of
 * the full set. Mirrored here, and checked against the sources below.
 */
const LEAN_COMMANDS = ["dlx", "exec"];
const LEAN_GLOBAL_OPTIONS = [
    { description: "Target JS runtime: node (default) or bun. Overrides VIS_RUNTIME; falls back to lockfile detection.", name: "runtime", type: String },
];

const assertMirrorsSources = (): void => {
    const declared = [...readFileSync(CLI_MAIN, "utf8").matchAll(/cli\.addGlobalOption\(\{[\s\S]*?name: "([^"]+)"/g)].map((match) => match[1]);
    const mirrored = EXTRA_GLOBAL_OPTIONS.map((option) => option.name);

    if (declared.join(",") !== mirrored.join(",")) {
        throw new Error(
            `generate-command-manifest: global options in src/cli-main.ts (${declared.join(", ")}) differ from EXTRA_GLOBAL_OPTIONS (${mirrored.join(", ")}). Update the script.`,
        );
    }

    const leanSource = readFileSync(CLI_EXEC, "utf8");
    const leanDeclared = [...leanSource.matchAll(/cli\.addGlobalOption\(\{[\s\S]*?name: "([^"]+)"/g)].map((match) => match[1]);

    if (leanDeclared.join(",") !== LEAN_GLOBAL_OPTIONS.map((option) => option.name).join(",") || !leanSource.includes(LEAN_GLOBAL_OPTIONS[0].description)) {
        throw new Error("generate-command-manifest: src/cli-exec.ts global options differ from LEAN_GLOBAL_OPTIONS. Update the script.");
    }

    if (!readFileSync(BIN, "utf8").includes('firstArgument === "exec" || firstArgument === "dlx"')) {
        throw new Error("generate-command-manifest: src/bin.ts no longer routes exec/dlx to the lean entry. Update LEAN_COMMANDS.");
    }
};

/**
 * A callable proxy that answers every property read, call and construction with
 * another such proxy. Its prototype is a proxy too, so esbuild's CJS-interop
 * wrapper (which copies own keys, then reads through the prototype) can resolve
 * any named import.
 */
const STUB_MODULE = `
const make = () =>
    new Proxy(function () {}, {
        apply: () => make(),
        construct: () => make(),
        get: (_target, key) => (key === "__esModule" ? false : key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : make()),
        getPrototypeOf: () => make(),
    });
module.exports = make();
`;

/** Bundle `register-commands.ts` with lazy handlers left unresolved and non-cerebro packages stubbed. */
const bundleRegisterCommands = async (outfile: string): Promise<void> => {
    await build({
        bundle: true,
        entryPoints: [resolve(PACKAGE_ROOT, "src/register-commands.ts")],
        format: "esm",
        jsx: "automatic",
        logLevel: "error",
        outfile,
        platform: "node",
        plugins: [
            {
                name: "record-definitions-only",
                setup(builder) {
                    builder.onResolve({ filter: /^[^./]/ }, (arguments_) => {
                        if (arguments_.kind === "dynamic-import" || arguments_.path.startsWith("node:") || arguments_.path.startsWith("@visulima/cerebro")) {
                            return { external: true, path: arguments_.path };
                        }

                        return { namespace: "stub", path: arguments_.path };
                    });
                    builder.onLoad({ filter: /.*/, namespace: "stub" }, () => {
                        return { contents: STUB_MODULE, loader: "js" };
                    });
                    // Relative lazy imports (`() => import("./handler")`) are never run here.
                    builder.onResolve({ filter: /^\./ }, (arguments_) => {
                        if (arguments_.kind === "dynamic-import") {
                            return { external: true, path: arguments_.path };
                        }

                        return undefined;
                    });
                },
            },
        ],
    });
};

interface RawOption {
    alias?: string;
    conflicts?: string | string[];
    defaultValue?: unknown;
    description?: string;
    hidden?: boolean;
    lazyMultiple?: boolean;
    multiple?: boolean;
    name: string;
    required?: boolean;
    type?: { name?: string };
    typeLabel?: string;
}

interface RawArgument {
    choices?: readonly string[];
    description?: string;
    hidden?: boolean;
    multiple?: boolean;
    name: string;
    required?: boolean;
    type?: { name?: string };
    typeLabel?: string;
}

interface RawCommand {
    alias?: string | string[];
    argument?: RawArgument;
    arguments?: readonly RawArgument[];
    commandPath?: string[];
    description?: string;
    env?: { description?: string; hidden?: boolean; name: string }[];
    examples?: string[] | string[][];
    group?: string;
    hidden?: boolean;
    name: string;
    options?: RawOption[];
}

/** Drop `undefined`/`false`/empty values so the manifest stays small and stable. */
const compact = <T extends Record<string, unknown>>(value: T): Partial<T> => {
    const result: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined || entry === false || entry === null || (Array.isArray(entry) && entry.length === 0)) {
            continue;
        }

        result[key] = entry;
    }

    return result as Partial<T>;
};

const toList = (value: string | string[] | undefined): string[] | undefined => (value === undefined ? undefined : Array.isArray(value) ? value : [value]);

/** cerebro derives `{underline <type>[]}` for every option; keep only labels that differ from that. */
const explicitTypeLabel = (label: string | undefined, type: string, multiple: boolean): string | undefined =>
    label === `{underline ${type}${multiple ? "[]" : ""}}` ? undefined : label;

const serializeOption = (option: RawOption) => {
    const multiple = option.multiple === true || option.lazyMultiple === true;
    const type = (option.type?.name ?? "string").toLowerCase();

    return compact({
        alias: option.alias,
        conflicts: toList(option.conflicts),
        // JSON-safe defaults only; functions and other objects carry no help text.
        defaultValue:
            ["boolean", "number", "string"].includes(typeof option.defaultValue) || Array.isArray(option.defaultValue) ? option.defaultValue : undefined,
        description: option.description ?? "",
        hidden: option.hidden,
        multiple,
        name: option.name,
        required: option.required,
        type,
        typeLabel: explicitTypeLabel(option.typeLabel, type, multiple),
    });
};

const serializeArgument = (argument: RawArgument) => {
    const type = (argument.type?.name ?? "string").toLowerCase();

    return compact({
        choices: argument.choices === undefined ? undefined : [...argument.choices],
        description: argument.description ?? "",
        hidden: argument.hidden,
        multiple: argument.multiple,
        name: argument.name,
        required: argument.required,
        type,
        typeLabel: explicitTypeLabel(argument.typeLabel, type, argument.multiple === true),
    });
};

const serializeCommand = (command: RawCommand, keys: string[]) => {
    const serialized: Record<string, unknown> = compact({
        alias: toList(command.alias),
        argument: command.argument === undefined ? undefined : serializeArgument(command.argument),
        arguments: command.arguments?.map((argument) => serializeArgument(argument)),
        commandPath: command.commandPath,
        description: command.description ?? "",
        env: command.env?.map((entry) => compact({ description: entry.description ?? "", hidden: entry.hidden, name: entry.name })),
        examples: command.examples,
        group: command.group,
        hidden: command.hidden,
        // Every key cerebro files this command under (its leaf name, aliases, or
        // its full path when a leaf-name clash re-keyed it), so native lookups can
        // reproduce `commands.get(key)` exactly.
        keys,
        lean: LEAN_COMMANDS.includes(command.name) && (command.commandPath ?? []).length === 0,
        name: command.name,
        options: command.options?.map((option) => serializeOption(option)),
    });

    // cerebro prints ` [options]` in the usage line whenever `options` is defined, even
    // as an empty array, so `options` keeps its empty array (unlike every other field).
    if (command.options?.length === 0) {
        serialized.options = [];
    }

    return Object.fromEntries(Object.entries(serialized).toSorted(([left], [right]) => left.localeCompare(right)));
};

export const buildManifest = async (): Promise<string> => {
    assertMirrorsSources();
    mkdirSync(SCRATCH_ROOT, { recursive: true });

    const scratch = mkdtempSync(resolve(SCRATCH_ROOT, "run-"));

    try {
        const bundle = resolve(scratch, "register-commands.mjs");

        await bundleRegisterCommands(bundle);

        const { default: registerCommands } = await import(pathToFileURL(bundle).href);
        const { createCerebro } = await import("@visulima/cerebro");
        const { default: HelpCommand } = await import("@visulima/cerebro/command/help");
        const cli = createCerebro("vis", { packageName: "vis", packageVersion: "0.0.0" });

        for (const option of EXTRA_GLOBAL_OPTIONS) {
            cli.addGlobalOption(option);
        }

        registerCommands(cli);

        // `Cli.run` appends the help command last; do the same so its position
        // and options match what `vis --help` shows.
        const registry = cli.getCommands() as Map<string, RawCommand & { options?: RawOption[] }>;

        cli.addCommand(new HelpCommand(registry));

        const keysByCommand = new Map<RawCommand, string[]>();

        for (const [key, command] of registry) {
            keysByCommand.set(command, [...(keysByCommand.get(command) ?? []), key]);
        }

        const help = registry.get("help");

        const leanCli = createCerebro("vis", { packageName: "vis", packageVersion: "0.0.0" });

        for (const option of LEAN_GLOBAL_OPTIONS) {
            leanCli.addGlobalOption(option);
        }

        const manifest = {
            commands: [...keysByCommand].map(([command, keys]) => serializeCommand(command, keys)),
            globalOptions: (cli.getGlobalOptions() as RawOption[]).map((option) => serializeOption(option)),
            helpOptions: (help?.options ?? []).map((option) => serializeOption(option)),
            leanGlobalOptions: (leanCli.getGlobalOptions() as RawOption[]).map((option) => serializeOption(option)),
            name: "vis",
        };

        return `${JSON.stringify(manifest, undefined, 2)}\n`;
    } finally {
        rmSync(scratch, { force: true, recursive: true });
    }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const output = await buildManifest();

    writeFileSync(OUTPUT_FILE, output);
    // eslint-disable-next-line no-console
    console.log(`Wrote ${OUTPUT_FILE}`);
}
