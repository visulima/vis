import { describe, expect, it } from "vitest";

import { parseFilter } from "../../src/commands/run/filter";
import { validateConfig } from "../../src/staged/config";
import { buildTaskGraph } from "../../src/staged/tasks/build";
import { parseCommandString } from "../../src/staged/tasks/exec";
import { runTasks } from "../../src/staged/tasks/run";
import type { PatternDescriptor, Renderer, RunnerEvents } from "../../src/staged/types";

const cwd = "/repo";
const workspacePackages = ["/repo/packages/a", "/repo/packages/b", "/repo/packages/c"];
const visEntry = ["node", "/bin/vis.js"];

const build = async (config: Parameters<typeof buildTaskGraph>[0]["config"], files: string[]) =>
    buildTaskGraph({ config, cwd, files, visEntry, workspacePackages });

describe("staged dependsOn — task graph", () => {
    it("emits one leading prerequisite covering the owners of every entry that asks for it", async () => {
        expect.assertions(4);

        const patterns = await build(
            {
                "*.md": "prettier --write",
                "packages/a/**/*.ts": { command: "eslint --fix", dependsOn: ["^build"], perPackage: true },
                "packages/b/**/*.tsx": () => [{ command: "oxlint", dependsOn: ["^build"] }],
            },
            ["/repo/packages/a/src/index.ts", "/repo/packages/b/view.tsx", "/repo/packages/c/README.md"],
        );

        const [first, ...rest] = patterns;

        expect(first?.prerequisite).toBe(true);
        expect(first?.commands.map((command) => command.command)).toStrictEqual([
            "node /bin/vis.js run :build --if-present --no-preflight --skip-toolchain -F {packages/a}^... -F {packages/b}^...",
        ]);
        expect(first?.commands[0]?.verbatim).toBe(true);
        expect(rest.some((pattern) => pattern.prerequisite === true)).toBe(false);
    });

    it("produces selectors the run filter reads as dependencies-only path filters", async () => {
        expect.assertions(1);

        const patterns = await build({ "**/*.ts": { command: "eslint", dependsOn: ["^build"] } }, ["/repo/packages/a/src/index.ts"]);
        const selector = parseCommandString(patterns[0]?.commands[0]?.command ?? "").at(-1) ?? "";

        expect(parseFilter(selector)).toMatchObject({ excludeSelf: true, includeDependencies: true, isPath: true, pattern: "packages/a" });
    });

    it("adds no prerequisite when every matched file sits outside the workspace packages", async () => {
        expect.assertions(2);

        const patterns = await build({ "**/*.ts": { command: "eslint", dependsOn: ["^build"] } }, ["/repo/scripts/release.ts"]);

        expect(patterns).toHaveLength(1);
        expect(patterns[0]?.prerequisite).toBeUndefined();
    });

    it("quotes a workspace path that would otherwise split into several arguments", async () => {
        expect.assertions(1);

        const patterns = await buildTaskGraph({
            config: { "**/*.ts": { command: "eslint", dependsOn: ["^build"] } },
            cwd,
            files: ["/repo/my packages/a/index.ts"],
            visEntry,
            workspacePackages: ["/repo/my packages/a"],
        });

        expect(parseCommandString(patterns[0]?.commands[0]?.command ?? "").slice(-2)).toStrictEqual(["-F", "{my packages/a}^..."]);
    });

    it("emits one prerequisite per target, in the order the entries name them", async () => {
        expect.assertions(1);

        const patterns = await build(
            {
                "*.ts": { command: "eslint", dependsOn: ["^build"] },
                "*.tsx": { command: "oxlint", dependsOn: ["^type-check:emit"] },
            },
            ["/repo/packages/a/x.ts", "/repo/packages/a/y.tsx"],
        );

        expect(patterns.filter((pattern) => pattern.prerequisite).map((pattern) => parseCommandString(pattern.commands[0]?.command ?? "")[3])).toStrictEqual([
            ":build",
            ":type-check:emit",
        ]);
    });

    it("warns and builds nothing when no workspace packages were resolved", async () => {
        expect.assertions(2);

        const warnings: string[] = [];
        const patterns = await buildTaskGraph({
            config: { "**/*.ts": { command: "eslint", dependsOn: ["^build"] } },
            cwd,
            files: ["/repo/packages/a/x.ts"],
            visEntry,
            warn: (message) => {
                warnings.push(message);
            },
            workspacePackages: [],
        });

        expect(patterns.some((pattern) => pattern.prerequisite === true)).toBe(false);
        expect(warnings).toHaveLength(1);
    });
});

describe("staged dependsOn — validation", () => {
    it("accepts the dependency form", () => {
        expect.assertions(1);

        expect(() => validateConfig({ "*.ts": { command: "eslint", dependsOn: ["^build"] } })).not.toThrow();
    });

    it.each([[["build"]], [[{ target: "build" }]], ["^build"], [["^--help"]], [["^:build"]]])("rejects %j", (dependsOn) => {
        expect.assertions(1);

        expect(() => validateConfig({ "*.ts": { command: "eslint", dependsOn } })).toThrow(/dependsOn/u);
    });
});

const recordingRenderer = (): { ends: RunnerEvents["commandEnd"][]; renderer: Renderer } => {
    const ends: RunnerEvents["commandEnd"][] = [];
    const noop = (): void => {};

    return {
        ends,
        renderer: {
            commandEnd: (payload) => {
                ends.push(payload);
            },
            commandStart: noop,
            error: noop,
            info: noop,
            patternEnd: noop,
            patternStart: noop,
            start: noop,
            stop: noop,
            warn: noop,
        },
    };
};

const pattern = (id: string, run: () => unknown, prerequisite = false): PatternDescriptor => {
    return {
        commands: [{ files: [], id: `${id}-cmd`, run, source: "custom", title: id }],
        files: [],
        id,
        pattern: id,
        ...(prerequisite ? { prerequisite } : {}),
        title: id,
    };
};

describe("staged dependsOn — run order", () => {
    it("finishes the prerequisite before any other pattern starts, even with unbounded concurrency", async () => {
        expect.assertions(1);

        const log: string[] = [];
        let releaseBuild: () => void = () => {};
        const buildGate = new Promise<void>((resolve) => {
            releaseBuild = resolve;
        });

        const { renderer } = recordingRenderer();
        const run = runTasks(
            [
                pattern(
                    "build",
                    async () => {
                        log.push("build:start");
                        await buildGate;
                        log.push("build:end");
                    },
                    true,
                ),
                pattern("lint-a", () => log.push("lint-a")),
                pattern("lint-b", () => log.push("lint-b")),
            ],
            renderer,
            { concurrent: true, continueOnError: false, cwd },
        );

        releaseBuild();
        await run;

        expect(log.slice(0, 2)).toStrictEqual(["build:start", "build:end"]);
    });

    it("skips every other pattern when the prerequisite fails, even with continueOnError", async () => {
        expect.assertions(3);

        let linted = false;
        const { ends, renderer } = recordingRenderer();
        const result = await runTasks(
            [
                pattern(
                    "build",
                    () => {
                        throw new Error("build failed");
                    },
                    true,
                ),
                pattern("lint", () => {
                    linted = true;
                }),
            ],
            renderer,
            { concurrent: true, continueOnError: true, cwd },
        );

        expect(result.failedCommands).toStrictEqual(["build"]);
        expect(linted).toBe(false);
        expect(ends.find((end) => end.commandId === "lint-cmd")?.status).toBe("skipped");
    });
});
