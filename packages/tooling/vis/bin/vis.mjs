/* eslint-disable unicorn/no-process-exit -- CLI entry: exit codes are forwarded from the native binary */
// Native front-end launcher for `vis`, used when the install script did not put
// the native executable at `bin/vis` (see `bin/vis` and `scripts/install-native.cjs`).
// `bin/vis` imports this file; run it directly with `node bin/vis.mjs`.
//
// Its only jobs are to (1) route the natively-implemented commands (and the help
// surface) to the platform Rust binary, and (2) fall through to the existing
// in-process Node CLI for everything else. The fall-through path is byte-identical
// to running `dist/bin.js` directly, so the launcher adds no extra Node boot for
// delegated commands: it `import()`s the same entry in the same process.
//
// As commands are ported off Node, their names are added to NATIVE_COMMANDS in
// `route.mjs` and the binary grows to handle them; the binary itself delegates
// anything it does not implement back to `dist/bin.js` via the VIS_* contract.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveNativeBinary } from "./resolve-binary.mjs";
import { routesToNative } from "./route.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Tells the CLI (and `vis doctor`) it was started through Node rather than the
// native executable that the install script normally puts at `bin/vis`.
process.env.VIS_LAUNCHER = "node";

// VIS_FALLBACK_ENTRY_OVERRIDE lets tests point the Node entry elsewhere. An inherited
// VIS_FALLBACK_ENTRY is deliberately ignored: a nested `vis` would otherwise run the entry
// of the install that started it. Production resolves the entry next to this package.
const fallbackEntry = process.env.VIS_FALLBACK_ENTRY_OVERRIDE ?? join(packageRoot, "dist", "bin.js");

const userArguments = process.argv.slice(2);

if (routesToNative(userArguments)) {
    const binary = resolveNativeBinary(packageRoot);

    if (binary !== undefined) {
        const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

        const { error, signal, status } = spawnSync(binary, userArguments, {
            env: {
                ...process.env,
                VIS_FALLBACK_ENTRY: fallbackEntry,
                VIS_HANDOFF: "launcher",
                VIS_LAUNCHER: "node",
                VIS_NODE: process.execPath,
                VIS_VERSION: version,
            },
            stdio: "inherit",
        });

        if (error) {
            // Binary unusable (e.g. corrupt install) — fall through to Node.
            process.env.VIS_NATIVE_BIN_FAILED = "1";
        } else if (signal) {
            // Signal-terminated: follow the shell convention (128 + signal number)
            // so the exit code matches the binary's own delegation path.
            process.exit(128 + (constants.signals[signal] ?? 1));
        } else {
            process.exit(status ?? 1);
        }
    }
    // No binary for this platform: fall through to the Node CLI below.
}

// In-process Node CLI. Same module graph and behaviour as invoking dist/bin.js
// directly — no extra process boot. fallbackEntry is an internally-resolved path
// (never user input); pathToFileURL keeps the dynamic import valid on Windows.
// eslint-disable-next-line no-unsanitized/method -- fallbackEntry is resolved internally, not from user input
await import(pathToFileURL(fallbackEntry).href);
