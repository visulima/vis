import { describe, expect, it } from "vitest";

import { cacheGroupHelpArguments, cacheGroupHelpExitCode } from "../../../src/commands/cache/group-help";

describe(cacheGroupHelpExitCode, () => {
    it.each([
        [["cache", "--help"], 0],
        [["cache", "-h"], 0],
        [["cache"], 1],
        [["-v", "cache", "-h"], 0],
        [["--no-color", "cache"], 1],
        [["cache", "--debug", "--help"], 0],
    ] as const)("answers `vis %j` with exit code %i", (argv, expected) => {
        expect.assertions(1);

        expect(cacheGroupHelpExitCode(argv)).toBe(expected);
    });

    it.each([[[]], [["--help"]], [["cache", "list"]], [["cache", "list", "--help"]], [["cache", "--cwd", "/tmp"]], [["--help", "cache"]], [["docker"]], [["cache", "--", "--help"]]])(
        "leaves `vis %j` to the command parser",
        (argv: string[]) => {
            expect.assertions(1);

            expect(cacheGroupHelpExitCode(argv)).toBeUndefined();
        },
    );
});

describe(cacheGroupHelpArguments, () => {
    it("turns the group into `help cache` and keeps the global flags", () => {
        expect.assertions(3);

        expect(cacheGroupHelpArguments(["cache", "--help"])).toStrictEqual(["help", "cache"]);
        expect(cacheGroupHelpArguments(["cache"])).toStrictEqual(["help", "cache"]);
        expect(cacheGroupHelpArguments(["-v", "cache", "-h", "--no-color"])).toStrictEqual(["help", "cache", "-v", "--no-color"]);
    });
});
