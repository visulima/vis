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

// Whether `vis ignore` can pass the binary's native gate (`native_context` in `ignore.rs`). The
// binary re-checks everything; this only skips the extra process when it would delegate anyway.
const ignoreMayRunNatively = (platform, environment, cwd, interactive) => {
    if (platform === "win32" || interactive) {
        return false;
    }

    const inCi = ["CI", "CONTINUOUS_INTEGRATION"].some((key) => environment[key] !== undefined && environment[key] !== "0" && environment[key] !== "false");

    if (!inCi) {
        return false;
    }

    const root = environment["VIS_MONOREPO_ROOT"];

    if (!root || root !== cwd) {
        return false;
    }

    if (IGNORE_COLOUR_ENVIRONMENT.some((key) => environment[key] !== undefined)) {
        return false;
    }

    const term = environment["TERM"]?.toLowerCase();

    return term === undefined || term.includes("dumb") || term.includes("mono");
};

// Whether the binary should get this invocation: `args` is `process.argv.slice(2)`. The other
// parameters default to the running process; tests pass their own.
const routesToNative = (
    args,
    platform = process.platform,
    environment = process.env,
    cwd = process.cwd(),
    interactive = Boolean(process.stdout.isTTY || process.stderr.isTTY),
) => {
// Whether the binary should get this invocation: `args` is `process.argv.slice(2)`.
const routesToNative = (args, platform = process.platform, stdoutIsTTY = process.stdout.isTTY === true) => {
    const [command = "", subcommand] = args;

    if (NATIVE_COMMANDS.has(command)) {
        return true;
    }

    // `hook run` is native, but the other `hook` subcommands (install, migrate, …)
    // are not: sending those through the binary would only add a second Node boot.
    // On Windows, `hook run --help` stays in Node, which keeps the help surface there.
    if (command === "hook" && subcommand === "run") {
        return platform !== "win32" || !asksForHelp(args);
    }

    // `advisories bloom status` is answered natively for `--format json --cache-dir <dir>`.
    // The binary hands every other shape of it to Node itself, as it does for `hook run`.
    if (command === "advisories" && subcommand === "bloom" && args[2] === "status") {
        return platform !== "win32" || !asksForHelp(args);
    }

    // `ignore` is native for its plain shapes in a CI context (`native/cli/src/ignore.rs`); any
    // other run would be delegated by the binary, which costs a second Node boot. Help is
    // answered by the binary everywhere but Windows, as for `advisories bloom status`.
    if (command === "ignore") {
        if (asksForHelp(args)) {
            return platform !== "win32";
        }

        return ignoreMayRunNatively(platform, environment, cwd, interactive);
    // `clean` (no flags, `--dry-run`, `--lockfile`) is answered natively; the binary hands every
    // other shape to Node itself. Help stays in Node on Windows, as for `advisories`. A terminal
    // stdout stays in Node too: pail colours its output there, and the binary does not.
    if (command === "clean") {
        return !stdoutIsTTY && (platform !== "win32" || !asksForHelp(args));
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

    // Windows keeps the help surface in Node: the binary paints it with raw ANSI codes
    // and does not enable virtual-terminal processing, which classic conhost needs.
    if (platform === "win32") {
        return false;
    }

    // The binary also renders the help surface from its generated manifest: bare
    // `vis`, `help …`, and `--help` / `-h` anywhere before a `--` separator. It
    // delegates whatever it cannot answer to `dist/bin.js` itself (never back through
    // the launcher), so these are safe to hand over.
    return args.length === 0 || command === "help" || asksForHelp(args);
};

// eslint-disable-next-line import/prefer-default-export -- named like `resolve-binary.mjs`; more routing helpers will join it
export { routesToNative };
