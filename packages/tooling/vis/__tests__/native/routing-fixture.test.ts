import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { routesToNative } from "../../bin/route.mjs";

interface RoutingCase {
    args: string[];
    binary?: "native" | "node";
    directory?: string;
    env?: Record<string, string>;
    files?: Record<string, string>;
    interactive?: boolean;
    launcher: "native" | "node";
    note?: string;
    platform?: string;
}

// Shared with the binary's own test (`native/cli/tests/routing.rs`), which checks the `binary` side
// of every case, so a change to either side of the routing has to change this file.
const { cases } = JSON.parse(readFileSync(resolve(__dirname, "../../native/cli/tests/fixtures/routing.json"), "utf8")) as { cases: RoutingCase[] };

const cwd = "/work/app";

const describeCase = (routing: RoutingCase): string =>
    [routing.platform ?? "linux", routing.interactive ? "terminal" : undefined, routing.directory ? `in ${routing.directory}` : undefined, routing.env ? JSON.stringify(routing.env) : undefined, routing.files ? `with ${Object.keys(routing.files).join(", ")}` : undefined, `vis ${JSON.stringify(routing.args)}`]
        .filter(Boolean)
        .join(" ");

describe("launcher routing fixture (shared with native/cli/tests/routing.rs)", () => {
    it.each(cases.map((routing) => [describeCase(routing), routing] as const))("%s", (_label: string, routing: RoutingCase) => {
        expect.assertions(1);

        // The project root holds the only root marker; a case with a `directory` runs below it.
        const routed = routesToNative(
            routing.args,
            routing.platform ?? "linux",
            routing.env ?? {},
            routing.directory === undefined ? cwd : `${cwd}/${routing.directory}`,
            routing.interactive ?? false,
            (directory: string) => directory === cwd,
            // A case names the task cache it expects the project to have by listing a file in it.
            () => Object.keys(routing.files ?? {}).some((file) => file.startsWith("node_modules/.cache/vis/")),
        );

        expect(routed).toBe(routing.launcher === "native");
    });

    it("explains every case the launcher keeps in Node although the binary would answer it", () => {
        expect.assertions(1);

        const unexplained = cases.filter((routing) => routing.launcher === "node" && routing.binary === "native" && !routing.note).map((routing) => describeCase(routing));

        expect(unexplained).toStrictEqual([]);
    });
});
