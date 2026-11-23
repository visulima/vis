import { describe, expect, it } from "vitest";

import { Box, Static, Text } from "../../src/components/index";
import { render, renderToString } from "../../src/ink/index";
import { createNative } from "../../src/ink/log-update-native";
import createStdout from "../helpers/ink-create-stdout";
import { replay, visibleRows } from "../helpers/ink-screen";

// The terminal model wraps a row that is wider than the screen onto the next one, as a real terminal does,
// so an unclipped row shows up as an extra row of text under the over-wide row.

const nativeAvailable = createNative(createStdout(20, true, 6)) !== undefined;

const COLS = 20;
const ROWS = 8;

type Mode = { name: string; options: { alternateScreen?: boolean; useNativeRenderer?: boolean }; skip: boolean };

const modes: Mode[] = [
    { name: "inline renderer", options: {}, skip: false },
    { name: "native renderer", options: { alternateScreen: true, useNativeRenderer: true }, skip: !nativeAvailable },
    { name: "inline native renderer", options: { useNativeRenderer: true }, skip: !nativeAvailable },
];

const draw = async (node: React.JSX.Element, mode: Mode, nextNode?: React.JSX.Element) => {
    const stdout = createStdout(COLS, true, ROWS);
    const { rerender, unmount, waitUntilRenderFlush } = render(node, { interactive: true, stdout, ...mode.options });

    await waitUntilRenderFlush();

    if (nextNode) {
        rerender(nextNode);
        await waitUntilRenderFlush();
    }

    unmount();

    return replay(stdout.getWrites(), ROWS, COLS);
};

describe.each(modes)("over-wide content: $name", (mode) => {
    it.skipIf(mode.skip)("clips ASCII text at the right edge instead of wrapping it", async () => {
        expect.assertions(1);

        const screen = await draw(
            <>
                <Text>above</Text>
                <Box flexShrink={0} width={30}>
                    <Text>{"A".repeat(30)}</Text>
                </Box>
            </>,
            mode,
        );

        expect(visibleRows(screen).slice(0, 3)).toStrictEqual(["above", "A".repeat(COLS), ""]);
    });

    it.skipIf(mode.skip)("blanks a wide character whose second cell would fall past the edge", async () => {
        expect.assertions(1);

        const screen = await draw(
            <>
                <Text>above</Text>
                <Box flexShrink={0} width={30}>
                    <Text>{`A${"你".repeat(14)}`}</Text>
                </Box>
            </>,
            mode,
        );

        expect(visibleRows(screen).slice(0, 3)).toStrictEqual(["above", `A${"你".repeat(9)}`, ""]);
    });

    it.skipIf(mode.skip)("keeps a wide character that ends exactly at the edge", async () => {
        expect.assertions(1);

        const screen = await draw(
            <>
                <Text>above</Text>
                <Box flexShrink={0} width={30}>
                    <Text>{"你".repeat(14)}</Text>
                </Box>
            </>,
            mode,
        );

        expect(visibleRows(screen).slice(0, 3)).toStrictEqual(["above", "你".repeat(10), ""]);
    });

    it.skipIf(mode.skip)("keeps the style of the cells it clips to", async () => {
        expect.assertions(3);

        const screen = await draw(
            <>
                <Text>above</Text>
                <Box flexShrink={0} width={30}>
                    <Text>{`\u001B[31;44m${"B".repeat(30)}\u001B[0m`}</Text>
                </Box>
            </>,
            mode,
        );

        expect(visibleRows(screen).slice(0, 3)).toStrictEqual(["above", "B".repeat(COLS), ""]);
        expect(screen.styles[1]![COLS - 1]!.fg).not.toBe("");
        expect(screen.styles[1]![COLS - 1]!.bg).not.toBe("");
    });

    it.skipIf(mode.skip)("clips a border that drifts past the edge", async () => {
        expect.assertions(1);

        const screen = await draw(
            <>
                <Text>above</Text>
                <Box borderStyle="round" flexShrink={0} width={30}>
                    <Text>{"A".repeat(28)}</Text>
                </Box>
            </>,
            mode,
        );

        expect(visibleRows(screen).slice(0, 5)).toStrictEqual(["above", `╭${"─".repeat(COLS - 1)}`, `│${"A".repeat(COLS - 1)}`, `╰${"─".repeat(COLS - 1)}`, ""]);
    });

    it.skipIf(mode.skip)("leaves no stale row behind when the frame is redrawn", async () => {
        expect.assertions(1);

        const frame = (character: string) => (
            <>
                <Text>above</Text>
                <Box flexShrink={0} width={30}>
                    <Text>{character.repeat(30)}</Text>
                </Box>
            </>
        );

        const screen = await draw(frame("A"), mode, frame("B"));

        expect(visibleRows(screen).slice(0, 3)).toStrictEqual(["above", "B".repeat(COLS), ""]);
    });

    it.skipIf(mode.skip)("clips <Static> output", async () => {
        expect.assertions(1);

        const screen = await draw(
            <>
                <Text>above</Text>
                <Static items={["one"]}>
                    {(item: string) => (
                        <Box flexShrink={0} key={item} width={30}>
                            <Text>{"S".repeat(30)}</Text>
                        </Box>
                    )}
                </Static>
            </>,
            mode,
        );

        expect(visibleRows(screen).slice(0, 3)).toStrictEqual(["S".repeat(COLS), "above", ""]);
    });
});

describe("over-wide content: renderToString", () => {
    it("clips to the columns option", () => {
        expect.assertions(1);

        expect(
            renderToString(
                <Box flexShrink={0} width={30}>
                    <Text>{"A".repeat(30)}</Text>
                </Box>,
                { columns: COLS },
            ),
        ).toBe("A".repeat(COLS));
    });

    it("blanks a wide character that straddles the edge", () => {
        expect.assertions(1);

        expect(
            renderToString(
                <Box flexShrink={0} width={30}>
                    <Text>{"你".repeat(15)}</Text>
                </Box>,
                { columns: 21 },
            ),
        ).toBe("你".repeat(10));
    });
});
