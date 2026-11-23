import { setTimeout as delay } from "node:timers/promises";

import React from "react";
import { describe, expect, it } from "vitest";

import { Text } from "../../src/components/index";
import useInput from "../../src/ink/hooks/use-input";
import { render } from "../../src/ink/index";
import { createStdin, emitReadable } from "../helpers/ink-create-stdin";
import createStdout from "../helpers/ink-create-stdout";
import waitFor from "../helpers/wait-for";

// Resolves with every key the handler saw once `sentinel`, sent after the chunks, has been delivered.
const collectInput = async (sentinel: string, ...chunks: string[]): Promise<string[]> => {
    const received: string[] = [];
    const Probe = () => {
        useInput((input, key) => {
            if (key.return) {
                received.push("<return>");
            } else if (key.tab) {
                received.push("<tab>");
            } else {
                received.push(input);
            }
        });

        return <Text>probe</Text>;
    };
    const stdin = createStdin();
    const { unmount } = render(<Probe />, { debug: true, stdin, stdout: createStdout() });

    await delay(0);

    for (const chunk of [...chunks, sentinel]) {
        emitReadable(stdin, chunk);
    }

    await waitFor(() => received.includes(sentinel));

    unmount();

    return received;
};

describe("useInput legacy mouse reports", () => {
    it("does not deliver the bytes of an X10 mouse report as typed input", async () => {
        expect.assertions(1);

        await expect(collectInput("x", "\u001B[M\r\tq", "\u001B[M !!")).resolves.toStrictEqual(["x"]);
    });

    it("does not deliver a report split across chunks, and keeps keys that follow it", async () => {
        expect.assertions(1);

        await expect(collectInput("y", "\u001B[M\r", "\tq")).resolves.toStrictEqual(["y"]);
    });
});
