import { describe, expect, it } from "vitest";

import { GROUP_LISTINGS, groupListing } from "../../bin/group-listing.mjs";

describe(groupListing, () => {
    it.each([
        [["cache", "--help"], 0],
        [["cache", "-h"], 0],
        [["cache"], 1],
        [["-v", "cache", "-h"], 0],
        [["--no-color", "cache"], 1],
        [["cache", "--debug", "--help"], 0],
    ] as const)("answers `vis %j` with exit code %i", (argv, expected) => {
        expect.assertions(1);

        expect(groupListing(argv)?.exitCode).toBe(expected);
    });

    it.each([[[]], [["--help"]], [["cache", "list"]], [["cache", "list", "--help"]], [["cache", "--cwd", "/tmp"]], [["--help", "cache"]], [["docker"]], [["cache", "--", "--help"]]])(
        "leaves `vis %j` to the command parser",
        (argv: string[]) => {
            expect.assertions(1);

            expect(groupListing(argv)).toBeUndefined();
        },
    );

    it("turns the group into `help <group>` and keeps the global flags", () => {
        expect.assertions(3);

        expect(groupListing(["cache", "--help"])?.argv).toStrictEqual(["help", "cache"]);
        expect(groupListing(["cache"])?.argv).toStrictEqual(["help", "cache"]);
        expect(groupListing(["-v", "cache", "-h", "--no-color"])?.argv).toStrictEqual(["help", "cache", "-v", "--no-color"]);
    });

    it.each(GROUP_LISTINGS)("treats every listed group like `%s`", (group: string) => {
        expect.assertions(1);

        expect(groupListing([group])).toStrictEqual({ argv: ["help", group], exitCode: 1 });
    });
});
