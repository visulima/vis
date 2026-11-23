import { stripVTControlCharacters } from "node:util";

import React, { Activity, startTransition, Suspense, useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Yoga from "yoga-layout";

import type { Props as AppContextProps } from "../../src/components/app-context";
import { Box, Static, Text } from "../../src/components/index";
import { useApp } from "../../src/ink/hooks/use-app";
import { useBoxMetrics } from "../../src/ink/hooks/use-box-metrics";
import { useWindowSize } from "../../src/ink/hooks/use-window-size";
import type { DOMElement } from "../../src/ink/index";
import { render, renderToString } from "../../src/ink/index";
import { createStdin } from "../helpers/ink-create-stdin";
import createStdout from "../helpers/ink-create-stdout";
import waitFor from "../helpers/wait-for";

const tick = async (ms = 0): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;

const writtenText = (stdout: ReturnType<typeof createStdout>): string => stripVTControlCharacters(stdout.getWrites().join(""));

const createGate = (): { Gate: () => React.ReactNode; release: () => void } => {
    let resolved = false;
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
        resolveGate = resolve;
    });

    const Gate = (): React.ReactNode => {
        if (!resolved) {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- React Suspense throws a thenable
            throw gate;
        }

        return null;
    };

    return {
        Gate,
        release: () => {
            resolved = true;
            resolveGate();
        },
    };
};

let suspendTerminal!: AppContextProps["suspendTerminal"];

const StaticWhileSuspended = ({ items, label = "Dynamic" }: { readonly items: string[]; readonly label?: string }): React.ReactNode => {
    ({ suspendTerminal } = useApp());

    return (
        <>
            <Static items={items}>{(item: string) => <Text key={item}>{item}</Text>}</Static>
            <Text>{label}</Text>
        </>
    );
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("shared process listeners", () => {
    it("registers one beforeExit listener for any number of live instances", async () => {
        expect.hasAssertions();

        const before = process.listenerCount("beforeExit");
        const exitBefore = process.listenerCount("exit");
        const warnings: Error[] = [];
        const onWarning = (warning: Error): void => {
            warnings.push(warning);
        };

        process.on("warning", onWarning);

        const instances = Array.from({ length: 12 }, () => render(<Text>hi</Text>, { patchConsole: false, stdout: createStdout() }));
        const exits = instances.map((instance) => instance.waitUntilExit());

        await tick(10);
        process.off("warning", onWarning);

        expect(process.listenerCount("beforeExit")).toBe(before + 1);
        expect(process.listenerCount("exit")).toBeLessThanOrEqual(exitBefore + 1);
        expect(warnings.filter((warning) => warning.name === "MaxListenersExceededWarning")).toHaveLength(0);

        for (const instance of instances) {
            instance.unmount();
        }

        await Promise.all(exits);

        expect(process.listenerCount("beforeExit")).toBe(before);
    });

    it("keeps the shared listener until the last instance unmounts", async () => {
        expect.hasAssertions();

        const before = process.listenerCount("beforeExit");
        const first = render(<Text>a</Text>, { patchConsole: false, stdout: createStdout() });
        const second = render(<Text>b</Text>, { patchConsole: false, stdout: createStdout() });
        const firstExit = first.waitUntilExit();
        const secondExit = second.waitUntilExit();

        first.unmount();
        await firstExit;

        expect(process.listenerCount("beforeExit")).toBe(before + 1);

        second.unmount();
        await secondExit;

        expect(process.listenerCount("beforeExit")).toBe(before);
    });

    it("unmounts every live instance when the event loop drains", async () => {
        expect.hasAssertions();

        const first = render(<Text>a</Text>, { patchConsole: false, stdout: createStdout() });
        const second = render(<Text>b</Text>, { patchConsole: false, stdout: createStdout() });
        const exits = Promise.all([first.waitUntilExit(), second.waitUntilExit()]);

        process.emit("beforeExit", 0);

        await expect(exits).resolves.toBeDefined();
    });
});

describe("rerender after unmount", () => {
    it("is a no-op", async () => {
        expect.hasAssertions();

        let renders = 0;

        const Example = ({ label }: { readonly label: string }): React.ReactNode => {
            renders += 1;

            return <Text>{label}</Text>;
        };

        const stdout = createStdout();
        const instance = render(<Example label="first" />, { patchConsole: false, stdout });

        instance.unmount();
        await instance.waitUntilExit();

        const writes = stdout.getWrites().length;
        const rendersAtUnmount = renders;
        const created = vi.spyOn(Yoga.Node, "create");

        expect(() => {
            instance.rerender(<Example label="second" />);
        }).not.toThrow();

        await instance.waitUntilRenderFlush();

        expect(renders).toBe(rendersAtUnmount);
        expect(created).not.toHaveBeenCalled();
        expect(stdout.getWrites()).toHaveLength(writes);
    });
});

describe("<Static> output edges", () => {
    for (const interactive of [false, true]) {
        it(`writes <Static> output once when exit() is called from an effect (interactive: ${String(interactive)})`, async () => {
            expect.hasAssertions();

            const Example = (): React.ReactNode => {
                const { exit } = useApp();

                useEffect(() => {
                    exit();
                }, [exit]);

                return (
                    <>
                        <Static items={["A", "B"]}>{(item: string) => <Text key={item}>{item}</Text>}</Static>
                        <Text>Dynamic</Text>
                    </>
                );
            };

            const stdout = createStdout(100, interactive);
            const instance = render(<Example />, { interactive, patchConsole: false, stdin: createStdin(), stdout });

            await instance.waitUntilExit();

            const output = writtenText(stdout);

            expect(count(output, "A")).toBe(1);
            expect(count(output, "B")).toBe(1);
        });
    }
});

describe("while the terminal is suspended", () => {
    const start = async (): Promise<{ instance: ReturnType<typeof render>; stdout: ReturnType<typeof createStdout> }> => {
        const stdout = createStdout();
        const instance = render(<StaticWhileSuspended items={["first"]} />, { interactive: true, patchConsole: false, stdin: createStdin(), stdout });

        await instance.waitUntilRenderFlush();

        return { instance, stdout };
    };

    it("writes <Static> items added meanwhile once, after resume", async () => {
        expect.hasAssertions();

        const { instance, stdout } = await start();
        const suspension = await suspendTerminal();
        const writesAtSuspend = stdout.getWrites().length;

        instance.rerender(<StaticWhileSuspended items={["first", "second"]} />);
        await instance.waitUntilRenderFlush();

        expect(stripVTControlCharacters(stdout.getWrites().slice(writesAtSuspend).join(""))).not.toContain("second");

        await suspension.resume();
        await instance.waitUntilRenderFlush();

        const output = writtenText(stdout);

        expect(count(output, "first")).toBe(1);
        expect(count(output, "second")).toBe(1);

        instance.unmount();
    });

    it("keeps <Static> items added meanwhile when the instance unmounts before resume", async () => {
        expect.hasAssertions();

        const { instance, stdout } = await start();

        await suspendTerminal();
        instance.rerender(<StaticWhileSuspended items={["first", "second"]} />);
        await instance.waitUntilRenderFlush();
        instance.unmount();
        await instance.waitUntilExit();

        const output = writtenText(stdout);

        expect(count(output, "first")).toBe(1);
        expect(count(output, "second")).toBe(1);
    });

    it("draws the final frame when the instance unmounts before resume", async () => {
        expect.hasAssertions();

        const { instance, stdout } = await start();

        await suspendTerminal();

        const writesAtSuspend = stdout.getWrites().length;

        instance.rerender(<StaticWhileSuspended items={["first"]} label="Changed" />);
        await instance.waitUntilRenderFlush();
        instance.unmount();
        await instance.waitUntilExit();

        expect(stripVTControlCharacters(stdout.getWrites().slice(writesAtSuspend).join(""))).toContain("Changed");
    });
});

describe("yoga node lifetime", () => {
    it("frees yoga nodes created by a render React abandoned", async () => {
        expect.hasAssertions();

        const created: { freed: boolean }[] = [];
        const originalCreate = Yoga.Node.create.bind(Yoga.Node);

        vi.spyOn(Yoga.Node, "create").mockImplementation((...args: Parameters<typeof Yoga.Node.create>) => {
            const node = originalCreate(...args);
            const entry = { freed: false };

            created.push(entry);

            const originalFree = node.free.bind(node);

            node.free = () => {
                entry.freed = true;
                originalFree();
            };

            return node;
        });

        const { Gate, release } = createGate();

        let setStep!: (step: number) => void;

        const Example = (): React.ReactNode => {
            const [step, setStepState] = useState(0);

            setStep = setStepState;

            return (
                <Box flexDirection="column">
                    <Text>{`step ${step}`}</Text>
                    <Suspense fallback={<Text>loading</Text>}>
                        <Box>
                            <Text>{`inside ${step}`}</Text>
                            {step > 0 && <Gate />}
                        </Box>
                    </Suspense>
                </Box>
            );
        };

        const instance = render(<Example />, { concurrent: true, patchConsole: false, stdout: createStdout() });

        await tick(20);

        startTransition(() => {
            setStep(1);
        });

        await tick(50);
        release();
        await tick(400);

        instance.unmount();
        await instance.waitUntilExit();

        expect(created.filter((entry) => !entry.freed)).toHaveLength(0);
    });
});

describe("useBoxMetrics in hidden subtrees", () => {
    const createMetrics = (hidden?: boolean): { latest: () => ReturnType<typeof useBoxMetrics>; Metrics: () => React.ReactNode } => {
        let latest!: ReturnType<typeof useBoxMetrics>;

        const Metrics = (): React.ReactNode => {
            const ref = useRef<DOMElement>(null);

            latest = useBoxMetrics(ref);

            return (
                <Box display={hidden ? "none" : "flex"}>
                    <Box ref={ref} width={7}>
                        <Text>box</Text>
                    </Box>
                </Box>
            );
        };

        return { latest: () => latest, Metrics };
    };

    it("settles for a box added inside a hidden <Activity>", async () => {
        expect.hasAssertions();

        const { latest, Metrics } = createMetrics();

        const Example = ({ mode }: { readonly mode: "hidden" | "visible" }): React.ReactNode => (
            <Activity mode={mode}>
                <Metrics />
            </Activity>
        );

        const instance = render(<Example mode="hidden" />, { patchConsole: false, stdout: createStdout() });

        await tick(20);
        instance.rerender(<Example mode="visible" />);
        await waitFor(() => latest().hasMeasured);

        expect(latest().width).toBe(7);

        instance.unmount();
    });

    it("settles for a box inside a display none ancestor", async () => {
        expect.hasAssertions();

        const { latest, Metrics } = createMetrics(true);
        const instance = render(<Metrics />, { patchConsole: false, stdout: createStdout() });

        await waitFor(() => latest().hasMeasured);

        expect(latest().hasMeasured).toBe(true);

        instance.unmount();
    });

    for (const concurrent of [false, true]) {
        it(`settles for a box mounted while its <Suspense> boundary is suspended (concurrent: ${String(concurrent)})`, async () => {
            expect.hasAssertions();

            const { latest, Metrics } = createMetrics();
            const { Gate, release } = createGate();

            const Example = (): React.ReactNode => (
                <Suspense fallback={<Text>loading</Text>}>
                    <Metrics />
                    <Gate />
                </Suspense>
            );

            const instance = render(<Example />, { concurrent, patchConsole: false, stdout: createStdout() });

            await tick(20);
            release();
            await waitFor(() => latest().hasMeasured);

            expect(latest().width).toBe(7);

            instance.unmount();
        });

        it(`settles for a box added while its <Suspense> boundary is hidden (concurrent: ${String(concurrent)})`, async () => {
            expect.hasAssertions();

            const { latest, Metrics } = createMetrics();
            const { Gate, release } = createGate();

            const Example = ({ extra, suspend }: { readonly extra: boolean; readonly suspend: boolean }): React.ReactNode => (
                <Suspense fallback={<Text>loading</Text>}>
                    <Text>content</Text>
                    {extra && <Metrics />}
                    {suspend && <Gate />}
                </Suspense>
            );

            const instance = render(<Example extra={false} suspend={false} />, { concurrent, patchConsole: false, stdout: createStdout() });

            await tick(20);
            instance.rerender(<Example extra={false} suspend />);
            await tick(20);
            instance.rerender(<Example extra suspend />);
            await tick(20);
            release();

            // React throttles revealing a boundary that just showed its fallback.
            await waitFor(() => latest().hasMeasured);

            expect(latest().width).toBe(7);

            instance.unmount();
        });
    }
});

describe("<ViewTransition>", () => {
    const reactExports = React as unknown as Record<string, unknown>;
    const ViewTransition = reactExports["ViewTransition"] ?? reactExports["unstable_ViewTransition"];

    it.skipIf(ViewTransition === undefined)("renders its children transparently", () => {
        expect.hasAssertions();

        const Transition = ViewTransition as React.ComponentType<{ children: React.ReactNode }>;

        expect(
            renderToString(
                <Box>
                    <Transition>
                        <Text>inside</Text>
                    </Transition>
                </Box>,
            ),
        ).toBe("inside");
    });
});

describe("useWindowSize in renderToString", () => {
    it("reports the requested columns and a sensible row count", () => {
        expect.hasAssertions();

        let size: ReturnType<typeof useWindowSize> | undefined;

        const Size = (): React.ReactNode => {
            size = useWindowSize();

            return <Text>{`${size.columns}x${size.rows}`}</Text>;
        };

        const output = renderToString(<Size />, { columns: 37 });

        expect(size?.columns).toBe(37);
        expect(size?.rows).toBeGreaterThan(0);
        expect(output).toMatch(/^37x\d+$/);
    });
});
