// Asks the launcher's routing table (`bin/route.mjs`) where it sends each invocation, and lists the names the table
// knows. Used by run-commands.sh so the suite follows the table: a scenario the launcher does not hand to the native
// binary is reported as such instead of being timed as if it were native.
//
//   node run-commands-routes.mjs <package root> route '<json: [{ "args": [...], "cwd": "...", "env": {...} }]>'
//   node run-commands-routes.mjs <package root> names
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, mode, payload] = process.argv.slice(2);
const routePath = join(root, "bin", "route.mjs");

if (mode === "route") {
    const { routesToNative } = await import(pathToFileURL(routePath).href);
    const cases = JSON.parse(payload);

    console.log(JSON.stringify(cases.map(({ args, cwd, env }) => routesToNative(args, process.platform, env, cwd, false))));
} else if (mode === "names") {
    // The command names of the routing table: `NATIVE_COMMANDS`, the keys of `NATIVE_SHAPE_GATES`, the extras of `alwaysNative`.
    const source = readFileSync(routePath, "utf8");
    const names = new Set();
    const set = /const NATIVE_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(source);

    for (const match of set?.[1].matchAll(/"([^"]+)"/g) ?? []) {
        names.add(match[1]);
    }

    const gates = source.slice(source.indexOf("const NATIVE_SHAPE_GATES = new Map(["), source.indexOf("// The routing of a bare command group"));

    for (const match of gates.matchAll(/^ {4}\[(?:\n\s+)?"([\w-]+)",/gm)) {
        names.add(match[1]);
    }

    const always = source.slice(source.indexOf("const alwaysNative"), source.indexOf("const NATIVE_SHAPE_GATES"));

    for (const match of always.matchAll(/(?<![A-Za-z])command === "([\w-]+)"/g)) {
        names.add(match[1]);
    }

    console.log([...names].sort().join("\n"));
} else {
    console.error("usage: run-commands-routes.mjs <package root> route|names [json]");
    process.exit(2);
}
