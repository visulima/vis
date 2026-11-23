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
            expect(screenOf(stdout)).toEqual(["static-1", "static-2", "alpha bravo charlie delta echo", "live"]);

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

            expect(screenOf(stdout)).toEqual(["static-1", "static-2", "static-3", "alpha bravo charlie delta echo", "live"]);

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

            expect(screenOf(stdout)).toEqual(["static-1", "static-2", "static-3", "alpha bravo charlie delta echo", "live"]);

            app.unmount();
        });
    });

    describe("when there is nothing to redraw", () => {
        it("writes nothing when the output is not a TTY", async () => {
            expect.assertions(1);

            const stdout = createStdout(COLS, false, ROWS);
            const app = render(<App />, { interactive: true, stdout });

            await app.waitUntilRenderFlush();

            const before = stdout.getWrites().length;

            app.redraw();
            await app.waitUntilRenderFlush();

            expect(stdout.getWrites()).toHaveLength(before);

            app.unmount();
        });

        it("writes nothing when the app is not interactive", async () => {
            expect.assertions(1);

            const stdout = createStdout(COLS, true, ROWS);
            const app = render(<App />, { interactive: false, stdout });

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

    it("writes the rows that scrolled off an overflowToBackbuffer region again", async () => {
        expect.assertions(3);

        const stdout = createStdout(COLS, true, ROWS);
        const content = Array.from({ length: 40 }, (_, index) => `ROW${String(index).padStart(4, "0")}`).join("\n");
        const app = render(
            <Box flexDirection="column" height={5} overflowToBackbuffer overflowY="scroll" scrollTop={8} stableScrollback width={20}>
                <Box flexDirection="column" flexShrink={0}>
                    <Text>{content}</Text>
                </Box>
            </Box>,
            { interactive: true, stdout },
        );

        await app.waitUntilRenderFlush();

        const before = stdout.getWrites().length;

        app.redraw();
        await app.waitUntilRenderFlush();

        const redrawn = stripAnsi(stdout.getWrites().slice(before).join(""));

        expect(stdout.getWrites().slice(before).join("")).toMatch(ERASE_SCROLLBACK);
        expect(redrawn.split("ROW0000")).toHaveLength(2);
        expect(redrawn.split("ROW0007")).toHaveLength(2);

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
        expect(screenOf(stdout)).toEqual(["static-1", "static-2", "alpha bravo charlie delta echo", "live"]);

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

        expect(screenOf(stdout)).toEqual(["static-1", "static-2", "alpha bravo charlie delta echo", "live"]);

        app.unmount();
    });
});
