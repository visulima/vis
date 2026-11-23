import { clearScreenAndHomeCursor } from "@visulima/ansi";
import { useEffect, useLayoutEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import { Box, Static, Text } from "../../src/components/index";
import { useApp } from "../../src/ink/hooks/use-app";
import { render } from "../../src/ink/index";
import { createNative } from "../../src/ink/log-update-native";
import createStdout from "../helpers/ink-create-stdout";
import { replay, visibleRows } from "../helpers/ink-screen";
import waitFor from "../helpers/wait-for";

const nativeAvailable = createNative(createStdout(20, true, 6)) !== undefined;

const COLS = 30;
const ROWS = 8;

const Measured = ({ step }: { readonly step: number }) => {
    const [measured, setMeasured] = useState(-1);

    useLayoutEffect(() => {
        setMeasured(step);
    }, [step]);

    return <Text>{`step ${step} measured ${measured}`}</Text>;
};

const createDriver = () => {
    const handle = { setStep: (_step: number) => {} };

    const Driver = () => {
        const [step, set] = useState(1);

        handle.setStep = set;

        return <Measured step={step} />;
    };

    return { Driver, setStep: (step: number) => handle.setStep(step) };
};

const allRows = (writes: string[]) => {
    const screen = replay(writes, ROWS, COLS);

    return [...screen.scrollback, ...visibleRows(screen)].filter((row) => /^[abc]$/u.test(row));
};

const writtenText = (stdout: ReturnType<typeof createStdout>) => stdout.getWrites().join("");

describe("state update in useLayoutEffect", () => {
    it("never writes the frame from before the update on mount", async () => {
        expect.assertions(2);

        const stdout = createStdout(COLS, true, ROWS);
        const { unmount, waitUntilRenderFlush } = render(<Measured step={1} />, { interactive: true, stdout });

        await waitUntilRenderFlush();

        expect(writtenText(stdout)).not.toContain("measured -1");
        expect(writtenText(stdout)).toContain("step 1 measured 1");

        unmount();
    });

    it("never writes the frame from before the update on rerender", async () => {
        expect.assertions(3);

        const stdout = createStdout(COLS, true, ROWS);
        const { rerender, unmount, waitUntilRenderFlush } = render(<Measured step={1} />, { interactive: true, stdout });

        await waitUntilRenderFlush();

        rerender(<Measured step={2} />);
        await waitUntilRenderFlush();

        const output = writtenText(stdout);

        expect(output).not.toContain("step 2 measured 1");
        expect(output).toContain("step 2 measured 2");
        expect(output).not.toContain("measured -1");

        unmount();
    });

    it("never writes the intermediate frame when the update comes from outside React's render call", async () => {
        expect.assertions(2);

        const stdout = createStdout(COLS, true, ROWS);
        const { Driver, setStep } = createDriver();

        const { unmount, waitUntilRenderFlush } = render(<Driver />, { interactive: true, stdout });

        await waitUntilRenderFlush();

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
        });

        setStep(2);
        await waitFor(() => writtenText(stdout).includes("step 2 measured 2"));

        expect(writtenText(stdout)).not.toContain("step 2 measured 1");
        expect(writtenText(stdout)).toContain("step 2 measured 2");

        unmount();
    });

    it("appends <Static> output once and in order next to a layout-effect update", async () => {
        expect.assertions(3);

        const stdout = createStdout(COLS, true, ROWS);

        const App = ({ items, step }: { readonly items: string[]; readonly step: number }) => (
            <>
                <Static items={items}>{(item) => <Text key={item}>{item}</Text>}</Static>
                <Measured step={step} />
            </>
        );

        const { rerender, unmount, waitUntilRenderFlush } = render(<App items={["a"]} step={1} />, { interactive: true, stdout });

        await waitUntilRenderFlush();

        rerender(<App items={["a", "b", "c"]} step={2} />);
        await waitUntilRenderFlush();

        const output = writtenText(stdout);

        expect(output).not.toMatch(/step \d measured -1|step 2 measured 1/u);
        expect(allRows(stdout.getWrites())).toStrictEqual(["a", "b", "c"]);
        expect(output).toContain("step 2 measured 2");

        unmount();
    });

    it("has written the frame of an update that starts outside React once waitUntilRenderFlush resolves", async () => {
        expect.assertions(1);

        const stdout = createStdout(COLS, true, ROWS);
        const { Driver, setStep } = createDriver();

        const { unmount, waitUntilRenderFlush } = render(<Driver />, { interactive: true, stdout });

        await waitUntilRenderFlush();

        setStep(2);
        await waitUntilRenderFlush();

        expect(writtenText(stdout)).toContain("step 2 measured 2");

        unmount();
    });

    it("writes the last <Static> item and frame when the app exits from an effect", async () => {
        expect.assertions(2);

        const stdout = createStdout(COLS, true, ROWS);

        const ExitAfterAppend = ({ items }: { readonly items: string[] }) => {
            const { exit } = useApp();

            useEffect(() => {
                if (items.length > 1) {
                    exit();
                }
            }, [exit, items.length]);

            return (
                <>
                    <Static items={items}>{(item) => <Text key={item}>{item}</Text>}</Static>
                    <Measured step={items.length} />
                </>
            );
        };

        const { rerender, waitUntilExit, waitUntilRenderFlush } = render(<ExitAfterAppend items={["a"]} />, { interactive: true, stdout });

        await waitUntilRenderFlush();

        rerender(<ExitAfterAppend items={["a", "b"]} />);
        await waitUntilExit();

        expect(allRows(stdout.getWrites())).toStrictEqual(["a", "b"]);
        expect(writtenText(stdout)).toContain("step 2");
    });

    it("never writes the intermediate frame in concurrent mode", async () => {
        expect.assertions(2);

        const stdout = createStdout(COLS, true, ROWS);
        const { rerender, unmount, waitUntilRenderFlush } = render(<Measured step={1} />, { concurrent: true, interactive: true, stdout });

        await waitUntilRenderFlush();

        rerender(<Measured step={2} />);
        await waitUntilRenderFlush();

        expect(writtenText(stdout)).not.toMatch(/measured -1|step 2 measured 1/u);
        expect(writtenText(stdout)).toContain("step 2 measured 2");

        unmount();
    });

    it("does not replay a <Static> that a layout effect replaced in the same commit cycle", async () => {
        expect.assertions(3);

        const stdout = createStdout(COLS, true, ROWS);

        const SwapStatic = () => {
            const [label, setLabel] = useState("old");

            useLayoutEffect(() => {
                setLabel("new");
            }, []);

            return (
                <>
                    <Static items={[label]} key={label}>
                        {(item) => <Text key={item}>{item}</Text>}
                    </Static>
                    <Text>live</Text>
                </>
            );
        };

        const { unmount, waitUntilRenderFlush } = render(<SwapStatic />, { debug: true, stdout });

        await waitUntilRenderFlush();

        const writes = stdout.getWrites();

        expect(writes[0]).toContain("old");
        expect(writes.at(-1)).toContain("new");
        expect(writes.at(-1)).not.toContain("old");

        unmount();
    });

    it("clears a full-height frame once when the app exits from a layout effect after an update", async () => {
        expect.assertions(1);

        const stdout = createStdout(COLS, true, 5);

        const ExitOnUpdate = ({ done }: { readonly done: boolean }) => {
            const { exit } = useApp();

            useLayoutEffect(() => {
                if (done) {
                    exit();
                }
            }, [done, exit]);

            return (
                <Box height={5}>
                    <Text>{`done=${done}`}</Text>
                </Box>
            );
        };

        const { rerender, waitUntilExit, waitUntilRenderFlush } = render(<ExitOnUpdate done={false} />, { interactive: true, stdout });

        await waitUntilRenderFlush();

        rerender(<ExitOnUpdate done />);
        await waitUntilExit();

        expect(writtenText(stdout).split(clearScreenAndHomeCursor).length - 1).toBeLessThanOrEqual(1);
    });

    it("keeps the standardReactLayoutTiming option accepted", async () => {
        expect.assertions(2);

        const stdout = createStdout(COLS, true, ROWS);
        const { unmount, waitUntilRenderFlush } = render(<Measured step={1} />, { interactive: true, standardReactLayoutTiming: true, stdout });

        await waitUntilRenderFlush();

        expect(writtenText(stdout)).not.toContain("measured -1");
        expect(writtenText(stdout)).toContain("step 1 measured 1");

        unmount();
    });

    describe("native renderer", () => {
        it.skipIf(!nativeAvailable)("never draws the pre-update frame on mount or rerender", async () => {
            expect.assertions(4);

            const stdout = createStdout(COLS, true, ROWS);
            const { rerender, unmount, waitUntilRenderFlush } = render(<Measured step={1} />, {
                alternateScreen: true,
                interactive: true,
                stdout,
                useNativeRenderer: true,
            });

            await waitUntilRenderFlush();

            rerender(<Measured step={2} />);
            await waitUntilRenderFlush();

            const writes = stdout.getWrites();
            const screens = writes.map((_, index) => visibleRows(replay(writes.slice(0, index + 1), ROWS, COLS)).join("\n"));

            expect(screens.some((screen) => screen.includes("measured -1"))).toBe(false);
            expect(screens.some((screen) => screen.includes("step 2 measured 1"))).toBe(false);
            expect(screens.some((screen) => screen.includes("step 1 measured 1"))).toBe(true);
            expect(screens.at(-1)).toContain("step 2 measured 2");

            unmount();
        });

        it.skipIf(!nativeAvailable)("keeps <Static> output once and in order", async () => {
            expect.assertions(2);

            const stdout = createStdout(COLS, true, ROWS);

            const App = ({ items, step }: { readonly items: string[]; readonly step: number }) => (
                <Box flexDirection="column">
                    <Static items={items}>{(item) => <Text key={item}>{item}</Text>}</Static>
                    <Measured step={step} />
                </Box>
            );

            const { rerender, unmount, waitUntilRenderFlush } = render(<App items={["a"]} step={1} />, {
                interactive: true,
                stdout,
                useNativeRenderer: true,
            });

            await waitUntilRenderFlush();

            rerender(<App items={["a", "b", "c"]} step={2} />);
            await waitUntilRenderFlush();

            const writes = stdout.getWrites();
            const screens = writes.map((_, index) => visibleRows(replay(writes.slice(0, index + 1), ROWS, COLS)).join("\n"));

            expect(screens.some((screen) => /measured -1|step 2 measured 1/u.test(screen))).toBe(false);
            expect(allRows(writes)).toStrictEqual(["a", "b", "c"]);

            unmount();
        });
    });
});
