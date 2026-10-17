import { beforeEach, describe, expect, it, vi } from "vitest";

const runExecute = vi.hoisted(() => vi.fn());

vi.mock(import("../../../src/commands/run/handler"), () => { return { default: runExecute }; });

const { default: devExecute } = await import("../../../src/commands/dev/handler");
const { default: buildExecute } = await import("../../../src/commands/build/handler");

const toolbox = (argument: string[] | undefined, rawUnknown: string[] | undefined, options: Record<string, unknown> = {}) =>
    ({ argument, logger: {}, options, rawUnknown }) as never;

describe("vis dev and vis build", () => {
    beforeEach(() => {
        runExecute.mockReset();
    });

    it("runs the dev target through the run handler", async () => {
        expect.assertions(1);

        await devExecute(toolbox(undefined, undefined));

        expect(runExecute.mock.calls[0][0].argument).toStrictEqual(["dev"]);
    });

    it("forwards positional and flag arguments after the target", async () => {
        expect.assertions(1);

        await devExecute(toolbox(["web"], ["--port", "3000"]));

        expect(runExecute.mock.calls[0][0].argument).toStrictEqual(["dev", "web", "--port", "3000"]);
    });

    it("passes run's options through unchanged", async () => {
        expect.assertions(1);

        await buildExecute(toolbox(undefined, undefined, { filter: ["@org/web"], preflight: undefined }));

        expect(runExecute.mock.calls[0][0].options).toStrictEqual({ filter: ["@org/web"], preflight: undefined });
    });

    it("runs the build target", async () => {
        expect.assertions(1);

        await buildExecute(toolbox(undefined, ["--mode", "production"]));

        expect(runExecute.mock.calls[0][0].argument).toStrictEqual(["build", "--mode", "production"]);
    });
});
