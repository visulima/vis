import process from "node:process";

import React from "react";

import { Box, Cursor, Text } from "../../../src/components/index";
import { render } from "../../../src/ink/index";
import step from "./pty-step";

const lineCount = Number(process.env["FIXTURE_LINES"] ?? 3);
const historyCount = Number(process.env["FIXTURE_HISTORY"] ?? 0);

const Frame = ({ marker }: { marker: string }) => (
    <Box flexDirection="column">
        {Array.from({ length: lineCount }, (_, index) => (
            <Text key={index}>{index === 1 ? `Frame line 2 ${marker}` : `Frame line ${String(index + 1)}`}</Text>
        ))}
        {process.env["FIXTURE_CURSOR"] === "1" ? <Cursor /> : null}
    </Box>
);

for (let index = 1; index <= historyCount; index += 1) {
    console.log(`history ${String(index)}`);
}

const resized = new Promise<void>((resolve) => {
    process.stdout.once("resize", () => {
        resolve();
    });
});

const { rerender, unmount, waitUntilRenderFlush } = render(<Frame marker="a" />, {
    alternateScreen: process.env["FIXTURE_ALT"] === "1",
    incrementalRendering: process.env["FIXTURE_INCREMENTAL"] === "1",
    isScreenReaderEnabled: process.env["FIXTURE_SCREEN_READER"] === "1",
    useNativeRenderer: process.env["FIXTURE_NATIVE"] === "1",
});

await waitUntilRenderFlush();
await step("rendered");

// The terminal can shrink before the resize event reaches the process; a render in that window still sees the old size.
if (process.env["FIXTURE_RENDER_BEFORE_RESIZE"] === "1") {
    rerender(<Frame marker="b" />);
    await waitUntilRenderFlush();
    await step("updated");
}

await resized;
await waitUntilRenderFlush();
await step("resized");

if (process.env["FIXTURE_RENDER_BEFORE_RESIZE"] !== "1") {
    rerender(<Frame marker="b" />);
    await waitUntilRenderFlush();
    await step("updated");
}

unmount();
