import { strip as stripAnsi } from "@visulima/ansi";
import delay from "delay";
import React from "react";
import { describe, expect, it } from "vitest";

import { Box, Static, Text } from "../../src/components/index";
import { useApp } from "../../src/ink/hooks/use-app";
import { render } from "../../src/ink/index";
import { createNative } from "../../src/ink/log-update-native";
import createStdout from "../helpers/ink-create-stdout";
import { replay, visibleRows } from "../helpers/ink-screen";

const nativeAvailable = createNative(createStdout(20, true, 6), { inline: true }) !== undefined;

// eslint-disable-next-line no-control-regex -- the escape byte is the thing being searched for
const ERASE_SCROLLBACK = /\u001B\[3J/u;

const COLS = 40;
const ROWS = 12;

const EXPECTED_ROWS = ["static-1", "static-2", "alpha bravo charlie delta echo", "live"];
const EXPECTED_ROWS_WITH_THIRD = ["static-1", "static-2", "static-3", "alpha bravo charlie delta echo", "live"];

const defaultItems = ["static-1", "static-2"];

const App = ({ items = defaultItems }: { readonly items?: string[] }) => (
    <>
        <Static items={items}>{(item) => <Text key={item}>{item}</Text>}</Static>
        <Box flexDirection="column">
            <Text>alpha bravo charlie delta echo</Text>
            <Text>live</Text>
        </Box>
    </>
);

const resizeTo = async (stdout: ReturnType<typeof createStdout>, columns: number): Promise<void> => {
    Object.assign(stdout, { columns });
    stdout.emit("resize");
    await delay(50);
};

const screenOf = (stdout: ReturnType<typeof createStdout>): string[] => visibleRows(replay(stdout.getWrites(), ROWS, COLS)).filter((row) => row !== "");

const modes = [
    { alternateScreen: false, name: "string renderer, inline", useNativeRenderer: false },
    { alternateScreen: true, name: "string renderer, alternate screen", useNativeRenderer: false },
    { alternateScreen: false, name: "native renderer, inline", useNativeRenderer: true },
    { alternateScreen: true, name: "native renderer, alternate screen", useNativeRenderer: true },
] as const;

describe("instance.redraw()", () => {
    describe.each(modes)("$name", ({ alternateScreen, useNativeRenderer }) => {
        const skip = useNativeRenderer && !nativeAvailable;

        it.skipIf(skip)("shows the same screen as a fresh render at the wide size after narrow, wide, redraw()", async () => {
            expect.assertions(2);

            const fresh = createStdout(COLS, true, ROWS);
            const freshApp = render(<App />, { alternateScreen, interactive: true, stdout: fresh, useNativeRenderer });

            await freshApp.waitUntilRenderFlush();

            const stdout = createStdout(COLS, true, ROWS);
            const app = render(<App />, { alternateScreen, interactive: true, stdout, useNativeRenderer });

            await app.waitUntilRenderFlush();
            await resizeTo(stdout, 20);
            await resizeTo(stdout, COLS);
            app.redraw();
            await app.waitUntilRenderFlush();

            expect(screenOf(stdout)).toEqual(screenOf(fresh));
            expect(screenOf(stdout)).toEqual(EXPECTED_ROWS);

            app.unmount();
            freshApp.unmount();
        });

        it.skipIf(skip)("keeps <Static> output, including items added after the first frame, and draws the frame once per redraw()", async () => {
            expect.assertions(1);

            const stdout = createStdout(COLS, true, ROWS);
            const app = render(<App />, { alternateScreen, interactive: true, stdout, useNativeRenderer });

            await app.waitUntilRenderFlush();
            app.rerender(<App items={["static-1", "static-2", "static-3"]} />);
            await app.waitUntilRenderFlush();
            app.redraw();
            app.redraw();
            await app.waitUntilRenderFlush();

            expect(screenOf(stdout)).toEqual(EXPECTED_ROWS_WITH_THIRD);

            app.unmount();
        });

        it.skipIf(skip)("applies a redraw() that directly follows rerender()", async () => {
            expect.assertions(1);

            const stdout = createStdout(COLS, true, ROWS);
            const app = render(<App />, { alternateScreen, interactive: true, stdout, useNativeRenderer });

            await app.waitUntilRenderFlush();
            app.rerender(<App items={["static-1", "static-2", "static-3"]} />);
            app.redraw();
            await app.waitUntilRenderFlush();

            expect(screenOf(stdout)).toEqual(EXPECTED_ROWS_WITH_THIRD);

            app.unmount();
        });
    });

    describe("when there is nothing to redraw", () => {
        it.each([
            { isTTY: false, name: "the output is not a TTY", options: { interactive: true } },
            { isTTY: true, name: "the app is not interactive", options: { interactive: false } },
        ])("writes nothing when $name", async ({ isTTY, options }) => {
            expect.assertions(1);

            const stdout = createStdout(COLS, isTTY, ROWS);
            const app = render(<App />, { ...options, stdout });

            await app.waitUntilRenderFlush();

            const before = stdout.getWrites().length;

            app.redraw();
            await app.waitUntilRenderFlush();

            expect(stdout.getWrites()).toHaveLength(before);

            app.unmount();
        });

        it("writes nothing after unmount", async () => {
            expect.assertions(1);

            const stdout = createStdout(COLS, true, ROWS);
            const app = render(<App />, { interactive: true, stdout });

            await app.waitUntilRenderFlush();
            app.unmount();

            const before = stdout.getWrites().length;

            app.redraw();
            app.redraw();

            expect(stdout.getWrites()).toHaveLength(before);
        });
    });

    describe("overflowToBackbuffer", () => {
        const content = Array.from({ length: 40 }, (_, index) => `ROW${String(index).padStart(4, "0")}`).join("\n");

        const Scrolled = () => (
            <Box flexDirection="column" height={5} overflowToBackbuffer overflowY="scroll" scrollTop={8} stableScrollback width={20}>
                <Box flexDirection="column" flexShrink={0}>
                    <Text>{content}</Text>
                </Box>
            </Box>
        );

        const expectScrolledRowsWrittenOnce = (stdout: ReturnType<typeof createStdout>, before: number): void => {
            const written = stdout.getWrites().slice(before).join("");
            const redrawn = stripAnsi(written);

            expect(written).toMatch(ERASE_SCROLLBACK);
            expect(redrawn.split("ROW0000")).toHaveLength(2);
            expect(redrawn.split("ROW0007")).toHaveLength(2);
        };

        it("writes the rows that scrolled off again", async () => {
            expect.assertions(3);

            const stdout = createStdout(COLS, true, ROWS);
            const app = render(<Scrolled />, { interactive: true, stdout });

            await app.waitUntilRenderFlush();

            const before = stdout.getWrites().length;

            app.redraw();
            await app.waitUntilRenderFlush();

            expectScrolledRowsWrittenOnce(stdout, before);

            app.unmount();
        });

        it("writes the rows that scrolled off again when the redraw waited for a resume", async () => {
            expect.assertions(3);

            const stdout = createStdout(COLS, true, ROWS);
            let suspendTerminal!: ReturnType<typeof useApp>["suspendTerminal"];

            const Example = () => {
                suspendTerminal = useApp().suspendTerminal;

                return <Scrolled />;
            };

            const app = render(<Example />, { interactive: true, stdout });

            await app.waitUntilRenderFlush();

            const suspension = await suspendTerminal();
            const before = stdout.getWrites().length;

            app.redraw();
            await suspension.resume();
            await app.waitUntilRenderFlush();

            expectScrolledRowsWrittenOnce(stdout, before);

            app.unmount();
        });
    });

    it("does not write the output of a replaced Static again", async () => {
        expect.assertions(1);

        const stdout = createStdout(COLS, true, ROWS);
        const Replaceable = ({ id, items }: { readonly id: string; readonly items: string[] }) => (
            <>
                <Static items={items} key={id}>
                    {(item) => <Text key={item}>{item}</Text>}
                </Static>
                <Text>live</Text>
            </>
        );
        const app = render(<Replaceable id="a" items={["first-1", "first-2"]} />, { interactive: true, stdout });

        await app.waitUntilRenderFlush();
        app.rerender(<Replaceable id="b" items={["second-1"]} />);
        await app.waitUntilRenderFlush();
        app.redraw();
        await app.waitUntilRenderFlush();

        expect(screenOf(stdout)).toEqual(["second-1", "live"]);

        app.unmount();
    });

    it("waits for the terminal to be resumed", async () => {
        expect.assertions(3);

        const stdout = createStdout(COLS, true, ROWS);
        let suspendTerminal!: ReturnType<typeof useApp>["suspendTerminal"];

        const Example = () => {
            suspendTerminal = useApp().suspendTerminal;

            return <App />;
        };

        const app = render(<Example />, { interactive: true, stdout });

        await app.waitUntilRenderFlush();

        const suspension = await suspendTerminal();
        const before = stdout.getWrites().length;

        app.redraw();

        expect(stdout.getWrites()).toHaveLength(before);

        await suspension.resume();
        await app.waitUntilRenderFlush();

        expect(stdout.getWrites().slice(before).join("")).toMatch(ERASE_SCROLLBACK);
        expect(screenOf(stdout)).toEqual(EXPECTED_ROWS);

        app.unmount();
    });

    it("can be called again and again", async () => {
        expect.assertions(1);

        const stdout = createStdout(COLS, true, ROWS);
        const app = render(<App />, { interactive: true, stdout });

        await app.waitUntilRenderFlush();

        for (let index = 0; index < 5; index += 1) {
            app.redraw();
        }

        await app.waitUntilRenderFlush();

        expect(screenOf(stdout)).toEqual(EXPECTED_ROWS);

        app.unmount();
    });
});
