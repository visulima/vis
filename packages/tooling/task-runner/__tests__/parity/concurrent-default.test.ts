/**
 * `runConcurrently` end to end.
 *
 * The behaviour suite calls the native runner directly. This file goes through the public entry
 * point with the cases a caller combines (`onEvent`, piped stdin, a pty, `inheritEnv: false`, `restart`).
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runConcurrently } from "../../src/concurrent";
import type { ProcessEvent } from "../../src/types";

const posix = process.platform !== "win32";
const probe = fileURLToPath(new URL("fixtures/probe.cjs", import.meta.url));
const quote = (value: string): string => (posix ? `'${value.replaceAll("'", String.raw`'\''`)}'` : `"${value}"`);
const probeCommand = (...arguments_: string[]): string => [process.execPath, probe, ...arguments_].map((value) => quote(value)).join(" ");

const lines = (events: ProcessEvent[], kind: "stderr" | "stdout", index = 0): string[] =>
    events.flatMap((event) => (event.kind === kind && event.index === index ? [event.text] : []));

describe("runConcurrently", () => {
    it("should stream events in order and resolve after the last one", async () => {
        expect.assertions(4);

        const events: ProcessEvent[] = [];
        const result = await runConcurrently([{ command: probeCommand("out", "hello"), name: "greeter" }], { onEvent: (event) => events.push(event) });

        expect(result).toMatchObject({ success: true });
        expect(events[0]?.kind).toBe("started");
        expect(lines(events, "stdout")).toStrictEqual(["hello"]);
        expect(events.at(-1)).toMatchObject({ commandName: "greeter", exitCode: 0, kind: "close" });
    });

    it("should run without onEvent", async () => {
        expect.assertions(1);

        await expect(runConcurrently([probeCommand("out", "quiet")], { killOthers: ["failure"] })).resolves.toMatchObject({ success: true });
    });

    it("should write to a piped stdin from the started event", async () => {
        expect.assertions(2);

        const events: ProcessEvent[] = [];
        const result = await runConcurrently([{ command: probeCommand("read-line"), stdin: "pipe" }], {
            onEvent: (event) => {
                events.push(event);

                if (event.kind === "started") {
                    event.write?.("ping\n");
                }
            },
        });

        expect(result.success).toBe(true);
        expect(lines(events, "stdout")).toStrictEqual(["got:ping"]);
    });

    it("should give a command with inheritEnv: false only the caller's variables", async () => {
        expect.assertions(1);

        process.env["DEFAULT_RUNNER_PARENT_ONLY"] = "leak";

        try {
            const events: ProcessEvent[] = [];
            const env = posix ? {} : Object.fromEntries(["COMSPEC", "PATH", "PATHEXT", "SystemRoot"].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));

            await runConcurrently([{ command: probeCommand("env", "DEFAULT_RUNNER_PARENT_ONLY", "DEFAULT_RUNNER_OWN"), env: { ...env, DEFAULT_RUNNER_OWN: "own" }, inheritEnv: false }], {
                onEvent: (event) => events.push(event),
            });

            expect(JSON.parse(lines(events, "stdout")[0] ?? "{}")).toStrictEqual({ DEFAULT_RUNNER_OWN: "own", DEFAULT_RUNNER_PARENT_ONLY: null });
        } finally {
            Reflect.deleteProperty(process.env, "DEFAULT_RUNNER_PARENT_ONLY");
        }
    });

    it.skipIf(!posix || spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0)("should run a pty command with a terminal on stdout", async () => {
        expect.assertions(2);

        const events: ProcessEvent[] = [];
        const result = await runConcurrently([{ command: probeCommand("tty"), stdin: "pty" }], { onEvent: (event) => events.push(event) });
        const output = lines(events, "stdout").join("").replaceAll("\r", "");

        expect(result.success).toBe(true);
        expect(output).toContain("tty:true:true");
    });

    it("should retry a failing command through restart", async () => {
        expect.assertions(3);

        const attempts: number[] = [];
        const result = await runConcurrently([probeCommand("exit", "3")], {
            restart: {
                delay: 0,
                onRetry: (attempt) => {
                    attempts.push(attempt);
                },
                tries: 2,
            },
        });

        expect(attempts).toStrictEqual([1, 2]);
        expect(result.success).toBe(false);
        expect(result.closeEvents.at(-1)?.exitCode).toBe(3);
    });

    it("should kill the others when one fails", async () => {
        expect.assertions(2);

        const result = await runConcurrently([probeCommand("exit", "1"), probeCommand("hang")], { killOthers: ["failure"], killTimeout: 1000 });
        const byIndex = new Map(result.closeEvents.map((event) => [event.index, event]));

        expect(byIndex.get(0)?.exitCode).toBe(1);
        expect(byIndex.get(1)?.killed).toBe(true);
    });
});
