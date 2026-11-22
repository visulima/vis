import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { GROUP_LISTINGS } from "./group-listing.mjs";

// Which `vis` invocations the Node launcher (`bin/vis.mjs`) hands to the native
// binary. Kept free of side effects so the routing table is unit-testable without
// a binary, the same way `resolve-binary.mjs` is shared.

// Commands answered by the native binary. Every entry here MUST be handled by the
// binary (natively or via its own Node delegation), with VERIFIED parity to the
// Node behavior. Unknown commands never reach the binary: they take the in-process
// path unchanged. NOTE: `-v` is cerebro's verbose flag (not version), so it is
// deliberately absent.
//
// `exec` parity was verified empirically against cerebro: tool flags after the
// command are forwarded to the tool on both the native path and the Node handler
// (src/commands/exec/handler.ts), which was fixed to stop dropping them.
const NATIVE_COMMANDS = new Set(["--version", "-V", "__native-info", "__pm-shim", "dedupe", "exec", "link", "outdated", "pm", "remove", "unlink", "why", "x"]);

// `--help` / `-h` anywhere before a `--` separator.
const asksForHelp = (args) => {
    const separatorIndex = args.indexOf("--");
    const optionArguments = separatorIndex === -1 ? args : args.slice(0, separatorIndex);

    return optionArguments.some((argument) => argument === "--help" || argument === "-h");
};

// Environment variables that turn on colour in Node for the stdout log lines. Mirrors
// `COLOUR_ENVIRONMENT` in `native/cli/src/ignore.rs`, plus `CLICOLOR_FORCE`, which the binary
// does not check. The launcher only pre-filters, so a superset here is safe: Node answers.
const IGNORE_COLOUR_ENVIRONMENT = [
    "CLICOLOR_FORCE",
    "FORCE_COLOR",
    "COLORTERM",
    "TERM_PROGRAM",
    "TERMINAL_EMULATOR",
    "TEAMCITY_VERSION",
    "TF_BUILD",
    "PM2_HOME",
    "GITEA_ACTIONS",
    "CIRCLECI",
    "GITHUB_WORKFLOW",
    "GITHUB_ACTIONS",
    "TRAVIS",
    "APPVEYOR",
    "GITLAB_CI",
    "BUILDKITE",
    "DRONE",
    "CI_NAME",
];

// Markers that Node's root search (`findMonorepoRootSync` in `@visulima/package`) reads. Same list
// as `ROOT_MARKERS` in `native/cli/src/advisories.rs`; keep them in step.
const ROOT_MARKERS = [
    "lerna.json",
    "turbo.json",
    "pnpm-workspace.yaml",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
];

const holdsRootMarker = (directory) => ROOT_MARKERS.some((name) => existsSync(join(directory, name)));

// Whether Node's root search would return `cwd` itself: a marker in `cwd` and none above it. Walks
// to the filesystem root, as the Rust `ancestors()` does, so `/` is checked too.
const rootIsCwd = (cwd, holdsMarker = holdsRootMarker) => {
    if (!holdsMarker(cwd)) {
        return false;
    }

    for (let directory = dirname(cwd); ; directory = dirname(directory)) {
        if (holdsMarker(directory)) {
            return false;
        }

        if (dirname(directory) === directory) {
            return true;
        }
    }
};

// `is-in-ci`: `CI` or `CONTINUOUS_INTEGRATION` set to anything but `0` or `false`.
const inCi = (environment) => ["CI", "CONTINUOUS_INTEGRATION"].some((key) => environment[key] !== undefined && environment[key] !== "0" && environment[key] !== "false");

// Whether `TERM` leaves Node free to colour its output: unset, dumb or mono. The binary reads the
// same variable in `colour_may_be_forced` (`ignore.rs`).
const plainTerm = (environment) => {
    const term = environment.TERM?.toLowerCase();

    return term === undefined || term.includes("dumb") || term.includes("mono");
};

// Whether `vis ignore` can pass the binary's native gate (`native_context` in `ignore.rs`). The
// binary re-checks everything; this only skips the extra process when it would delegate anyway.
// It never answers `ignore` on Windows (Node's colour detection and path handling differ there).
const ignoreMayRunNatively = (platform, environment, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive) {
        return false;
    }

    if (!inCi(environment)) {
        return false;
    }

    // The inherited variable is only a reason to delegate, never the root itself.
    const inheritedRoot = environment.VIS_MONOREPO_ROOT;

    if (inheritedRoot && inheritedRoot !== cwd) {
        return false;
    }

    if (!rootIsCwd(cwd, holdsMarker)) {
        return false;
    }

    if (IGNORE_COLOUR_ENVIRONMENT.some((key) => environment[key] !== undefined)) {
        return false;
    }

    return plainTerm(environment);
};

// Whether `vis clean` can pass the binary's native gate (`plan` in `clean.rs`). The binary re-checks
// everything; this only skips the extra process when it would delegate anyway. Flags are the
// default, `--dry-run` and `--lockfile`/`-l`, each at most once. `plan` delegates everywhere but
// unix (its header clock is unix-only), so Windows stays in Node.
const cleanMayRunNatively = (platform, environment, args, interactive) => {
    if (platform === "win32" || interactive) {
        return false;
    }

    if (!inCi(environment) || IGNORE_COLOUR_ENVIRONMENT.some((key) => environment[key] !== undefined) || !plainTerm(environment)) {
        return false;
    }

    const flags = args.slice(1);
    const known = new Set(["--dry-run", "--lockfile", "-l"]);

    return flags.every((flag) => known.has(flag)) && new Set(flags).size === flags.length;
};

// The argument lists (after `list`) that the binary answers natively.
const LIST_NATIVE_SHAPES = [[], ["--json"], ["--format", "json"], ["--format", "table"], ["--format=json"], ["--format=table"]];

// Whether `vis list` can pass the binary's native gate (`run` in `list.rs`). Only the plain listing
// is native: no flags, `--json`, or one `--format` value. The binary re-checks the CI context and
// every other shape, so this only skips the extra process when it would delegate anyway.
const listMayRunNatively = (platform, environment, args, interactive) => {
    if (platform === "win32" || interactive || !inCi(environment)) {
        return false;
    }

    const flags = args.slice(1);

    return LIST_NATIVE_SHAPES.some((shape) => shape.length === flags.length && shape.every((flag, index) => flags[index] === flag));
};

// Whether `vis cache list|size` can pass the binary's native gate (`answer` in `cache.rs`). The binary
// re-checks everything, including the flags, the root and the config; this only skips the extra process
// when it would delegate anyway: not on Windows, not in a terminal, and only in a CI context.
const cacheMayRunNatively = (platform, environment, interactive) => platform !== "win32" && !interactive && inCi(environment);

// Whether `vis cache hash` can pass the binary's native gate (`native` in `cache_hash.rs`). The
// binary re-checks the context and every shape (one task id, `--format json|table`, `--run <id>`),
// so this only skips the extra process for a call that would be delegated anyway: no task id, a
// flag the binary does not know, or a table in a context where Node may colour it (the binary does
// not; the JSON is written raw, so colour does not matter there). It stays in Node on Windows
// (pail's clock is unix-only there).
const CACHE_HASH_FLAG = /^--(?:format|run)(?:=.*)?$/;

const cacheHashAsksForJson = (flags) => flags.includes("--format=json") || flags.some((flag, index) => flag === "--format" && flags[index + 1] === "json");

const cacheHashMayRunNatively = (platform, environment, args, interactive) => {
    const flags = args.slice(2);

    if (platform === "win32" || interactive || !inCi(environment) || flags.length === 0 || !flags.every((token) => !token.startsWith("-") || CACHE_HASH_FLAG.test(token))) {
        return false;
    }

    return cacheHashAsksForJson(flags) || (!IGNORE_COLOUR_ENVIRONMENT.some((key) => environment[key] !== undefined) && plainTerm(environment));
};

// Commands with a native gate answer help through the binary on every platform (it enables
// virtual-terminal processing on a Windows console), and otherwise follow the gate.
// `mayRunNatively` is only called when the help surface is not asked for.
const helpOrNative = (args, mayRunNatively) => {
    if (asksForHelp(args)) {
        return true;
    }

    return mayRunNatively();
};

// The routing of the commands that have their own native shapes: `true` or `false` when the
// command decides, `undefined` when it is left to the help-surface rule in `routesToNative`.
const routesCommandToNative = (args, platform, environment, cwd, interactive, holdsMarker = holdsRootMarker) => {
    const [command = "", subcommand] = args;

    if (NATIVE_COMMANDS.has(command)) {
        return true;
    }

    // `hook run` is native, but the other `hook` subcommands (install, migrate, …)
    // are not: sending those through the binary would only add a second Node boot.
    if (command === "hook" && subcommand === "run") {
        return true;
    }

    // `advisories bloom status` is answered natively for `--format json --cache-dir <dir>`.
    // The binary hands every other shape of it to Node itself, as it does for `hook run`.
    if (command === "advisories" && subcommand === "bloom" && args[2] === "status") {
        return true;
    }

    // `ignore` is native for its plain shapes in a CI context (`native/cli/src/ignore.rs`); any
    // other run would be delegated by the binary, which costs a second Node boot.
    if (command === "ignore") {
        return helpOrNative(args, () => ignoreMayRunNatively(platform, environment, cwd, interactive, holdsMarker));
    }

    // `list` is native for the plain listing in a CI context (`native/cli/src/list.rs`); any other
    // run would be delegated by the binary, which costs a second Node boot.
    if (command === "list") {
        return helpOrNative(args, () => listMayRunNatively(platform, environment, args, interactive));
    }

    // `cache list` and `cache size` are native for their plain shapes in a CI context
    // (`native/cli/src/cache.rs`); the binary hands every other shape to Node itself.
    if (command === "cache" && (subcommand === "list" || subcommand === "size")) {
        return helpOrNative(args, () => cacheMayRunNatively(platform, environment, interactive));
    }

    // `cache hash` is native for one task id with `--format` / `--run` in a CI context
    // (`native/cli/src/cache_hash.rs`); the binary delegates the rest (trace-mode tasks, odd summaries).
    if (command === "cache" && subcommand === "hash") {
        return helpOrNative(args, () => cacheHashMayRunNatively(platform, environment, args, interactive));
    }

    // `clean` (no flags, `--dry-run`, `--lockfile`) is answered natively; the binary hands every
    // other shape to Node itself. A terminal
    // stdout stays in Node: pail colours its output there, and the binary does not.
    if (command === "clean") {
        return helpOrNative(args, () => cleanMayRunNatively(platform, environment, args, interactive));
    }

    // A bare command group lists its subcommands, which the binary answers like `<group> --help` (any
    // other shape is Node's, which prints the same listing). The binary enables virtual-terminal
    // processing, so Windows answers it natively too.
    if (GROUP_LISTINGS.includes(command) && args.length === 1) {
        return true;
    }

    // `complete --` is the dynamic endpoint the generated completion scripts call on
    // every <TAB>; any other `complete` shape is not a native command, so it stays
    // in-process (script generation is `vis completion --shell=<shell>`, Node's too).
    if (command === "complete" && subcommand === "--") {
        return true;
    }

    if (command === "complete") {
        return false;
    }

    return undefined;
};

// Whether the binary should get this invocation: `args` is `process.argv.slice(2)`. The other
// parameters default to the running process; tests pass their own.
const routesToNative = (
    args,
    platform = process.platform,
    environment = process.env,
    cwd = process.cwd(),
    interactive = Boolean(process.stdout.isTTY || process.stderr.isTTY),
    holdsMarker = holdsRootMarker,
) => {
    const decided = routesCommandToNative(args, platform, environment, cwd, interactive, holdsMarker);

    if (decided !== undefined) {
        return decided;
    }

    // The binary also renders the help surface from its generated manifest: bare
    // `vis`, `help …`, and `--help` / `-h` anywhere before a `--` separator. It
    // delegates whatever it cannot answer to `dist/bin.js` itself (never back through
    // the launcher), so these are safe to hand over.
    return args.length === 0 || args[0] === "help" || asksForHelp(args);
};

// eslint-disable-next-line import/prefer-default-export -- named like `resolve-binary.mjs`; more routing helpers will join it
export { routesToNative };
