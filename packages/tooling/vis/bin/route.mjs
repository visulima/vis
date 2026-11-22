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

// Whether the launcher's root search ends at `cwd`, so a binary that computes the root from the working
// directory finds the same one as Node. The inherited `VIS_MONOREPO_ROOT` is only a reason to delegate,
// never the root itself.
const cwdIsRoot = (environment, cwd, holdsMarker) => {
    const inheritedRoot = environment.VIS_MONOREPO_ROOT;

    if (inheritedRoot && inheritedRoot !== cwd) {
        return false;
    }

    return rootIsCwd(cwd, holdsMarker);
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

    if (!cwdIsRoot(environment, cwd, holdsMarker)) {
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

// A version `vis self-update` hands to npm natively: `x.y.z` with an optional `-pre` and `+build` part. Same
// shape as `is_plain_version` in `native/cli/src/self_update.rs`.
const SELF_UPDATE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?(?:\+[0-9A-Z.-]+)?$/i;

// Whether `vis self-update` can pass the binary's native gate (`parse` and `native_context` in `self_update.rs`):
// at most one plain version and each of `--check`, `--force`, `--silent` at most once, in a CI context off a
// terminal, without `DEBUG`, `CEREBRO_*` or an inherited `VIS_MONOREPO_ROOT`. The binary re-checks everything, including the
// config and Deno files, `VIS_VERSION` and npm itself; this only skips the extra process when it would delegate
// anyway. It stays in Node on Windows.
const selfUpdateMayRunNatively = (platform, environment, args, interactive) => {
    if (platform === "win32" || interactive || !inCi(environment) || environment.DEBUG !== undefined || environment.VIS_MONOREPO_ROOT !== undefined || Object.keys(environment).some((key) => key.startsWith("CEREBRO_"))) {
        return false;
    }

    const flags = new Set();
    let version = false;

    for (const argument of args.slice(1)) {
        if (["--check", "--force", "--silent"].includes(argument) && !flags.has(argument)) {
            flags.add(argument);
        } else if (!version && SELF_UPDATE_VERSION.test(argument)) {
            version = true;
        } else {
            return false;
        }
    }

    return true;
};

const CACHE_NATIVE_SUBCOMMANDS = new Set(["hash", "list", "size"]);

// Whether `vis cache list|size` can pass the binary's native gate (`answer` in `cache.rs`). The binary
// re-checks everything, including the flags, the root and the config; this only skips the extra process
// when it would delegate anyway: not on Windows, not in a terminal, and only in a CI context. `hash` has
// its own, stricter gate above.
const cacheMayRunNatively = (subcommand, platform, environment, args, interactive) => {
    if (subcommand === "hash") {
        return cacheHashMayRunNatively(platform, environment, args, interactive);
    }

    return platform !== "win32" && !interactive && inCi(environment);
};

// Whether `vis affected` can pass the binary's native gate (`answer` in `affected.rs`). Only the
// `--sparse-checkout` shape is native, in a CI context; every other shape forwards to `vis run
// --affected`, which the binary hands to Node itself. The binary re-checks everything, so this only
// skips the extra process when it would delegate anyway.
const affectedMayRunNatively = (platform, environment, args, interactive) =>
    platform !== "win32" && !interactive && inCi(environment) && args.includes("--sparse-checkout");

// The value of a `--name value` or `--name=value` option at `args[index]`, as `[value, next index]`:
// `undefined` when the argument is not that option, `false` when its value is missing or looks like a flag.
const optionValue = (args, index, name) => {
    if (args[index] === name) {
        const value = args[index + 1];

        return value === undefined || value === "" || value.startsWith("-") ? false : [value, index + 2];
    }

    if (args[index].startsWith(`${name}=`)) {
        const value = args[index].slice(name.length + 1);

        return value === "" || value.startsWith("-") ? false : [value, index + 1];
    }

    return undefined;
};

// Whether `vis secrets` can pass the binary's native gate (`parse` and `context` in `secrets.rs`): the
// working-tree scan with `--format json|sarif|text`, `--quiet` and `--baseline <file>`, each at most once,
// and the text view only with `--quiet`. The binary re-checks everything, including the workspace root
// and the ignore and config files; this only skips the extra process when it would delegate anyway. Like
// `ignore`, it stays in Node when the working directory is not the workspace root. Like `clean`, it never
// answers on Windows or on a terminal, and not where Node's colour, `NODE_ENV`, `DEBUG`, `PAIL_LOG_LEVEL`
// or `CEREBRO_*` output settings could change what the status lines look like.
const secretsMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || IGNORE_COLOUR_ENVIRONMENT.some((key) => environment[key] !== undefined) || !plainTerm(environment)) {
        return false;
    }

    if (
        ["debug", "test"].includes(environment.NODE_ENV)
        || environment.DEBUG !== undefined
        || environment.PAIL_LOG_LEVEL !== undefined
        || Object.keys(environment).some((key) => key.startsWith("CEREBRO_"))
    ) {
        return false;
    }

    let format;
    let quiet = false;
    let baseline = false;
    let index = 1;

    while (index < args.length) {
        if (args[index] === "--quiet" && !quiet) {
            quiet = true;
            index += 1;

            continue;
        }

        const given = optionValue(args, index, "--format");

        if (given === false || (given !== undefined && (format !== undefined || !["json", "sarif", "text"].includes(given[0])))) {
            return false;
        }

        if (given !== undefined) {
            [format, index] = given;

            continue;
        }

        const base = optionValue(args, index, "--baseline");

        if (!Array.isArray(base) || baseline) {
            return false;
        }

        baseline = true;
        [, index] = base;
    }

    return (format ?? "text") !== "text" || quiet;
};

// The flags `vis install` takes natively (`parse` in `install.rs`): each at most once, none of them with a value
// except `--filter`, and no package names (those run the `add` pipeline).
const INSTALL_FLAGS = [
    ["-D", "--dev"],
    ["-P", "--prod"],
    ["-f", "--force"],
    ["--frozen-lockfile"],
    ["--no-frozen-lockfile"],
    ["--lockfile-only"],
    ["--no-optional"],
    ["--offline"],
    ["-r", "--recursive"],
    ["--run-scripts"],
    ["-s", "--silent"],
    ["-w", "--workspace-root"],
];

// Where the arguments continue after the `--filter` option at `flags[index]`: `undefined` when it is another
// argument, `-1` when its value is missing or looks like a flag.
const afterFilter = (flags, index) => {
    const flag = flags[index];

    if (flag.startsWith("--filter=")) {
        const inline = flag.slice("--filter=".length);

        return inline === "" || inline.startsWith("-") ? -1 : index + 1;
    }

    if (flag !== "-F" && flag !== "--filter") {
        return undefined;
    }

    const value = flags[index + 1];

    return value === undefined || value === "" || value.startsWith("-") ? -1 : index + 2;
};

// Whether the arguments after `install` / `i` are a shape the binary answers: the flags above, `--filter` with a value.
const installShapeIsNative = (flags) => {
    const seen = new Set();
    let index = 0;

    while (index < flags.length) {
        const next = afterFilter(flags, index);

        if (next === -1) {
            return false;
        }

        if (next !== undefined) {
            index = next;

            continue;
        }

        const flag = flags[index];
        const group = INSTALL_FLAGS.find((names) => names.includes(flag));

        if (group === undefined || seen.has(group)) {
            return false;
        }

        seen.add(group);
        index += 1;
    }

    // Node rejects these pairs with a usage error.
    const named = (...names) => names.some((name) => flags.includes(name));

    return !(named("-D", "--dev") && named("-P", "--prod")) && !(named("--frozen-lockfile") && named("--no-frozen-lockfile"));
};

// Whether the context lets `vis install` and `vis add` pass the binary's native gate (`install::setup` in
// `install.rs`): a CI context with no terminal, no colour and none of the variables that change which installer Node
// picks or what its output looks like. It stays in Node on Windows, where Node runs the package manager through a shell.
const installContextIsNative = (platform, environment, interactive) => {
    if (platform === "win32" || interactive || !inCi(environment) || IGNORE_COLOUR_ENVIRONMENT.some((key) => environment[key] !== undefined) || !plainTerm(environment)) {
        return false;
    }

    return !(
        ["debug", "test"].includes(environment.NODE_ENV)
        || ["DEBUG", "PAIL_LOG_LEVEL", "VIS_INSTALLER", "VIS_MONOREPO_ROOT", "VIS_RUNTIME", "VIS_SECURITY_WARNINGS"].some((key) => environment[key] !== undefined)
        || Object.keys(environment).some((key) => key.startsWith("CEREBRO_") || key.startsWith("MARSHALL_"))
    );
};

// Whether `vis install` can pass the binary's native gate (`plan` in `install.rs`): the plain install in that
// context. The binary re-checks everything, including the workspace root, the config and `package.json`; this only
// skips the extra process when it would delegate anyway.
const installMayRunNatively = (platform, environment, args, interactive) => installContextIsNative(platform, environment, interactive) && installShapeIsNative(args.slice(1));

// The flags `vis add` takes natively (`parse` in `add.rs`): each at most once, none of them with a value except
// `--filter`. `--no-marshall-check` is required: without it Node looks the packages up in the registry first.
const ADD_FLAGS = [
    ["-D", "--save-dev"],
    ["-E", "--exact"],
    ["-O", "--save-optional"],
    ["-P", "--save-peer"],
    ["-g", "--global"],
    ["-w", "--workspace-root"],
    ["--workspace"],
    ["--run-scripts"],
    ["--no-marshall-check"],
    ["--no-socket-check"],
    ["--no-typosquat-check"],
];

// A package argument of the plain `name[@spec]` or `@scope/name[@spec]` shape (`parse_package_argument` in `add.rs`).
const ADD_PACKAGE = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(?:@[\w.^~<>=*|+:/#,@-]+)?$/i;

// Whether the arguments after `add` are a shape the binary answers: plain packages first, then the flags above and
// `--filter` with a value, and `--no-marshall-check` among them.
const addShapeIsNative = (rest) => {
    const seen = new Set();
    let packages = 0;
    let filtered = false;
    let index = 0;

    while (index < rest.length) {
        const next = afterFilter(rest, index);

        if (next === -1) {
            return false;
        }

        if (next !== undefined) {
            filtered = true;
            index = next;

            continue;
        }

        const flag = rest[index];
        const group = ADD_FLAGS.find((names) => names.includes(flag));

        if (group === undefined) {
            // Node reads every word after `--filter` as another filter, so a package after one is no package.
            if (filtered || flag.startsWith("-") || !ADD_PACKAGE.test(flag)) {
                return false;
            }

            packages += 1;
            index += 1;

            continue;
        }

        if (seen.has(group)) {
            return false;
        }

        seen.add(group);
        index += 1;
    }

    return packages > 0 && rest.includes("--no-marshall-check");
};

// Whether `vis add` can pass the binary's native gate (`plan` in `add.rs`). The binary re-checks everything,
// including the packages against the typosquat blocklist; this only skips the extra process when it would delegate anyway.
const addMayRunNatively = (platform, environment, args, interactive) => installContextIsNative(platform, environment, interactive) && addShapeIsNative(args.slice(1));

// Whether `vis sync ci-workflow` can pass the binary's native gate (`native_root` and `parse` in
// `ci_workflow/mod.rs`): the generator and its `--check`, with `--check` at most once and any number of
// `--provider` values. The binary re-checks everything, including the config, the providers and the
// workspace; this only skips the extra process when it would delegate anyway. Like `secrets`, it stays in
// Node when the working directory is not the workspace root, on Windows, on a terminal, and where Node's
// colour, `NODE_ENV`, `DEBUG`, `PAIL_LOG_LEVEL` or `CEREBRO_*` output settings could change the log lines.
const syncCiWorkflowMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || IGNORE_COLOUR_ENVIRONMENT.some((key) => environment[key] !== undefined) || !plainTerm(environment)) {
        return false;
    }

    if (
        ["debug", "test"].includes(environment.NODE_ENV)
        || environment.DEBUG !== undefined
        || environment.PAIL_LOG_LEVEL !== undefined
        || Object.keys(environment).some((key) => key.startsWith("CEREBRO_"))
    ) {
        return false;
    }

    let check = false;
    let index = 2;

    while (index < args.length) {
        if (args[index] === "--check" && !check) {
            check = true;
            index += 1;

            continue;
        }

        const given = optionValue(args, index, "--provider");

        if (!Array.isArray(given)) {
            return false;
        }

        [, index] = given;
    }

    return true;
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

// Commands whose routing needs no flag check here, because the binary decides every shape itself: the
// native command set, `hook run` (the other `hook` subcommands - install, migrate, ... - are not native,
// so routing them through the binary would only add a second Node boot) and `advisories bloom status`.
// The binary answers that one natively only for `--format json --cache-dir <dir>` and hands every other
// shape to Node, as it does for `hook run`; the launcher does not check those flags.
const alwaysNative = (command, subcommand, args) =>
    NATIVE_COMMANDS.has(command) || (command === "hook" && subcommand === "run") || (command === "advisories" && subcommand === "bloom" && args[2] === "status");

// The commands with a native shape, by the name they are typed with, each with the gate that decides it. A gate
// answers `undefined` for a subcommand that is not one of them; the binary re-checks everything, so a gate only
// skips the extra process when the binary would delegate anyway, and any other run is delegated by the binary,
// which costs a second Node boot. The notes name the binary's module for each command.
const NATIVE_SHAPE_GATES = new Map([
    ["add", ({ args, environment, interactive, platform }) => helpOrNative(args, () => addMayRunNatively(platform, environment, args, interactive))],
    // `affected <target> --sparse-checkout`.
    ["affected", ({ args, environment, interactive, platform }) => helpOrNative(args, () => affectedMayRunNatively(platform, environment, args, interactive))],
    // `cache list`, `cache size` (`cache.rs`) and `cache hash` (`cache_hash.rs`); the binary hands every other shape to Node itself.
    [
        "cache",
        ({ args, environment, interactive, platform, subcommand }) => {
            if (!CACHE_NATIVE_SUBCOMMANDS.has(subcommand)) {
                return undefined;
            }

            return helpOrNative(args, () => cacheMayRunNatively(subcommand, platform, environment, args, interactive));
        },
    ],
    // No flags, `--dry-run` and `--lockfile`; a terminal stdout stays in Node, where pail colours its output and the binary does not.
    ["clean", ({ args, environment, interactive, platform }) => helpOrNative(args, () => cleanMayRunNatively(platform, environment, args, interactive))],
    ["i", ({ args, environment, interactive, platform }) => helpOrNative(args, () => installMayRunNatively(platform, environment, args, interactive))],
    ["ignore", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => ignoreMayRunNatively(platform, environment, cwd, interactive, holdsMarker))],
    ["install", ({ args, environment, interactive, platform }) => helpOrNative(args, () => installMayRunNatively(platform, environment, args, interactive))],
    ["list", ({ args, environment, interactive, platform }) => helpOrNative(args, () => listMayRunNatively(platform, environment, args, interactive))],
    // The plain working-tree scan.
    ["secrets", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => secretsMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    // `--check` and the up-to-date verdicts; an install is handed to Node before anything is printed.
    ["self-update", ({ args, environment, interactive, platform }) => helpOrNative(args, () => selfUpdateMayRunNatively(platform, environment, args, interactive))],
    // The generator and its `--check`; the other `sync` kinds are Node's and follow the help rule below.
    [
        "sync",
        ({ args, cwd, environment, holdsMarker, interactive, platform, subcommand }) => {
            if (subcommand !== "ci-workflow") {
                return undefined;
            }

            return helpOrNative(args, () => syncCiWorkflowMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker));
        },
    ],
]);

// The routing of the commands that have their own native shapes: `true` or `false` when the
// command decides, `undefined` when it is left to the help-surface rule in `routesToNative`.
const routesCommandToNative = (args, platform, environment, cwd, interactive, holdsMarker = holdsRootMarker) => {
    const [command = "", subcommand] = args;

    if (alwaysNative(command, subcommand, args)) {
        return true;
    }

    const gated = NATIVE_SHAPE_GATES.get(command)?.({ args, cwd, environment, holdsMarker, interactive, platform, subcommand });

    if (gated !== undefined) {
        return gated;
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
