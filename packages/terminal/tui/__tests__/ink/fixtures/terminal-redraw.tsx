import process from "node:process";

import React from "react";

import { Box, Static, Text } from "../../../src/components/index";
import { render } from "../../../src/ink/index";
import step from "./pty-step";

const sentence = "alpha bravo charlie delta echo";
const liveCount = Number(process.env["FIXTURE_LINES"] ?? 2);

const App = () => (
    <>
        <Static items={["static-1", "static-2"]}>{(item) => <Text key={item}>{item}</Text>}</Static>
        <Box flexDirection="column">
            <Text>{sentence}</Text>
            {Array.from({ length: liveCount }, (_, index) => (
                <Text key={index}>{`live ${String(index + 1)}`}</Text>
            ))}
        </Box>
    </>
);

const resized = (): Promise<void> =>
    new Promise((resolve) => {
        process.stdout.once("resize", () => {
            resolve();
        });
    });

const narrowed = resized();
const { redraw, unmount, waitUntilRenderFlush } = render(<App />);

await waitUntilRenderFlush();
await step("rendered");

// The test narrows the terminal, then widens it again.
await narrowed;
await waitUntilRenderFlush();

const widened = resized();

await step("narrow");

await widened;
await waitUntilRenderFlush();
await step("wide");

redraw();
await waitUntilRenderFlush();
await step("redrawn");

unmount();
