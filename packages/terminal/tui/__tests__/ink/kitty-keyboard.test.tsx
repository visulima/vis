import EventEmitter from "node:events";

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { Text } from "../../src/components/index";
import { useApp } from "../../src/ink/hooks/use-app";
import useInput from "../../src/ink/hooks/use-input";
import { render } from "../../src/ink/index";
import parseKeypress from "../../src/ink/parse-keypress";
import waitFor from "../helpers/wait-for";

// Helper to create kitty protocol CSI u sequences
const kittyKey = (codepoint: number, modifiers?: number, eventType?: number, textCodepoints?: number[]): string => {
    let seq = `\u001B[${String(codepoint)}`;

    if (modifiers !== undefined || eventType !== undefined || textCodepoints !== undefined) {
        seq += `;${String(modifiers ?? 1)}`;
    }

    if (eventType !== undefined || textCodepoints !== undefined) {
        seq += `:${String(eventType ?? 1)}`;
    }

    if (textCodepoints !== undefined) {
        seq += `;${textCodepoints.join(":")}`;
    }

    seq += "u";

    return seq;
};

describe("kitty-keyboard", () => {
    it("kitty protocol - simple character", () => {
        expect.assertions(6);

        const result = parseKeypress(kittyKey(97));

        expect(result.name).toBe("a");
        expect(result.ctrl).toBe(false);
        expect(result.shift).toBe(false);
        expect(result.meta).toBe(false);
        expect(result.eventType).toBe("press");
        expect(result.isKittyProtocol).toBe(true);
    });

    it("kitty protocol - uppercase character (shift)", () => {
        expect.assertions(4);

        const result = parseKeypress(kittyKey(65, 2));

        expect(result.name).toBe("a");
        expect(result.shift).toBe(true);
        expect(result.ctrl).toBe(false);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - ctrl modifier", () => {
        expect.assertions(4);

        const result = parseKeypress(kittyKey(97, 5));

        expect(result.name).toBe("a");
        expect(result.ctrl).toBe(true);
        expect(result.shift).toBe(false);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - alt/option modifier", () => {
        expect.assertions(4);

        const result = parseKeypress(kittyKey(97, 3));

        expect(result.name).toBe("a");
        expect(result.option).toBe(true);
        expect(result.ctrl).toBe(false);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - super modifier", () => {
        expect.assertions(4);

        const result = parseKeypress(kittyKey(97, 9));

        expect(result.name).toBe("a");
        expect(result.super).toBe(true);
        expect(result.ctrl).toBe(false);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - hyper modifier", () => {
        expect.assertions(4);

        const result = parseKeypress(kittyKey(97, 17));

        expect(result.name).toBe("a");
        expect(result.hyper).toBe(true);
        expect(result.super).toBe(false);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - meta modifier", () => {
        expect.assertions(3);

        const result = parseKeypress(kittyKey(97, 33));

        expect(result.name).toBe("a");
        expect(result.meta).toBe(true);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - caps lock", () => {
        expect.assertions(3);

        const result = parseKeypress(kittyKey(97, 65));

        expect(result.name).toBe("a");
        expect(result.capsLock).toBe(true);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - num lock", () => {
        expect.assertions(3);

        const result = parseKeypress(kittyKey(97, 129));

        expect(result.name).toBe("a");
        expect(result.numLock).toBe(true);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - combined modifiers (ctrl+shift)", () => {
        expect.assertions(5);

        const result = parseKeypress(kittyKey(97, 6));

        expect(result.name).toBe("a");
        expect(result.ctrl).toBe(true);
        expect(result.shift).toBe(true);
        expect(result.meta).toBe(false);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - combined modifiers (super+ctrl)", () => {
        expect.assertions(5);

        const result = parseKeypress(kittyKey(115, 13));

        expect(result.name).toBe("s");
        expect(result.super).toBe(true);
        expect(result.ctrl).toBe(true);
        expect(result.shift).toBe(false);
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - escape key", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(27));

        expect(result.name).toBe("escape");
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - return/enter key", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(13));

        expect(result.name).toBe("return");
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - tab key", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(9));

        expect(result.name).toBe("tab");
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - backspace key", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(127));

        expect(result.name).toBe("backspace");
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - backspace key (codepoint 127)", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(127));

        expect(result.name).toBe("backspace");
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - space key", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(32));

        expect(result.name).toBe("space");
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - event type press", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(97, 1, 1));

        expect(result.name).toBe("a");
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - event type repeat", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(97, 1, 2));

        expect(result.name).toBe("a");
        expect(result.eventType).toBe("repeat");
    });

    it("kitty protocol - event type release", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(97, 1, 3));

        expect(result.name).toBe("a");
        expect(result.eventType).toBe("release");
    });

    it("kitty protocol - number keys", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(49));

        expect(result.name).toBe("1");
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - special character", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(64));

        expect(result.name).toBe("@");
        expect(result.eventType).toBe("press");
    });

    it("kitty protocol - ctrl+letter uses the unshifted key code", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(97, 5));

        expect(result.name).toBe("a");
        expect(result.ctrl).toBe(true);
    });

    it("kitty protocol - preserves sequence and raw", () => {
        expect.assertions(2);

        const seq = kittyKey(97, 5);
        const result = parseKeypress(seq);

        expect(result.sequence).toBe(seq);
        expect(result.raw).toBe(seq);
    });

    it("kitty protocol - text-as-codepoints field", () => {
        expect.assertions(4);

        const result = parseKeypress(kittyKey(97, 2, 1, [65]));

        expect(result.name).toBe("a");
        expect(result.text).toBe("A");
        expect(result.shift).toBe(true);
        expect(result.isKittyProtocol).toBe(true);
    });

    it("kitty protocol - supplementary unicode codepoint", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(128_512));

        expect(result.name).toBe("😀");
        expect(result.isKittyProtocol).toBe(true);
    });

    it("kitty protocol - invalid codepoint above U+10FFFF returns safe empty keypress", () => {
        expect.assertions(4);

        const result = parseKeypress("\u001B[1114112u");

        expect(result.name).toBe("");
        expect(result.ctrl).toBe(false);
        expect(result.isKittyProtocol).toBe(true);
        expect(result.isPrintable).toBe(false);
    });

    it("kitty protocol - surrogate codepoint returns safe empty keypress", () => {
        expect.assertions(4);

        const result = parseKeypress("\u001B[55296u");

        expect(result.name).toBe("");
        expect(result.ctrl).toBe(false);
        expect(result.isKittyProtocol).toBe(true);
        expect(result.isPrintable).toBe(false);
    });

    it("non-kitty sequences fall back to legacy parsing", () => {
        expect.assertions(2);

        const result = parseKeypress("\u001B[A");

        expect(result.name).toBe("up");
        expect(result.isKittyProtocol).toBeUndefined();
    });

    it("non-kitty sequences - ctrl+c", () => {
        expect.assertions(3);

        const result = parseKeypress("\u0003");

        expect(result.name).toBe("c");
        expect(result.ctrl).toBe(true);
        expect(result.isKittyProtocol).toBeUndefined();
    });

    it("kitty protocol - isPrintable is true for regular characters", () => {
        expect.assertions(1);

        const result = parseKeypress(kittyKey(97));

        expect(result.isPrintable).toBe(true);
    });

    it("kitty protocol - isPrintable is false for escape", () => {
        expect.assertions(1);

        const result = parseKeypress(kittyKey(27));

        expect(result.isPrintable).toBe(false);
    });

    it("kitty protocol - isPrintable is true for space", () => {
        expect.assertions(1);

        const result = parseKeypress(kittyKey(32));

        expect(result.isPrintable).toBe(true);
    });

    it("kitty protocol - isPrintable is false for backspace", () => {
        expect.assertions(1);

        const result = parseKeypress(kittyKey(127));

        expect(result.isPrintable).toBe(false);
    });

    it("kitty protocol - isPrintable is true for ctrl+letter with its text", () => {
        expect.assertions(2);

        const result = parseKeypress(kittyKey(97, 5));

        expect(result.isPrintable).toBe(true);
        expect(result.text).toBe("a");
    });

    it("kitty protocol - capslock (57358) is non-printable", () => {
        expect.assertions(3);

        const result = parseKeypress("\u001B[57358u");

        expect(result.name).toBe("capslock");
        expect(result.isPrintable).toBe(false);
        expect(result.isKittyProtocol).toBe(true);
    });

    it("kitty protocol - printscreen (57361) is non-printable", () => {
        expect.assertions(3);

        const result = parseKeypress("\u001B[57361u");

        expect(result.name).toBe("printscreen");
        expect(result.isPrintable).toBe(false);
        expect(result.isKittyProtocol).toBe(true);
    });

    it("kitty protocol - f13 (57376) is non-printable", () => {
        expect.assertions(3);

        const result = parseKeypress("\u001B[57376u");

        expect(result.name).toBe("f13");
        expect(result.isPrintable).toBe(false);
        expect(result.isKittyProtocol).toBe(true);
    });

    it("kitty protocol - space key has text field set to space character", () => {
        expect.assertions(1);

        const result = parseKeypress(kittyKey(32));

        expect(result.text).toBe(" ");
    });

    it("kitty protocol - return key has text field set to carriage return", () => {
        expect.assertions(1);

        const result = parseKeypress(kittyKey(13));

        expect(result.text).toBe("\r");
    });

    // Init/cleanup control sequence tests

    const createFakeStdout = () => {
        const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;

        stdout.columns = 100;
        stdout.isTTY = true;
        const write = vi.fn<(...arguments_: unknown[]) => boolean>();

        stdout.write = write;

        return { stdout, write };
    };

    const createFakeStdin = () => {
        const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;

        stdin.isTTY = true;
        (stdin as Record<string, unknown>).setRawMode = () => stdin;
        (stdin as Record<string, unknown>).read = () => undefined;
        vi.spyOn(stdin, "setRawMode").mockImplementation(() => stdin);
        stdin.setEncoding = () => stdin;
        vi.spyOn(stdin, "read").mockReturnValue(null);

        return stdin;
    };

    const getWrittenStrings = (write: ReturnType<typeof vi.fn>): string[] => write.mock.calls.map((args: any) => args[0] as string);

    const InputConsumer = (): React.ReactNode => {
        useInput(() => {});

        return <Text>Hello</Text>;
    };

    it("kitty protocol - writes enable sequence once input is read when mode is enabled", () => {
        expect.assertions(1);

        const { stdout, write } = createFakeStdout();
        const stdin = createFakeStdin();

        const { unmount } = render(<InputConsumer />, {
            kittyKeyboard: { mode: "enabled" },
            stdin,
            stdout,
        });

        expect(getWrittenStrings(write)).toContain("\u001B[>1u");

        unmount();
    });

    it("kitty protocol - writes disable sequence on unmount", () => {
        expect.assertions(1);

        const { stdout, write } = createFakeStdout();
        const stdin = createFakeStdin();

        const { unmount } = render(<InputConsumer />, {
            kittyKeyboard: { mode: "enabled" },
            stdin,
            stdout,
        });

        unmount();

        expect(getWrittenStrings(write)).toContain("\u001B[<u");
    });

    it("kitty protocol - not enabled when stdin is not a TTY", () => {
        expect.assertions(1);

        const { stdout, write } = createFakeStdout();
        const stdin = createFakeStdin();

        stdin.isTTY = false;

        const { unmount } = render(<InputConsumer />, {
            kittyKeyboard: { mode: "enabled" },
            stdin,
            stdout,
        });

        expect(getWrittenStrings(write)).not.toContain("\u001B[>1u");

        unmount();
    });

    it("kitty protocol - not enabled when stdout is not a TTY", () => {
        expect.assertions(1);

        const { stdout, write } = createFakeStdout();

        stdout.isTTY = false;
        const stdin = createFakeStdin();

        const { unmount } = render(<InputConsumer />, {
            kittyKeyboard: { mode: "enabled" },
            stdin,
            stdout,
        });

        expect(getWrittenStrings(write)).not.toContain("\u001B[>1u");

        unmount();
    });

    describe("negotiation only while raw mode is on", () => {
        const QUERY = "\u001B[?u";
        const PUSH = "\u001B[>1u";
        const POP = "\u001B[<u";

        const count = (write: ReturnType<typeof vi.fn>, sequence: string): number => getWrittenStrings(write).filter((w) => w === sequence).length;

        const sequences = (write: ReturnType<typeof vi.fn>): string[] => getWrittenStrings(write).filter((w) => w === POP || w === PUSH);

        const Toggle = ({ active }: { readonly active: boolean }): React.ReactNode => {
            useInput(() => {}, { isActive: active });

            return <Text>Hello</Text>;
        };

        const waitForRawModeOff = async (stdin: NodeJS.ReadStream): Promise<void> => {
            await waitFor(() => (stdin.setRawMode as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0] === false));
        };

        it("auto mode - never queries when nothing enables raw mode", async () => {
            expect.assertions(1);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();

            const { unmount } = render(<Text>Hello</Text>, { interactive: true, kittyKeyboard: { mode: "auto" }, stdin, stdout });

            await new Promise((resolve) => {
                setTimeout(resolve, 260);
            });

            expect(count(write, QUERY)).toBe(0);

            unmount();
        });

        it("auto mode - queries once raw mode is on and pushes flags when the terminal answers", async () => {
            expect.assertions(3);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();

            const { rerender, unmount } = render(<Toggle active={false} />, { interactive: true, kittyKeyboard: { mode: "auto" }, stdin, stdout });

            expect(count(write, QUERY)).toBe(0);

            rerender(<Toggle active />);

            await waitFor(() => count(write, QUERY) === 1);

            (stdin.read as ReturnType<typeof vi.fn>).mockReturnValueOnce("\u001B[?1u");
            stdin.emit("readable");

            await waitFor(() => count(write, PUSH) === 1);

            expect(count(write, QUERY)).toBe(1);

            unmount();

            expect(count(write, POP)).toBe(1);
        });

        it("auto mode - asks again when raw mode went away while the query was open", async () => {
            expect.assertions(2);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();

            const { rerender, unmount } = render(<Toggle active />, { interactive: true, kittyKeyboard: { mode: "auto" }, stdin, stdout });

            await waitFor(() => count(write, QUERY) === 1);

            rerender(<Toggle active={false} />);
            await waitForRawModeOff(stdin);

            rerender(<Toggle active />);
            await waitFor(() => count(write, QUERY) === 2);

            (stdin.read as ReturnType<typeof vi.fn>).mockReturnValueOnce("\u001B[?1u");
            stdin.emit("readable");

            await waitFor(() => count(write, PUSH) === 1);

            expect(count(write, QUERY)).toBe(2);

            unmount();

            expect(count(write, POP)).toBe(1);
        });

        it("auto mode - a query that times out leaves the protocol off", async () => {
            expect.assertions(2);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();

            const { unmount } = render(<Toggle active />, { interactive: true, kittyKeyboard: { mode: "auto" }, stdin, stdout });

            await waitFor(() => count(write, QUERY) === 1);
            await new Promise((resolve) => {
                setTimeout(resolve, 260);
            });

            expect(count(write, PUSH)).toBe(0);

            unmount();

            expect(count(write, POP)).toBe(0);
        });

        it("enabled mode - writes nothing while raw mode is off", () => {
            expect.assertions(2);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();

            const { unmount } = render(<Text>Hello</Text>, { kittyKeyboard: { mode: "enabled" }, stdin, stdout });

            expect(count(write, PUSH)).toBe(0);

            unmount();

            expect(count(write, POP)).toBe(0);
        });

        it("enabled mode - pops when the last consumer goes away and pushes again when one returns", async () => {
            expect.assertions(5);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();

            const { rerender, unmount } = render(<Toggle active />, { kittyKeyboard: { mode: "enabled" }, stdin, stdout });

            expect(count(write, PUSH)).toBe(1);

            rerender(<Toggle active={false} />);
            await waitForRawModeOff(stdin);

            expect(count(write, POP)).toBe(1);

            rerender(<Toggle active />);

            expect(count(write, PUSH)).toBe(2);

            unmount();

            expect(count(write, POP)).toBe(2);
            expect(sequences(write)).toStrictEqual([PUSH, POP, PUSH, POP]);
        });

        it("enabled mode - pops exactly once when the app exits through useApp().exit()", async () => {
            expect.assertions(1);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();

            const Quitter = (): React.ReactNode => {
                const { exit } = useApp();

                useInput((input) => {
                    if (input === "q") {
                        exit();
                    }
                });

                return <Text>Hello</Text>;
            };

            const { waitUntilExit } = render(<Quitter />, { kittyKeyboard: { mode: "enabled" }, stdin, stdout });

            (stdin.read as ReturnType<typeof vi.fn>).mockReturnValueOnce("q");
            stdin.emit("readable");

            await waitUntilExit();

            expect(count(write, POP)).toBe(1);
        });

        it("enabled mode - pops while suspended and pushes again once on resume", async () => {
            expect.assertions(3);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();
            const state: { suspend?: ReturnType<typeof useApp>["suspendTerminal"] } = {};

            const App = (): React.ReactNode => {
                state.suspend = useApp().suspendTerminal;
                useInput(() => {});

                return <Text>Hello</Text>;
            };

            const { unmount } = render(<App />, { interactive: true, kittyKeyboard: { mode: "enabled" }, stdin, stdout });

            expect(sequences(write)).toStrictEqual([PUSH]);

            await state.suspend?.(() => {
                expect(sequences(write)).toStrictEqual([PUSH, POP]);
            });

            expect(sequences(write)).toStrictEqual([PUSH, POP, PUSH]);

            unmount();
        });

        it("enabled mode - stays off after resume when the last consumer left in the same commit as the suspend", async () => {
            expect.assertions(1);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();
            const state: { resume?: () => Promise<void> } = {};

            const Editor = ({ active }: { readonly active: boolean }): React.ReactNode => {
                const { suspendTerminal } = useApp();

                useInput(() => {}, { isActive: active });

                React.useEffect(() => {
                    if (!active) {
                        void suspendTerminal().then((suspension) => {
                            state.resume = suspension.resume;
                        });
                    }
                }, [active, suspendTerminal]);

                return <Text>Hello</Text>;
            };

            const { rerender, unmount } = render(<Editor active />, { interactive: true, kittyKeyboard: { mode: "enabled" }, stdin, stdout });

            rerender(<Editor active={false} />);

            await waitFor(() => state.resume !== undefined);
            await state.resume?.();

            unmount();

            expect(sequences(write)).toStrictEqual([PUSH, POP]);
        });

        it("enabled mode - keeps the protocol off for a consumer that only mounts while suspended", async () => {
            expect.assertions(3);

            const { stdout, write } = createFakeStdout();
            const stdin = createFakeStdin();
            const state: { resume?: () => Promise<void> } = {};

            const Probe = ({ active }: { readonly active: boolean }): React.ReactNode => {
                const { suspendTerminal } = useApp();

                React.useEffect(() => {
                    void suspendTerminal().then((suspension) => {
                        state.resume = suspension.resume;
                    });
                }, [suspendTerminal]);

                useInput(() => {}, { isActive: active });

                return <Text>Hello</Text>;
            };

            const { rerender, unmount } = render(<Probe active={false} />, { interactive: true, kittyKeyboard: { mode: "enabled" }, stdin, stdout });

            await waitFor(() => state.resume !== undefined);

            rerender(<Probe active />);

            expect(count(write, PUSH)).toBe(0);

            await state.resume?.();

            expect(count(write, PUSH)).toBe(1);

            unmount();

            expect(count(write, POP)).toBe(1);
        });
    });
});
