import { afterEach, describe, expect, it, vi } from "vitest";

import { readStdin } from "../../src/util/read-stdin";

describe(readStdin, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("joins string and binary chunks into UTF-8 text", async () => {
        expect.assertions(1);

        const stdin = {
            async* [Symbol.asyncIterator]() {
                yield "hello ";
                yield Buffer.from("world");
            },
        };

        vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);

        await expect(readStdin()).resolves.toBe("hello world");
    });
});
