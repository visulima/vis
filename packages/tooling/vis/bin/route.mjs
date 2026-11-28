import { existsSync, statSync } from "node:fs";
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
//
// `--help` / `-h` before a `--` is vis's own help for these too (except `x`, whose entry keeps it for the file
// name Node takes it for): the binary answers it from its manifest and never asks the package manager, so
// the launcher needs no help rule for them. `Help` in `native/cli/src/route.rs` is the binary's half.
const NATIVE_COMMANDS = new Set(["--version", "-V", "__native-info", "__pm-shim", "dedupe", "exec", "link", "outdated", "pm", "remove", "unlink", "why", "x"]);

// `--help` / `-h` anywhere before a `--` separator.
const asksForHelp = (args) => {
    const separatorIndex = args.indexOf("--");
    const optionArguments = separatorIndex === -1 ? args : args.slice(0, separatorIndex);

    return optionArguments.some((argument) => argument === "--help" || argument === "-h");
};

// `TERM` values whose terminfo entry is 80 columns by 24 lines, the size the width lookup of pail treats as "no
// answer". Same list as `TERMS_WITH_DEFAULT_SIZE` in `native/cli/src/pail.rs`; keep them in step.
const TERMS_WITH_DEFAULT_SIZE = new Set([
    "alacritty",
    "ansi",
    "dumb",
    "foot",
    "ghostty",
    "kitty",
    "linux",
    "rxvt",
    "rxvt-256color",
    "rxvt-unicode",
    "rxvt-unicode-256color",
    "screen",
    "screen-256color",
    "screen-bce",
    "tmux",
    "tmux-256color",
    "vt100",
    "vt220",
    "wezterm",
    "xterm",
    "xterm-16color",
    "xterm-256color",
    "xterm-color",
    "xterm-direct",
    "xterm-ghostty",
    "xterm-kitty",
]);

// The Node runtime warns on stderr, with its process id, when `FORCE_COLOR` is set together with `NO_COLOR` or
// `NODE_DISABLE_COLORS`. The binary leaves such a run to Node for every command (`node_warns_about_colour` in `term.rs`).
const nodeWarnsAboutColour = (environment) => environment.FORCE_COLOR !== undefined && (environment.NO_COLOR !== undefined || environment.NODE_DISABLE_COLORS !== undefined);

const LEADING_DASHES = /^-+/;

const isColourFlag = (argument) => {
    const name = argument.replace(LEADING_DASHES, "");

    return argument.startsWith("-") && (name.startsWith("color") || name.startsWith("no-color"));
};

// Whether the binary can decide the colour Node prints (`colourIsDecidable`), and for the commands that log through pail
// also what pail prints (`pailOutputIsDecidable`). The colour of the header of each pail line follows the detection in
// `piped_colour_level` (`native/cli/src/term.rs`), and the width of a line follows `pail_width` (`native/cli/src/pail.rs`).
// The binary answers for every colour environment (`GITHUB_ACTIONS`, `FORCE_COLOR`, ...) and prints the codes Node prints.
// It leaves to Node: a colour flag among the arguments (`bin.ts` turns `--no-color` into `NO_COLOR`); a PM2 process
// without `CI` set (Node treats it as a terminal, which only the checks after the CI providers look at); `FORCE_COLOR`
// together with `NO_COLOR` or `NODE_DISABLE_COLORS` (the Node runtime then warns on stderr, with its process id); and, where
// the width matters, a `TERM` that may give pail another width than 80 (it asks `tput`). The binary also leaves a process
// with a controlling terminal to Node, which the launcher does not check.
const colourIsDecidable = (environment, args) =>
    !args.some((argument) => isColourFlag(argument)) && !(environment.CI === undefined && environment.PM2_HOME !== undefined && environment.pm_id !== undefined) && !nodeWarnsAboutColour(environment);

const pailOutputIsDecidable = (environment, args) => colourIsDecidable(environment, args) && (environment.TERM === undefined || TERMS_WITH_DEFAULT_SIZE.has(environment.TERM));

// `DEBUG` and `CEREBRO_*`: the part of the output settings that makes Node trace a command around the output it prints. The
// binary keeps the same list in `debug_output_is_default` (`native/cli/src/node_context.rs`). A command that prints through no
// logger of its own (`exec`, `hook run`, the package-manager commands, `cache list`, `cache size`) needs only this part.
const debugOutputIsDefault = (environment) => environment.DEBUG === undefined && !Object.keys(environment).some((key) => key.startsWith("CEREBRO_"));

// The output settings that change what the binary's log lines (and the commands that print JSON beside them) look like:
// `NODE_ENV` of `test` or `debug`, `DEBUG`, `PAIL_LOG_LEVEL` and `CEREBRO_*`. A run with any of them stays in Node.
// The binary keeps the same list in `output_settings_are_default` (`native/cli/src/node_context.rs`); the `NODE_ENV`, `DEBUG`,
// `PAIL_LOG_LEVEL` and `CEREBRO_*` cases of `native/cli/tests/fixtures/routing.json` run both halves and fail when they differ.
const outputSettingsAreDefault = (environment) => !["debug", "test"].includes(environment.NODE_ENV) && environment.PAIL_LOG_LEVEL === undefined && debugOutputIsDefault(environment);

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

// The variables that change how Node's `fetch` reaches a server or whom it trusts, or that the native HTTP client reads
// differently: the proxy variables and Node's switch for reading them, the CA files, and the Node options. The binary keeps
// the same list in `NETWORK_VARIABLES` (`http/node_fetch.rs`); the shared cases of `native/cli/tests/fixtures/routing.json` run
// both halves for each variable and fail when the two differ. `NO_PROXY` alone changes nothing.
const NETWORK_VARIABLES = [
    "ALL_PROXY",
    "all_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NODE_USE_ENV_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_OPTIONS",
];

const networkEnvironmentIsPlain = (environment) => NETWORK_VARIABLES.every((name) => environment[name] === undefined);

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
// It never answers `ignore` on Windows (path handling differs there).
const ignoreMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive) {
        return false;
    }

    if (!inCi(environment) || !outputSettingsAreDefault(environment)) {
        return false;
    }

    if (!cwdIsRoot(environment, cwd, holdsMarker)) {
        return false;
    }

    return colourIsDecidable(environment, args);
};

// Whether `vis clean` can pass the binary's native gate (`plan` in `clean.rs`). The binary re-checks
// everything; this only skips the extra process when it would delegate anyway. Flags are the
// default, `--dry-run` and `--lockfile`/`-l`, each at most once. `plan` delegates everywhere but
// unix (its header clock is unix-only), so Windows stays in Node.
const cleanMayRunNatively = (platform, environment, args, interactive) => {
    if (platform === "win32" || interactive) {
        return false;
    }

    if (!inCi(environment) || !pailOutputIsDecidable(environment, args) || !outputSettingsAreDefault(environment)) {
        return false;
    }

    const flags = args.slice(1);
    const known = new Set(["--dry-run", "--lockfile", "-l"]);

    return flags.every((flag) => known.has(flag)) && new Set(flags).size === flags.length;
};

// Whether `vis implode` can pass the binary's native gate (`plan` in `implode.rs`): no flag or one `--yes`/`-y`, in a
// CI context off a terminal. The binary re-checks everything, including the workspace, the home directory and the
// profiles it would edit, so this only skips the extra process for a call it would delegate anyway. Windows stays in Node.
const implodeMayRunNatively = (platform, environment, args, interactive) => {
    if (platform === "win32" || interactive || !inCi(environment) || nodeWarnsAboutColour(environment) || !outputSettingsAreDefault(environment)) {
        return false;
    }

    const flags = args.slice(1);

    return flags.length === 0 || (flags.length === 1 && (flags[0] === "--yes" || flags[0] === "-y"));
};

// Variables that send `vis run` to Node: the remote cache, the cache location, selection, concurrency,
// logging. Same list as `NODE_ONLY_VARIABLES` in `native/cli/src/run.rs`; keep them in step. The CI providers'
// log grouping (`GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `TF_BUILD`) is printed by the binary itself.
const RUN_NODE_ONLY_VARIABLES = [
    "CACHE_TOKEN",
    "DEBUG",
    "PAIL_LOG_LEVEL",
    "TURBO_API",
    "TURBO_TEAM",
    "TURBO_TOKEN",
    "VIS_AFFECTED_FILES",
    "VIS_CACHE_DIRECTORY",
    "VIS_CLI_TEST",
    "VIS_PARTITION",
    "VIS_POLYFILL",
    "VIS_RUNNER_TAGS",
    "VIS_RUNTIME",
    "VIS_RUN_CONCURRENCY_LIMIT",
];

// Whether a task cache can exist for `cwd`: the default directory is there, or the checkout is a linked
// worktree (`.git` is a file), whose cache lives in the main checkout. Without one nothing can hit, so the
// run goes to Node without the extra process.
const taskCacheMayExist = (cwd) => {
    try {
        if (statSync(join(cwd, ".git")).isFile()) {
            return true;
        }
    } catch {
        // No `.git`: the checkout is its own cache anchor.
    }

    return existsSync(join(cwd, "node_modules", ".cache", "vis"));
};

// Whether `vis run <target>` can pass the binary's native gate (`attempt` in `run.rs`): exactly one plain target and
// no flag, in a CI context off a terminal, with none of the variables above, from a workspace root that already has
// a task cache. The binary re-checks everything and also needs the launcher's hand-off (it answers only a run in which
// every task is a cache hit and hands every other run to Node before printing anything), so this only skips the extra
// process when it would delegate anyway. Windows is answered too: the binary's output there was compared with the Node
// CLI's on Windows (`tests/windows_node_parity.rs`), and what it cannot reproduce there (a toolchain pin, a task order
// the file system decides) it hands back like any other miss.
const runMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker, cacheMayExist) => {
    if (interactive || !inCi(environment) || nodeWarnsAboutColour(environment) || args.length !== 2 || args[1].startsWith("-")) {
        return false;
    }

    // `CI` itself, not just `CONTINUOUS_INTEGRATION`: parts of the Node run read `process.env.CI` directly.
    if (!environment.CI || environment.CI === "0" || environment.CI === "false") {
        return false;
    }

    if (
        RUN_NODE_ONLY_VARIABLES.some((key) => environment[key] !== undefined)
        || ["debug", "test"].includes(environment.NODE_ENV)
        // Windows reads its variables without regard to case, and so does Node's `process.env`.
        || Object.keys(environment).some((key) => (platform === "win32" ? key.toUpperCase() : key).startsWith("CEREBRO_"))
    ) {
        return false;
    }

    return cwdIsRoot(environment, cwd, holdsMarker) && cacheMayExist(cwd);
};

// The argument lists (after `list`) that the binary answers natively.
const LIST_NATIVE_SHAPES = [[], ["--json"], ["--format", "json"], ["--format", "table"], ["--format=json"], ["--format=table"]];

// Whether `vis list` can pass the binary's native gate (`run` in `list.rs`). Only the plain listing
// is native: no flags, `--json`, or one `--format` value. The binary re-checks the CI context and
// every other shape, so this only skips the extra process when it would delegate anyway.
const listMayRunNatively = (platform, environment, args, interactive) => {
    if (interactive || !inCi(environment) || nodeWarnsAboutColour(environment) || !outputSettingsAreDefault(environment)) {
        return false;
    }

    const flags = args.slice(1);

    return LIST_NATIVE_SHAPES.some((shape) => shape.length === flags.length && shape.every((flag, index) => flags[index] === flag));
};

// Whether `vis cache hash` can pass the binary's native gate (`native` in `cache_hash.rs`). The
// binary re-checks the context and every shape (one task id, `--format json|table`, `--run <id>`),
// so this only skips the extra process for a call that would be delegated anyway: no task id, a
// flag the binary does not know, or a table in a colour context the binary cannot decide (the JSON is written
// raw, so colour does not matter there). It stays in Node on Windows
// (pail's clock is unix-only there).
const CACHE_HASH_FLAG = /^--(?:format|run)(?:=.*)?$/;

const cacheHashAsksForJson = (flags) => flags.includes("--format=json") || flags.some((flag, index) => flag === "--format" && flags[index + 1] === "json");

const cacheHashMayRunNatively = (platform, environment, args, interactive) => {
    const flags = args.slice(2);

    if (platform === "win32" || interactive || !inCi(environment) || !outputSettingsAreDefault(environment) || flags.length === 0 || !flags.every((token) => !token.startsWith("-") || CACHE_HASH_FLAG.test(token))) {
        return false;
    }

    return cacheHashAsksForJson(flags) || pailOutputIsDecidable(environment, args);
};

// Whether `vis replay` can pass the binary's native gate (`parse` and `native` in `replay.rs`): `--format`, `--run` and
// `--task` with a value, `--failed` and `--list`, in a CI context off a terminal. The binary re-checks everything, so
// this only skips the extra process for a call it would delegate anyway: another flag, or a table in a colour context
// the binary cannot decide (the JSON is written raw, so colour does not matter there). Windows stays in Node.
const REPLAY_FLAG = /^--(?:format|run|task)(?:=.*)?$|^--(?:failed|list)$/;

const replayMayRunNatively = (platform, environment, args, interactive) => {
    const flags = args.slice(1);

    if (platform === "win32" || interactive || !inCi(environment) || !outputSettingsAreDefault(environment) || !flags.every((token) => !token.startsWith("-") || REPLAY_FLAG.test(token))) {
        return false;
    }

    return cacheHashAsksForJson(flags) || pailOutputIsDecidable(environment, args);
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
    if (
        platform === "win32"
        || interactive
        || !inCi(environment)
        || nodeWarnsAboutColour(environment)
        || environment.DEBUG !== undefined
        || environment.VIS_MONOREPO_ROOT !== undefined
        || Object.keys(environment).some((key) => key.startsWith("CEREBRO_"))
    ) {
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

const CACHE_NATIVE_SUBCOMMANDS = new Set(["clean", "hash", "list", "prune", "size", "why"]);

// Whether `vis cache clean` can pass the binary's native gate (`plan` in `cache_clean.rs`): `--cache-dir <dir>`, `--type <store>`,
// `--dry-run` and `--force`, in a CI context off a terminal where pail's layout is decidable (every message is a pail block).
// The binary re-checks everything, including the directory it would delete, so this only skips the extra process for a
// call it would delegate anyway.
const CACHE_CLEAN_VALUE_FLAG = /^--(?:cache-dir|type)$/;
const CACHE_CLEAN_FLAG = /^--(?:cache-dir|type)=.+$|^--(?:dry-run|force)$/;

const cacheCleanMayRunNatively = (platform, environment, args, interactive) => {
    if (platform === "win32" || interactive || !inCi(environment) || !pailOutputIsDecidable(environment, args) || !outputSettingsAreDefault(environment)) {
        return false;
    }

    const flags = args.slice(2);

    return flags.every((token, index) => CACHE_CLEAN_FLAG.test(token) || CACHE_CLEAN_VALUE_FLAG.test(token) || (!token.startsWith("-") && CACHE_CLEAN_VALUE_FLAG.test(flags[index - 1] ?? "")));
};

// Whether `vis cache prune` can pass the binary's native gate (`plan` in `cache_prune.rs`): `--cache-dir`, `--scope`, `--keep-last`,
// `--max-age-days` and `--max-size`, each with a value, in a CI context off a terminal where pail's layout is decidable (every
// message is a pail block). The binary re-checks everything, including the number and size shapes and the entries it would
// remove, so this only skips the extra process for a call it would delegate anyway.
const CACHE_PRUNE_VALUE_FLAG = /^--(?:cache-dir|scope|keep-last|max-age-days|max-size)$/;
const CACHE_PRUNE_INLINE_FLAG = /^--(?:cache-dir|scope|keep-last|max-age-days|max-size)=.+$/;

const cachePruneMayRunNatively = (platform, environment, args, interactive) => {
    if (platform === "win32" || interactive || !inCi(environment) || !pailOutputIsDecidable(environment, args) || !outputSettingsAreDefault(environment)) {
        return false;
    }

    const flags = args.slice(2);

    return flags.every((token, index) => CACHE_PRUNE_INLINE_FLAG.test(token) || CACHE_PRUNE_VALUE_FLAG.test(token) || (!token.startsWith("-") && CACHE_PRUNE_VALUE_FLAG.test(flags[index - 1] ?? "")));
};

// Whether `vis cache list|size` can pass the binary's native gate (`answer` in `cache.rs`). The binary
// re-checks everything, including the flags, the root and the config; this only skips the extra process
// when it would delegate anyway: not on Windows, not in a terminal, and only in a CI context. `hash` and
// `why` (`cache_why.rs`, the same flags) have their own, stricter gate above.
const cacheMayRunNatively = (subcommand, platform, environment, args, interactive) => {
    if (subcommand === "hash" || subcommand === "why") {
        return cacheHashMayRunNatively(platform, environment, args, interactive);
    }

    if (subcommand === "clean") {
        return cacheCleanMayRunNatively(platform, environment, args, interactive);
    }

    if (subcommand === "prune") {
        return cachePruneMayRunNatively(platform, environment, args, interactive);
    }

    return platform !== "win32" && !interactive && inCi(environment) && !nodeWarnsAboutColour(environment) && debugOutputIsDefault(environment);
};

// Whether `vis affected` can pass the binary's native gate (`answer` in `affected.rs`). Only the
// `--sparse-checkout` shape is native, in a CI context; every other shape forwards to `vis run
// --affected`, which the binary hands to Node itself. The binary re-checks everything, so this only
// skips the extra process when it would delegate anyway.
const affectedMayRunNatively = (platform, environment, args, interactive) =>
    platform !== "win32" && !interactive && inCi(environment) && !nodeWarnsAboutColour(environment) && outputSettingsAreDefault(environment) && args.includes("--sparse-checkout");

// Whether `vis status` can pass the binary's native gate (`parse` and `answer` in `status.rs`): the plain overview or
// `--json`, in a CI context off a terminal. The binary re-checks everything, including whether it can learn the Node
// version a pin needs, so this only skips the extra process when it would delegate anyway. A workspace with a `vis.config` takes the
// same gate: the launcher does not look at the config, because the binary reads a literal one itself (`config_workspace.rs`), answers
// only the keys it has shown cannot change the overview, and hands every other config, and a run from a project directory, to Node.
const statusMayRunNatively = (platform, environment, args, interactive) =>
    !interactive && inCi(environment) && !nodeWarnsAboutColour(environment) && outputSettingsAreDefault(environment) && (args.length === 1 || (args.length === 2 && args[1] === "--json"));

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
// answers on Windows or on a terminal, and not where `NODE_ENV`, `DEBUG`, `PAIL_LOG_LEVEL`
// or `CEREBRO_*` output settings could change what the status lines look like.
const secretsMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || !pailOutputIsDecidable(environment, args)) {
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
// `install.rs`): a CI context with no terminal, no colour the binary cannot decide and none of the variables that change which installer Node
// picks or what its output looks like. It stays in Node on Windows, where Node runs the package manager through a shell.
// `allowedMarshall` names the `MARSHALL_*` variables the command reads itself; any other one changes what Node does before it installs.
const installContextIsNative = (platform, environment, args, interactive, allowedMarshall = []) => {
    if (platform === "win32" || interactive || !inCi(environment) || !pailOutputIsDecidable(environment, args)) {
        return false;
    }

    return !(
        ["debug", "test"].includes(environment.NODE_ENV)
        || ["DEBUG", "PAIL_LOG_LEVEL", "VIS_INSTALLER", "VIS_MONOREPO_ROOT", "VIS_RUNTIME", "VIS_SECURITY_WARNINGS"].some((key) => environment[key] !== undefined)
        || Object.keys(environment).some((key) => key.startsWith("CEREBRO_") || (key.startsWith("MARSHALL_") && !allowedMarshall.includes(key)))
    );
};

// Whether `vis install` can pass the binary's native gate (`plan` in `install.rs`): the plain install in that
// context. The binary re-checks everything, including the workspace root, the config and `package.json`; this only
// skips the extra process when it would delegate anyway.
const installMayRunNatively = (platform, environment, args, interactive) => installContextIsNative(platform, environment, args, interactive) && installShapeIsNative(args.slice(1));

// The flags `vis add` takes natively (`parse` in `add.rs`): each at most once, none of them with a value except
// `--filter`.
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

// The `MARSHALL_DISABLE_*` variables of the marshalls the check of `vis add` runs (`disable_variables` in
// `native/cli/src/marshall_check/mod.rs`), which the binary reads; any other `MARSHALL_*` variable stays in Node.
const ADD_MARSHALL_VARIABLES = [
    "ARCHIVED_REPO",
    "AUTHOR",
    "DEPRECATION",
    "DOWNLOADS",
    "EXPIRED_DOMAINS",
    "METADATA",
    "NEW_BIN",
    "PACKAGE_AGE",
    "PROVENANCE",
    "S1NGULARITY",
].map((name) => `MARSHALL_DISABLE_${name}`);

// Whether the arguments after `add` are a shape the binary answers: plain packages first, then the flags above and
// `--filter` with a value.
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

    return packages > 0;
};

// Whether `vis add` can pass the binary's native gate (`plan` in `add.rs`). The binary re-checks everything,
// including the packages against the typosquat blocklist; this only skips the extra process when it would delegate anyway.
// The native `add` has only been compared with Node's output where no colour is on, so any variable that can turn
// colour on keeps it in Node (the binary re-checks the colour level it finds).
const ADD_COLOUR_ENVIRONMENT = [
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

const addColourIsPlain = (environment) => {
    const term = environment.TERM?.toLowerCase();

    return !ADD_COLOUR_ENVIRONMENT.some((key) => environment[key] !== undefined) && (term === undefined || term.includes("dumb") || term.includes("mono"));
};

// The marshall check asks the registry and other services, which needs the environment to lead `fetch` and the binary's
// client to the same servers the same way; `--no-marshall-check` makes no request.
const addMayRunNatively = (platform, environment, args, interactive) =>
    installContextIsNative(platform, environment, args, interactive, ADD_MARSHALL_VARIABLES)
    && addColourIsPlain(environment)
    && addShapeIsNative(args.slice(1))
    && (args.includes("--no-marshall-check") || networkEnvironmentIsPlain(environment));

// A word of `vis info` the binary passes through (`is_plain_word` in `native/cli/src/info.rs`): the package, then the fields.
const INFO_WORD = /^[a-z@][\w@/.~^<>=*|+:#,-]*$/i;

// Whether `vis info` / `vis view` can pass the binary's native gate (`plan` in `info.rs`): plain words, at least one, and
// `--json` at most once, in the context `vis install` needs. The binary re-checks everything, including the workspace
// root, the config and the installer; this only skips the extra process when it would delegate anyway.
const infoMayRunNatively = (platform, environment, args, interactive) => {
    if (!installContextIsNative(platform, environment, args, interactive)) {
        return false;
    }

    const flags = args.slice(1);
    const words = flags.filter((flag) => flag !== "--json");

    return flags.length - words.length <= 1 && words.length > 0 && words.every((word) => INFO_WORD.test(word) && word !== "true" && word !== "false");
};

// The flags `vis dlx` takes natively (`parse` in `dlx.rs`), each at most once.
const DLX_FLAGS = [["--no-info"], ["-y", "--yes"], ["--offline"], ["-s", "--silent"], ["-c", "--shell-mode"]];

// The words of `vis dlx`, its `-p` packages and its flags, or `undefined` for a shape the binary does not answer: no other
// flag, no `--`, and `-p <word>` directly followed by another flag, because the option takes every word up to the next one.
const dlxShape = (rest) => {
    const shape = { flags: new Set(), packages: [], words: [] };
    const isFlag = (token) => token === "-p" || token === "--package" || DLX_FLAGS.some((names) => names.includes(token));

    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];

        if (token === "-p" || token === "--package") {
            const [value, after] = [rest[index + 1], rest[index + 2]];

            if (value === undefined || value === "" || value.startsWith("-") || after === undefined || !isFlag(after)) {
                return undefined;
            }

            shape.packages.push(value);
            index += 1;
        } else if (token.startsWith("-")) {
            const group = DLX_FLAGS.find((names) => names.includes(token));

            if (group === undefined || shape.flags.has(group[0])) {
                return undefined;
            }

            shape.flags.add(group[0]);
        } else {
            shape.words.push(token);
        }
    }

    return shape.words.length > 0 ? shape : undefined;
};

// Whether `vis dlx` can pass the binary's native gate (`plan` in `dlx.rs`): the shapes above, and an environment that
// leaves the installer and Node's output alone. The first-run gate is the binary's to decide (it does nothing with
// `--no-info`, `--yes`, CI or a stream that is not a terminal, and on a terminal it looks the package up and answers only
// for a version already approved), and so are the lockfiles, `packageManager` pins and `aube` on `PATH`; this only skips
// the extra process for a shape the binary would delegate anyway. The lean entry reads no config and no workspace root,
// and prints nothing of its own.
const dlxMayRunNatively = (platform, environment, args) => {
    if (
        platform === "win32"
        || nodeWarnsAboutColour(environment)
        || ["DEBUG", "VIS_INSTALLER", "VIS_RUNTIME"].some((key) => environment[key] !== undefined)
        || Object.keys(environment).some((key) => key.startsWith("CEREBRO_"))
    ) {
        return false;
    }

    return dlxShape(args.slice(1)) !== undefined;
};

// Whether `vis sync ci-workflow` can pass the binary's native gate (`native_root` and `parse` in
// `ci_workflow/mod.rs`): the generator and its `--check`, with `--check` at most once and any number of
// `--provider` values. The binary re-checks everything, including the config, the providers and the
// workspace; this only skips the extra process when it would delegate anyway. Like `secrets`, it stays in
// Node when the working directory is not the workspace root, on Windows, on a terminal, and where
// `NODE_ENV`, `DEBUG`, `PAIL_LOG_LEVEL` or `CEREBRO_*` output settings could change the log lines.
const syncCiWorkflowMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || !colourIsDecidable(environment, args)) {
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

// The flags `vis sort-package-json` takes natively (`parse` in `sort_package_json/mod.rs`): the boolean ones at most
// once each, and the ones with a value (`--name value` or `--name=value`, the value neither empty nor a flag). The
// list flags may repeat, the other two may not.
const SORT_PACKAGE_JSON_BOOLEAN_FLAGS = [
    ["--check", "-c"],
    ["--sort-scripts"],
    ["--no-editorconfig"],
    ["--no-final-newline"],
    ["--no-format-bugs"],
    ["--no-format-repository"],
    ["--no-sort-exports"],
];
const SORT_PACKAGE_JSON_LIST_FLAGS = ["--ignore", "--sort-order", "--unsorted"];
const SORT_PACKAGE_JSON_SINGLE_FLAGS = ["--indent", "--line-ending"];

// The flag at `flags[index]`: its name and the index after it (and its value), or `undefined` when the binary does not take it.
const sortPackageJsonFlagAt = (flags, index) => {
    const booleanFlag = SORT_PACKAGE_JSON_BOOLEAN_FLAGS.find((names) => names.includes(flags[index]));

    if (booleanFlag !== undefined) {
        return [booleanFlag[0], index + 1];
    }

    for (const name of [...SORT_PACKAGE_JSON_LIST_FLAGS, ...SORT_PACKAGE_JSON_SINGLE_FLAGS]) {
        const given = optionValue(flags, index, name);

        if (Array.isArray(given)) {
            return [name, given[1]];
        }
    }

    return undefined;
};

const sortPackageJsonShapeIsNative = (flags) => {
    const seen = new Set();
    let index = 0;

    while (index < flags.length) {
        const flag = sortPackageJsonFlagAt(flags, index);

        if (flag === undefined || (seen.has(flag[0]) && !SORT_PACKAGE_JSON_LIST_FLAGS.includes(flag[0]))) {
            return false;
        }

        seen.add(flag[0]);
        [, index] = flag;
    }

    return true;
};

// Whether `vis sort-package-json` can pass the binary's native gate (`context` and `parse` in
// `sort_package_json/mod.rs`): a pnpm workspace whose root is the working directory, in a CI context off a terminal,
// with no `vis.config`, and none of the variables that change what pail prints. The binary re-checks everything,
// including the workspace patterns, the ignore files and every file's JSON; this only skips the extra process when it
// would delegate anyway. It stays in Node on Windows.
const sortPackageJsonMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || !pailOutputIsDecidable(environment, args)) {
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

    return sortPackageJsonShapeIsNative(args.slice(1));
};

// The flags `vis sbom` takes natively (`parse` in `native/cli/src/sbom/mod.rs`): each at most once, `--format` only as
// `json`, `--include-dev` without a value, `--focus` and `--output` with one. `--output` is `-` (stdout) or a plain path.
const SBOM_FLAGS = new Set(["--focus", "--format", "--include-dev", "--output"]);

// The value of `--name value` or `--name=value` at `flags[index]` as `[value, next index]`, or `false` when it is missing,
// empty or looks like a flag; `-` is a value here, unlike in `optionValue`.
const sbomValue = (flags, index, name) => {
    const inline = flags[index] !== name;
    const value = inline ? flags[index].slice(name.length + 1) : flags[index + 1];

    return value === undefined || value === "" || (value !== "-" && value.startsWith("-")) ? false : [value, inline ? index + 1 : index + 2];
};

const SBOM_PRINTABLE_ASCII = /^[\u0021-\u007E]+$/;
const LEADING_SLASH = /^\//;

// A path `resolve` of `@visulima/path` leaves as typed: printable ASCII, no `\\`, one leading `/` at most (it folds `//a` into
// `/a`), no empty, `.` or `..` segment, no trailing `/`.
const sbomOutputIsPlain = (output) =>
    output === "-"
    || (SBOM_PRINTABLE_ASCII.test(output) && !output.includes("\\") && !output.startsWith("//") && !output.endsWith("/") && output.replace(LEADING_SLASH, "").split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));

const sbomValueIsNative = (name, value) => {
    if (name === "--format") {
        return value === "json";
    }

    if (name === "--output") {
        return sbomOutputIsPlain(value);
    }

    return [...value].every((character) => character.codePointAt(0) < 128);
};

// The output path of the arguments after `sbom` when they are a native shape, else `undefined`.
const sbomOutput = (flags) => {
    const seen = new Set();
    let output = "sbom.cdx.json";
    let index = 0;

    while (index < flags.length) {
        const name = flags[index].startsWith("--") ? flags[index].split("=")[0] : flags[index];

        if (!SBOM_FLAGS.has(name) || seen.has(name)) {
            return undefined;
        }

        seen.add(name);

        if (name === "--include-dev") {
            if (flags[index] !== name) {
                return undefined;
            }

            index += 1;

            continue;
        }

        const given = sbomValue(flags, index, name);

        if (given === false || !sbomValueIsNative(name, given[0])) {
            return undefined;
        }

        output = name === "--output" ? given[0] : output;
        [, index] = given;
    }

    return output;
};

// Whether `vis sbom` can pass the binary's native gate (`answer` and `context` in `sbom/mod.rs`): the JSON BOM at the
// workspace root, in a CI context off a terminal, written to a file (where pail's layout has to be decidable) or to stdout.
// Like `secrets`, it stays in Node on Windows, when the working directory is not the workspace root, and where `NODE_ENV`,
// `DEBUG`, `PAIL_LOG_LEVEL` or `CEREBRO_*` output settings could change the log lines. The binary re-checks everything,
// including the lockfile, the config and the other ecosystems' files; this only skips the extra process when it would delegate anyway.
const sbomMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
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

    const output = sbomOutput(args.slice(1));

    return output !== undefined && (output === "-" || pailOutputIsDecidable(environment, args));
};

// Whether `vis graph` can pass the binary's native gate (`parse` in `graph_view.rs`): the ASCII, DOT and JSON
// graph, with `--format`/`-f` and `--depth`/`-d` at most once each, in a CI context off a terminal with no output setting
// (`NODE_ENV`, `DEBUG`, `PAIL_LOG_LEVEL`, `CEREBRO_*`) that changes what the logger prints. `html`, `--output`
// and every other flag stay in Node. The binary re-checks everything, so this only skips the extra process when it
// would delegate anyway. A workspace with a `vis.config` takes the same gate: the launcher does not look at the config, because the
// binary reads a literal one itself (`config_workspace.rs`), answers the keys it has shown cannot change the projects or their edges
// (`projectIgnore` is applied), and hands every other config, and a run from a project directory, to Node.
const GRAPH_FORMATS = new Set(["ascii", "dot", "json", "tui"]);
const GRAPH_DEPTH = /^\d+$/;
const GRAPH_FLAGS = new Map([
    ["--depth", "depth"],
    ["--format", "format"],
    ["-d", "depth"],
    ["-f", "format"],
]);

// The `[kind, value, next index]` of the graph option at `args[index]`, with its value after a space or an `=` (the
// short names take a space only), or `undefined` when it is no graph option.
const graphOption = (args, index) => {
    const argument = args[index];
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const kind = GRAPH_FLAGS.get(equals === -1 ? argument : argument.slice(0, equals));

    if (kind === undefined) {
        return undefined;
    }

    return equals === -1 ? [kind, args[index + 1], index + 2] : [kind, argument.slice(equals + 1), index + 1];
};

const graphMayRunNatively = (platform, environment, args, interactive) => {
    if (interactive || !inCi(environment) || nodeWarnsAboutColour(environment) || !outputSettingsAreDefault(environment)) {
        return false;
    }

    const seen = new Set();
    let index = 1;

    while (index < args.length) {
        const option = graphOption(args, index);

        if (option === undefined) {
            return false;
        }

        const [kind, value, next] = option;

        if (seen.has(kind) || !(kind === "format" ? GRAPH_FORMATS.has(value) : GRAPH_DEPTH.test(value))) {
            return false;
        }

        seen.add(kind);
        index = next;
    }

    return true;
};

// The flags `vis optimize` takes natively (`parse` in `optimize/mod.rs`): the boolean ones and `--format table|json`, each at
// most once (`-d` is `--dry-run`).
const OPTIMIZE_BOOLEAN_FLAGS = [["--dry-run", "-d"], ["--pin"], ["--prod"], ["--no-install"]];

// The flag at `flags[index]`: its name and the index after it (and its value), or `undefined` when the binary does not take it.
const optimizeFlagAt = (flags, index) => {
    const booleanFlag = OPTIMIZE_BOOLEAN_FLAGS.find((names) => names.includes(flags[index]));

    if (booleanFlag !== undefined) {
        return [booleanFlag[0], index + 1];
    }

    const given = optionValue(flags, index, "--format");

    return Array.isArray(given) && ["json", "table"].includes(given[0]) ? ["--format", given[1]] : undefined;
};

const optimizeShapeIsNative = (flags) => {
    const seen = new Set();
    let index = 0;

    while (index < flags.length) {
        const flag = optimizeFlagAt(flags, index);

        if (flag === undefined || seen.has(flag[0])) {
            return false;
        }

        seen.add(flag[0]);
        [, index] = flag;
    }

    return true;
};

// Whether `vis optimize` can pass the binary's native gate (`parse` and `context` in `optimize/mod.rs`): the report without a
// terminal, for a pnpm workspace whose root is the working directory, in a CI context with no `vis.config`, and none of the
// variables that change what pail prints. The binary re-checks everything, including the workspace patterns, the manifests and
// the package manager; this only skips the extra process when it would delegate anyway. It stays in Node on Windows.
const optimizeMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || !pailOutputIsDecidable(environment, args)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && optimizeShapeIsNative(args.slice(1));
};

// Whether `vis security list` can pass the binary's native gate (`args_are_native` and `context` in `security_list/mod.rs`):
// `--json` and nothing else, for a pnpm workspace whose root is the working directory, in a CI context. The command prints no
// pail line in this form, so the colour and width of pail do not matter, but the Node runtime's own colour warning does. The
// binary re-checks everything, including the config, the package manager and every manifest under `node_modules`.
const securityListMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && args.length === 3 && args[2] === "--json";
};

// Whether `vis security sync` can pass the binary's native gate (`parse` and `answer` in `security_sync/mod.rs`): the two skip
// flags, each at most once and in either order, for a pnpm workspace whose root is the working directory, in a CI context off a
// terminal with a pail layout the environment decides. The command rewrites `pnpm-workspace.yaml` and `package.json` and prints pail
// lines. The binary re-checks everything, including the config, the files and whether each line fits one line of the layout (a run
// it cannot reproduce goes to Node before anything is printed or written); this only skips the extra process when it would
// delegate anyway. It stays in Node on Windows.
const SECURITY_SYNC_FLAGS = new Set(["--skip-allow-builds", "--skip-min-release-age"]);

const securitySyncArgsAreNative = (args) => {
    const flags = args.slice(2);

    return flags.every((flag) => SECURITY_SYNC_FLAGS.has(flag)) && new Set(flags).size === flags.length;
};

const securitySyncMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || !pailOutputIsDecidable(environment, args)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && securitySyncArgsAreNative(args);
};

// Whether `vis init` can pass the binary's native gate (`parse` and `answer` in `init.rs`): the flags that ask nothing, each spelled
// exactly and given once, in a CI context off a terminal at the root of a pnpm workspace. The binary also hands the run to Node when
// stdin is a terminal (Node then asks its questions), which the launcher does not see, and re-checks everything else (the package
// manager, an existing config, the files it would merge into); this only skips the extra process when it would delegate anyway.
// `--yes` is not an `init` option, `--interactive` and any other editor than `vscode` stay in Node. Windows stays in Node.
const INIT_FLAGS = new Set(["--agent", "--force", "--no-interactive", "--schema", "--sync-native"]);

const initArgsAreNative = (args) => {
    const flags = args.slice(1);
    const seen = new Set();

    for (let index = 0; index < flags.length; index += 1) {
        let flag = flags[index];

        if (flag === "--editor" && flags[index + 1] === "vscode") {
            index += 1;
        } else if (flag !== "--editor=vscode" && !INIT_FLAGS.has(flag)) {
            return false;
        }

        flag = flag.startsWith("--editor") ? "--editor" : flag;

        if (seen.has(flag)) {
            return false;
        }

        seen.add(flag);
    }

    return true;
};

const initMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || !pailOutputIsDecidable(environment, args)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && initArgsAreNative(args);
};

// Whether `vis security verify-lockfile` can pass the binary's native gate (`parse` and `answer` in `security_verify_lockfile.rs`):
// `--offline`, alone or with `--json` in either order, for a pnpm workspace whose root is the working directory, in a CI context off a
// terminal. The text form also needs a pail layout the environment decides; the JSON form prints no pail line, but the Node runtime's
// own colour warning still matters. Without `--offline` the policies ask the registry, and a lockfile that fails is listed by Node. The
// binary re-checks everything, including the config and the lockfile; this only skips the extra process when it would delegate anyway.
const securityVerifyLockfileMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
        return false;
    }

    const flags = args.slice(2);
    const offlineOnly = flags.length === 1 && flags[0] === "--offline";
    const offlineJson = flags.length === 2 && flags.includes("--offline") && flags.includes("--json");

    return outputSettingsAreDefault(environment) && (offlineJson || (offlineOnly && pailOutputIsDecidable(environment, args)));
};

// Whether `vis security keys-refresh` can pass the binary's native gate (`parse` and `answer` in `keys_refresh.rs`): `--json`,
// alone or with `--clear` in either order, for a pnpm workspace whose root is the working directory, in a CI context off a
// terminal, with no proxy, CA or Node option in the environment. The command prints no pail line in this form, so the colour
// and width of pail do not matter, but the Node runtime's own colour warning does. The binary re-checks everything, including
// the key URL, the cache file and the answer (a run it cannot reproduce goes to Node before anything is printed or written).
const keysRefreshArgsAreNative = (args) => {
    const flags = args.slice(2);

    return (flags.length === 1 && flags[0] === "--json") || (flags.length === 2 && flags.includes("--json") && flags.includes("--clear"));
};

// The flags of `vis attest` (`parse` in `attest/mod.rs`): `--name value` or `--name=value` for the values, `--name` for the
// switches, each at most once, and plain words. A value that is empty or starts with a dash, any other flag and `--` are not.
const attestFlag = (shape, rest, index, values, switches) => {
    const [name, ...inline] = rest[index].slice(2).split("=");

    if (switches.includes(name)) {
        if (inline.length > 0 || shape.switches.has(name)) {
            return undefined;
        }

        shape.switches.add(name);

        return index + 1;
    }

    const value = inline.length > 0 ? inline.join("=") : rest[index + 1];

    if (!values.includes(name) || shape.values.has(name) || value === undefined || value === "" || value.startsWith("-")) {
        return undefined;
    }

    shape.values.set(name, value);

    return inline.length > 0 ? index + 1 : index + 2;
};

const attestShape = (rest, values, switches) => {
    const shape = { switches: new Set(), values: new Map(), words: [] };
    let index = 0;

    while (index < rest.length) {
        const token = rest[index];

        if (!token.startsWith("-")) {
            shape.words.push(token);
            index += 1;

            continue;
        }

        index = token.startsWith("--") ? attestFlag(shape, rest, index, values, switches) : undefined;

        if (index === undefined) {
            return undefined;
        }
    }

    return shape;
};

const ATTEST_FORMATS = ["json", "ndjson", "table"];

// Whether `vis attest <subject>` can pass the binary's native gate (`answer` in `attest/emit.rs`): the run that has no ambient OIDC
// token, so Node hashes the artifact and skips signing. A run that signs, `--require-signing` and the failures stay in Node. The
// binary re-checks everything, including the subject and the workspace.
const attestEmitShapeIsNative = (environment, rest) => {
    const shape = attestShape(rest, ["format", "output", "predicate"], ["require-signing"]);

    return shape !== undefined
        && shape.words.length === 1
        && shape.words[0] !== "verify"
        && !shape.switches.has("require-signing")
        && ["slsaProvenance", undefined].includes(shape.values.get("predicate"))
        && [undefined, ...ATTEST_FORMATS].includes(shape.values.get("format"))
        && environment.CI !== "true"
        && environment.ACTIONS_ID_TOKEN_REQUEST_URL === undefined
        && environment.SIGSTORE_ID_TOKEN === undefined;
};

// `vis attest <subject>`, in a CI context off a terminal at the root of a pnpm workspace, with no proxy, CA or Node option in
// the environment. `vis attest verify` is not here: attestation verification has one implementation, the Node one.
const attestMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || !pailOutputIsDecidable(environment, args)) {
        return false;
    }

    if (!outputSettingsAreDefault(environment) || !networkEnvironmentIsPlain(environment)) {
        return false;
    }

    return attestEmitShapeIsNative(environment, args.slice(1));
};

const keysRefreshMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && networkEnvironmentIsPlain(environment) && keysRefreshArgsAreNative(args);
};

// Whether `vis inspect` can pass the binary's native gate (`parse` in `inspect/args.rs`, `answer` in `inspect/mod.rs`): one package
// in the plain shape of a registry name and spec, `--json`, and `--strict` and `--only <list>` at most once, for a pnpm workspace
// whose root is the working directory, in a CI context off a terminal, with no proxy, CA or Node option in the environment.
// Every marshall is the binary's (`author`, `provenance`, `s1ngularity`, `newBin` and `metadata` read the packument, `downloads` asks the
// registry's download API, `archivedRepo` asks GitHub, `signatures` verifies the registry's signatures and `expiredDomains` asks a DNS
// resolver), so which ones a run executes (`--only`, or all but `signatures`, less the ones `MARSHALL_DISABLE_*` turns off) is for the
// binary to read. It re-checks everything, including the registry and the packument, and hands to Node a run it cannot reproduce.
const INSPECT_MARSHALLS = new Set(["archivedRepo", "author", "downloads", "expiredDomains", "metadata", "newBin", "provenance", "s1ngularity", "signatures"]);
const INSPECT_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const INSPECT_SPEC = /^[\w.+-]*$/;
const INSPECT_ONLY = /^[\da-z,]+$/i;

const inspectPackageIsNative = (token) => {
    const separator = token.indexOf("@", 1);
    const name = separator === -1 ? token : token.slice(0, separator);
    const spec = separator === -1 ? "" : token.slice(separator + 1);

    return INSPECT_NAME.test(name) && INSPECT_SPEC.test(spec);
};

const inspectOnlyIsNative = (value) => value !== undefined && INSPECT_ONLY.test(value) && value.split(",").every((entry) => INSPECT_MARSHALLS.has(entry));

// `--only <list>` once and valid, or not at all; the arguments without it.
const inspectWithoutOnly = (rest) => {
    const only = rest.indexOf("--only");

    if (only === -1) {
        return { others: rest };
    }

    if (!inspectOnlyIsNative(rest[only + 1]) || rest.includes("--only", only + 1)) {
        return undefined;
    }

    return { list: rest[only + 1].split(","), others: [...rest.slice(0, only), ...rest.slice(only + 2)] };
};

const inspectFlagsAreNative = (others) => {
    const flags = others.filter((token) => token.startsWith("-"));
    const packages = others.filter((token) => !token.startsWith("-"));

    return packages.length === 1 && inspectPackageIsNative(packages[0]) && flags.includes("--json") && new Set(flags).size === flags.length && flags.every((flag) => flag === "--json" || flag === "--strict");
};

const inspectArgsAreNative = (args) => {
    const parsed = inspectWithoutOnly(args.slice(1));

    return parsed !== undefined && inspectFlagsAreNative(parsed.others);
};

const inspectMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && networkEnvironmentIsPlain(environment) && inspectArgsAreNative(args);
};

// The flags `vis audit` takes natively (`parse` in `native/cli/src/audit/mod.rs`): `--format json` and `--policies none` (the
// default config runs the `publisherChange` policy, which asks the registry) and, at most once each, `--severity` and
// `--fail-on` with one of the four levels, and `--exit-code`; with no finding they change nothing.
const AUDIT_LEVELS = new Set(["critical", "high", "low", "medium"]);

const AUDIT_VALUES = new Map([
    ["--fail-on", (value) => AUDIT_LEVELS.has(value)],
    ["--format", (value) => value === "json"],
    ["--policies", (value) => value === "none"],
    ["--severity", (value) => AUDIT_LEVELS.has(value)],
]);

// The flag at `flags[index]` as its name and the index after it (and its value), or `undefined` when the binary does not take it.
const auditFlagAt = (flags, index) => {
    const argument = flags[index];
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = equals === -1 ? argument : argument.slice(0, equals);

    if (name === "--exit-code") {
        return equals === -1 ? { name, next: index + 1 } : undefined;
    }

    const value = equals === -1 ? flags[index + 1] : argument.slice(equals + 1);
    const accepted = AUDIT_VALUES.get(name)?.(value) ?? false;

    return accepted ? { name, next: index + (equals === -1 ? 2 : 1) } : undefined;
};

const auditArgsAreNative = (flags) => {
    const seen = new Set();
    let index = 0;

    while (index < flags.length) {
        const flag = auditFlagAt(flags, index);

        if (flag === undefined || seen.has(flag.name)) {
            return false;
        }

        seen.add(flag.name);
        index = flag.next;
    }

    return seen.has("--format") && seen.has("--policies");
};

// Whether `vis audit` can pass the binary's native gate (`parse` and `answer` in `audit/mod.rs`): `--format json --policies none` for a pnpm
// workspace whose root is the working directory, in a CI context off a terminal, with no proxy, CA or Node option in the
// environment. The binary answers only a scan that finds nothing and hands everything else to Node before it prints (the
// OSV answer, the lockfile, the config and `pnpm-workspace.yaml` are its to check). The Node runtime's own colour warning
// is Node's.
const auditMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && networkEnvironmentIsPlain(environment) && auditArgsAreNative(args.slice(1));
};

// Whether `vis task-why` can pass the binary's native gate (`parse` and `answer` in `task_why.rs`): one id of the shape
// `<project>:<target>` with exactly one colon (the handler splits at the colon with a limit of two, which truncates a
// longer id), in printable ASCII and not starting with `-`, for a pnpm workspace whose root is the working directory, in a
// CI context off a terminal. The output is the same in every colour environment, but the Node runtime's own colour warning
// is not. The binary re-checks everything, including the config, the project and its target (an error prints a stack
// trace, which stays in Node); this only skips the extra process when it would delegate anyway. The text holds no path and no colour, so Windows answers it too.
// A workspace with a literal `vis.config` `tasks` block takes the same gate: the launcher does not look at the config, because the
// binary builds the configured graph from it and delegates every shape it cannot reproduce (a refused key, a `project.json` or
// overlay, an inference marker, a name it cannot print), and it does that on unix only, so on Windows a config always reaches Node.
const TASK_WHY_ID = /^[\u0021-\u007E]+$/;

const taskWhyIdIsNative = (id) => {
    if (id === undefined || id.startsWith("-") || !TASK_WHY_ID.test(id)) {
        return false;
    }

    const parts = id.split(":");

    return parts.length === 2 && parts.every((part) => part !== "");
};

const taskWhyMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && args.length === 2 && taskWhyIdIsNative(args[1]);
};

// Whether `vis hook list`, `validate`, `install` and `uninstall` can pass the binary's native gate (`parse` and `answer` in `hook/{list,validate,install,uninstall}.rs`): the
// plain command, or one `--hooks-dir` that is a relative path of plain segments the argument parser keeps as a string (`install --force` is Node's), at the root of a pnpm
// workspace in a CI context off a terminal. The binary re-checks everything, including the files of the hooks directory and the repository, so this
// only skips the extra process when it would delegate anyway. Only `hook list` answers on Windows.
const HOOKS_DIRECTORY_START = /^(?:[A-Z_]|\.[A-Z_])/i;
const HOOKS_DIRECTORY_SEGMENT = /^[\w.-]+$/;
const HOOKS_DIRECTORY_RESERVED = new Set(["false", "infinity", "nan", "null", "true", "undefined"]);

const hooksDirectoryIsNative = (value) => {
    if (value === undefined || !HOOKS_DIRECTORY_START.test(value) || HOOKS_DIRECTORY_RESERVED.has(value.toLowerCase())) {
        return false;
    }

    return value.split("/").every((segment) => HOOKS_DIRECTORY_SEGMENT.test(segment) && segment !== "." && segment !== "..");
};

const hookShapeIsNative = (args) => {
    if (args.length === 2) {
        return true;
    }

    if (args.length === 4) {
        return args[2] === "--hooks-dir" && hooksDirectoryIsNative(args[3]);
    }

    return args.length === 3 && args[2].startsWith("--hooks-dir=") && hooksDirectoryIsNative(args[2].slice("--hooks-dir=".length));
};

const hookMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    // `hook validate` runs `sh -n` and reads file modes, which the binary only does on unix.
    if ((platform === "win32" && args[1] !== "list") || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && hookShapeIsNative(args);
};

// Whether `vis shim status` can pass the binary's native gate (`answer` in `shim_status.rs`): exactly `shim status`, at the root of a pnpm
// workspace in a CI context off a terminal. The binary re-checks everything, so this only skips the extra process when it would delegate anyway.
// `shim install` and `shim uninstall` write files and stay in Node. Windows stays in Node.
const shimStatusMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (platform === "win32" || interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
        return false;
    }

    return outputSettingsAreDefault(environment) && args.length === 2;
};

// The lint selectors of `vis deps`, `--quiet` and `--format`: the flags `deps::parse` (`native/cli/src/deps/mod.rs`) answers, each at most once.
const DEPS_SELECTORS = new Set([
    "--banned-deps",
    "--custom-types",
    "--dead-workspace-patterns",
    "--empty-deps",
    "--missing-package-json",
    "--redefine-root",
    "--root-deps",
    "--root-package-manager",
    "--root-private",
    "--similar-deps",
    "--types-in-deps",
    "--workspace-protocol",
    "--workspace-versions",
]);

const DEPS_FORMATS = new Set(["human", "json", "minimal"]);

// The `--format` option at `flags[index]`: the format it names and where the flags continue, or `undefined` when it is another argument, or `false` when it is not one the binary answers.
const depsFormat = (flags, index) => {
    const flag = flags[index];

    if (flag === "--format") {
        return DEPS_FORMATS.has(flags[index + 1]) ? [flags[index + 1], index + 2] : false;
    }

    if (flag.startsWith("--format=")) {
        return DEPS_FORMATS.has(flag.slice("--format=".length)) ? [flag.slice("--format=".length), index + 1] : false;
    }

    return undefined;
};

// The shape of the arguments after `deps`: `{ format, quiet }`, or `undefined` when the binary would delegate them.
const depsShape = (flags) => {
    const seen = new Set();
    let format;
    let index = 0;

    while (index < flags.length) {
        const given = depsFormat(flags, index);

        if (given === false || (given !== undefined && format !== undefined)) {
            return undefined;
        }

        if (given === undefined && ((!DEPS_SELECTORS.has(flags[index]) && flags[index] !== "--quiet") || seen.has(flags[index]))) {
            return undefined;
        }

        if (given === undefined) {
            seen.add(flags[index]);
            index += 1;
        } else {
            [format, index] = given;
        }
    }

    // Node warns on stderr that there is no `policy.bannedDeps` to check.
    return seen.has("--banned-deps") && !seen.has("--quiet") ? undefined : { format: format ?? "human", quiet: seen.has("--quiet") };
};

// Whether `vis deps` can pass the binary's native gate (`parse` and `answer` in `deps/mod.rs`): the lint selectors, `--quiet` and `--format`,
// at the root of a pnpm workspace in a CI context off a terminal, with a colour the binary can tell when it prints the human format. The binary
// re-checks everything, including the manifests and any drift between packages, so this only skips the extra process when it would delegate
// anyway. `--fix` and every flag that takes a policy stay in Node.
const depsMayRunNatively = (platform, environment, args, cwd, interactive, holdsMarker) => {
    if (interactive || !inCi(environment) || !cwdIsRoot(environment, cwd, holdsMarker) || nodeWarnsAboutColour(environment)) {
        return false;
    }

    const shape = depsShape(args.slice(1));

    if (shape === undefined || !outputSettingsAreDefault(environment)) {
        return false;
    }

    return shape.format !== "human" || shape.quiet || colourIsDecidable(environment, args);
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
// so routing them through the binary would only add a second Node boot; `hook list` has its own gate) and `advisories bloom status`.
// The binary answers that one natively only for `--format json --cache-dir <dir>` and hands every other
// shape to Node, as it does for `hook run`; the launcher does not check those flags.
// The ones that print no logger output of their own still trace under `DEBUG` and `CEREBRO_*` in Node, so a run with either
// goes to Node (`--help` is the binary's whatever the environment is); `x` runs a file through a lean entry that traces nothing.
const TRACED_NATIVE_COMMANDS = new Set(["dedupe", "exec", "link", "outdated", "pm", "remove", "unlink", "why"]);

const alwaysNative = (command, subcommand, args, environment) => {
    const traced
        = TRACED_NATIVE_COMMANDS.has(command) || (command === "hook" && subcommand === "run") || (command === "advisories" && subcommand === "bloom" && args[2] === "status");

    return traced ? asksForHelp(args) || debugOutputIsDefault(environment) : NATIVE_COMMANDS.has(command);
};

// The commands with a native shape, by the name they are typed with, each with the gate that decides it. A gate
// answers `undefined` for a subcommand that is not one of them; the binary re-checks everything, so a gate only
// skips the extra process when the binary would delegate anyway, and any other run is delegated by the binary,
// which costs a second Node boot. The notes name the binary's module for each command.
const NATIVE_SHAPE_GATES = new Map([
    ["add", ({ args, environment, interactive, platform }) => helpOrNative(args, () => addMayRunNatively(platform, environment, args, interactive))],
    // `affected <target> --sparse-checkout`.
    ["affected", ({ args, environment, interactive, platform }) => helpOrNative(args, () => affectedMayRunNatively(platform, environment, args, interactive))],
    // `attest <subject>` for a run with no OIDC token (Node skips signing); `attest verify` stays in Node.
    ["attest", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => attestMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    // `audit --format json`, answered only when the scan finds nothing.
    ["audit", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => auditMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    // `cache list`, `cache size` (`cache.rs`), `cache clean` (`cache_clean.rs`), `cache prune` (`cache_prune.rs`), `cache hash` (`cache_hash.rs`) and `cache why` (`cache_why.rs`); the binary hands every other shape to Node itself.
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
    // The dependency-policy lints: the selectors, `--quiet` and `--format`.
    ["deps", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => depsMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    ["dlx", ({ args, environment, platform }) => helpOrNative(args, () => dlxMayRunNatively(platform, environment, args))],
    // The ASCII, DOT and JSON graph; `html`, `--output` and the interactive viewer stay in Node.
    ["graph", ({ args, environment, interactive, platform }) => helpOrNative(args, () => graphMayRunNatively(platform, environment, args, interactive))],
    // `hook list`, `hook validate` (which the binary answers only when it has nothing to report), `hook install` and `hook uninstall` (one checkout, nothing else
    // claiming the hooks; the binary hands the rest to Node before it writes anything); `hook run` is native for every shape (`alwaysNative`) and the other `hook`
    // subcommands are Node's.
    [
        "hook",
        ({ args, cwd, environment, holdsMarker, interactive, platform, subcommand }) => {
            if (subcommand !== "list" && subcommand !== "validate" && subcommand !== "install" && subcommand !== "uninstall") {
                return undefined;
            }

            return helpOrNative(args, () => hookMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker));
        },
    ],
    ["i", ({ args, environment, interactive, platform }) => helpOrNative(args, () => installMayRunNatively(platform, environment, args, interactive))],
    ["ignore", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => ignoreMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    // The self-uninstall: `--yes`, or nothing to remove.
    ["implode", ({ args, environment, interactive, platform }) => helpOrNative(args, () => implodeMayRunNatively(platform, environment, args, interactive))],
    // The registry view, typed `info` or `view`.
    ["info", ({ args, environment, interactive, platform }) => helpOrNative(args, () => infoMayRunNatively(platform, environment, args, interactive))],
    // `init`'s flags that ask nothing (`--force`, `--agent`, `--editor vscode`, `--sync-native`, `--schema`, `--no-interactive`): the binary writes the config and hands every other shape to Node.
    ["init", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => initMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    // The JSON report of the marshalls `--only` names, or the default set less the ones `MARSHALL_DISABLE_*` turns off.
    ["inspect", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => inspectMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    ["install", ({ args, environment, interactive, platform }) => helpOrNative(args, () => installMayRunNatively(platform, environment, args, interactive))],
    ["list", ({ args, environment, interactive, platform }) => helpOrNative(args, () => listMayRunNatively(platform, environment, args, interactive))],
    // The report without a terminal (`--dry-run`, `--format`, `--pin`, `--prod`); a terminal is the interactive picker, which stays in Node.
    ["optimize", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => optimizeMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    // A recorded run, a task of it, or the list of runs.
    ["replay", ({ args, environment, interactive, platform }) => helpOrNative(args, () => replayMayRunNatively(platform, environment, args, interactive))],
    // `run <target>`, answered only when every task is a cache hit; the binary hands every other run to Node.
    ["run", ({ args, cacheMayExist, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => runMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker, cacheMayExist))],
    // The JSON BOM of a pnpm workspace: `--format json`, `--output`, `--focus`, `--include-dev`.
    ["sbom", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => sbomMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    // The plain working-tree scan.
    ["secrets", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => secretsMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    // `security list --json`, `security keys-refresh --json`, `security sync` and the passing `security verify-lockfile --offline`; the other `security` subcommands use the network or run scripts, and follow the help rule below.
    [
        "security",
        ({ args, cwd, environment, holdsMarker, interactive, platform, subcommand }) => {
            if (subcommand === "list") {
                return helpOrNative(args, () => securityListMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker));
            }

            if (subcommand === "keys-refresh") {
                return helpOrNative(args, () => keysRefreshMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker));
            }

            if (subcommand === "sync") {
                return helpOrNative(args, () => securitySyncMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker));
            }

            if (subcommand === "verify-lockfile") {
                return helpOrNative(args, () => securityVerifyLockfileMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker));
            }

            return undefined;
        },
    ],
    // `--check` and the up-to-date verdicts; an install is handed to Node before anything is printed.
    ["self-update", ({ args, environment, interactive, platform }) => helpOrNative(args, () => selfUpdateMayRunNatively(platform, environment, args, interactive))],
    // `shim status`; the other `shim` subcommands install and remove files and are Node's.
    [
        "shim",
        ({ args, cwd, environment, holdsMarker, interactive, platform, subcommand }) => {
            if (subcommand !== "status") {
                return undefined;
            }

            return helpOrNative(args, () => shimStatusMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker));
        },
    ],
    // Every flag, for a pnpm workspace in CI; the binary hands every file or setting it cannot reproduce to Node.
    ["sort-package-json", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => sortPackageJsonMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    // The generator and its `--check`; the other `sync` kinds are Node's and follow the help rule below.
    // The overview and its `--json`; a Node pin the binary cannot check (no `node` on PATH) or run summaries of an unexpected shape stay in Node.
    ["status", ({ args, environment, interactive, platform }) => helpOrNative(args, () => statusMayRunNatively(platform, environment, args, interactive))],
    [
        "sync",
        ({ args, cwd, environment, holdsMarker, interactive, platform, subcommand }) => {
            if (subcommand !== "ci-workflow") {
                return undefined;
            }

            return helpOrNative(args, () => syncCiWorkflowMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker));
        },
    ],
    // A task of a script-only workspace, answered when it exists; every error stays in Node.
    ["task-why", ({ args, cwd, environment, holdsMarker, interactive, platform }) => helpOrNative(args, () => taskWhyMayRunNatively(platform, environment, args, cwd, interactive, holdsMarker))],
    ["view", ({ args, environment, interactive, platform }) => helpOrNative(args, () => infoMayRunNatively(platform, environment, args, interactive))],
]);

// The routing of a bare command group and of `complete`: `true` or `false` when they decide,
// `undefined` when the command is neither.
const routesListingOrCompletionToNative = (args, command, subcommand) => {
    // A bare command group lists its subcommands, which the binary answers like `<group> --help` (any
    // other shape is Node's, which prints the same listing). The binary enables virtual-terminal
    // processing, so Windows answers it natively too.
    if (GROUP_LISTINGS.includes(command) && args.length === 1) {
        return true;
    }

    // `complete --` is the dynamic endpoint the generated completion scripts call on
    // every <TAB>; any other `complete` shape is not a native command, so it stays
    // in-process (script generation is `vis completion --shell=<shell>`, Node's too).
    if (command === "complete") {
        return subcommand === "--";
    }

    return undefined;
};

// The routing of the commands that have their own native shapes: `true` or `false` when the
// command decides, `undefined` when it is left to the help-surface rule in `routesToNative`.
const routesCommandToNative = (args, platform, environment, cwd, interactive, holdsMarker = holdsRootMarker, cacheMayExist = taskCacheMayExist) => {
    const [command = "", subcommand] = args;

    if (alwaysNative(command, subcommand, args, environment)) {
        return true;
    }

    const gated = NATIVE_SHAPE_GATES.get(command)?.({ args, cacheMayExist, cwd, environment, holdsMarker, interactive, platform, subcommand });

    if (gated !== undefined) {
        return gated;
    }

    return routesListingOrCompletionToNative(args, command, subcommand);
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
    cacheMayExist = taskCacheMayExist,
) => {
    const decided = routesCommandToNative(args, platform, environment, cwd, interactive, holdsMarker, cacheMayExist);

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
