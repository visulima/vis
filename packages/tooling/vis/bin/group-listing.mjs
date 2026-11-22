// Command groups that have no command of their own (`cache`): the parser finds nothing to run for
// `vis <group>`, `vis <group> --help` and `vis <group> -h`, so the Node CLI answers them with the
// output of `vis help <group>`. The native binary does the same (`GROUP_LISTINGS` in
// `native/cli/src/surface.rs`, which has to list the same groups) and the launcher
// (`bin/route.mjs`) hands the bare group to it. Free of side effects, like `route.mjs`.

const GROUP_LISTINGS = ["cache"];

const VALUELESS_GLOBAL_FLAGS = new Set(["--color", "--debug", "--no-color", "--quiet", "--verbose", "-q", "-v"]);
const HELP_FLAGS = new Set(["--help", "-h"]);

/**
 * The invocation `vis help <group>` that stands in for a group invocation, with the exit code to
 * finish with: 0 when help was asked for, 1 for the bare group, which is a usage error.
 *
 * Returns `undefined` for anything else; only valueless global flags may accompany the group.
 * @param {ReadonlyArray<string>} argv the arguments after `vis`
 * @returns {{ argv: string[]; exitCode: 0 | 1 } | undefined} the stand-in invocation and exit code
 */
const groupListing = (argv) => {
    const start = argv.findIndex((argument) => !VALUELESS_GLOBAL_FLAGS.has(argument));
    const group = argv[start];

    if (group === undefined || !GROUP_LISTINGS.includes(group)) {
        return undefined;
    }

    const flags = argv.slice(start + 1);

    if (!flags.every((flag) => HELP_FLAGS.has(flag) || VALUELESS_GLOBAL_FLAGS.has(flag))) {
        return undefined;
    }

    // The global flags carry over to the help invocation, in their order.
    const carried = argv.filter((argument) => argument !== group && !HELP_FLAGS.has(argument));

    return { argv: ["help", group, ...carried], exitCode: flags.some((flag) => HELP_FLAGS.has(flag)) ? 0 : 1 };
};

export { GROUP_LISTINGS, groupListing };
