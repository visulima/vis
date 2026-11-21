const VALUELESS_GLOBAL_FLAGS = new Set<string>(["--color", "--debug", "--no-color", "--quiet", "--verbose", "-q", "-v"]);
const HELP_FLAGS = new Set<string>(["--help", "-h"]);

/**
 * `cache` is a command group with no command of its own, so cerebro finds nothing to run for
 * `vis cache`, `vis cache --help` and `vis cache -h` and exits 1 without printing anything.
 * `cli-main` answers those three with the output of `vis help cache` instead, and the native
 * binary does the same (`GROUP_LISTINGS` in `native/cli/src/surface.rs`).
 *
 * Returns the exit code for such an invocation: 0 when help was asked for, 1 for the bare group.
 * Returns `undefined` for anything else; only valueless global flags may accompany the group.
 */
export const cacheGroupHelpExitCode = (argv: ReadonlyArray<string>): 0 | 1 | undefined => {
    const start = argv.findIndex((argument) => !VALUELESS_GLOBAL_FLAGS.has(argument));

    if (argv[start] !== "cache") {
        return undefined;
    }

    const flags = argv.slice(start + 1);

    if (!flags.every((flag) => HELP_FLAGS.has(flag) || VALUELESS_GLOBAL_FLAGS.has(flag))) {
        return undefined;
    }

    return flags.some((flag) => HELP_FLAGS.has(flag)) ? 0 : 1;
};

/** The arguments that make `vis help cache` out of a group invocation: its global flags carry over. */
export const cacheGroupHelpArguments = (argv: ReadonlyArray<string>): string[] => [
    "help",
    "cache",
    ...argv.filter((argument) => argument !== "cache" && !HELP_FLAGS.has(argument)),
];
