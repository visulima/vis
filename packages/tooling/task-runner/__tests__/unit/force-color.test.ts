import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forceColorFor } from "../../src/force-color";

describe(forceColorFor, () => {
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const saved: Record<string, string | undefined> = {};

    const setStdoutIsTTY = (value: boolean): void => {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
    };

    beforeEach(() => {
        for (const name of ["FORCE_COLOR", "NO_COLOR"]) {
            saved[name] = process.env[name];
            Reflect.deleteProperty(process.env, name);
        }
    });

    afterEach(() => {
        for (const name of ["FORCE_COLOR", "NO_COLOR"]) {
            if (saved[name] === undefined) {
                Reflect.deleteProperty(process.env, name);
            } else {
                process.env[name] = saved[name];
            }
        }

        if (stdoutDescriptor) {
            Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
        } else {
            delete (process.stdout as { isTTY?: boolean }).isTTY;
        }
    });

    it("does not force colour when stdout is not a terminal", () => {
        expect.assertions(1);

        setStdoutIsTTY(false);

        expect(forceColorFor(undefined, undefined, true)).toBeUndefined();
    });

    it("forces colour when stdout is a terminal", () => {
        expect.assertions(1);

        setStdoutIsTTY(true);

        expect(forceColorFor(undefined, undefined, true)).toBe("1");
    });

    it("never forces colour when NO_COLOR is set and not empty, even on a terminal", () => {
        expect.assertions(3);

        setStdoutIsTTY(true);
        process.env["NO_COLOR"] = "1";

        expect(forceColorFor(undefined, undefined, true)).toBeUndefined();

        // An empty NO_COLOR does not count (no-color.org).
        process.env["NO_COLOR"] = "";

        expect(forceColorFor(undefined, undefined, true)).toBe("1");

        // A task-level NO_COLOR, even an empty one, replaces the parent's.
        process.env["NO_COLOR"] = "1";

        expect(forceColorFor({ NO_COLOR: "" }, undefined, true)).toBe("1");
    });

    it("keeps the caller's FORCE_COLOR over the terminal default and over the parent's", () => {
        expect.assertions(2);

        setStdoutIsTTY(true);
        process.env["FORCE_COLOR"] = "2";

        expect(forceColorFor({ FORCE_COLOR: "0" }, undefined, true)).toBe("0");
        expect(forceColorFor(undefined, undefined, true)).toBe("2");
    });

    it("ignores the parent's environment when the child does not inherit it", () => {
        expect.assertions(3);

        setStdoutIsTTY(true);
        process.env["FORCE_COLOR"] = "2";
        process.env["NO_COLOR"] = "1";

        // Only the caller's own variables count: the parent's FORCE_COLOR and NO_COLOR are not the child's.
        expect(forceColorFor({}, undefined, false)).toBe("1");
        expect(forceColorFor({ NO_COLOR: "1" }, undefined, false)).toBeUndefined();
        expect(forceColorFor({ FORCE_COLOR: "3" }, undefined, false)).toBe("3");
    });

    it("reads NO_COLOR from the extras too, as they end up in the child's environment", () => {
        expect.assertions(1);

        setStdoutIsTTY(true);

        expect(forceColorFor(undefined, { NO_COLOR: "1" }, true)).toBeUndefined();
    });
});
