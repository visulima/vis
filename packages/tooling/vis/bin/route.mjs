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

// Whether the binary should get this invocation: `args` is `process.argv.slice(2)`.
const routesToNative = (args, platform = process.platform) => {
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
