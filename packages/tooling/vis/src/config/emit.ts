// `vis __emit-config <config-file> --out <file>` — evaluates a `vis.config.*` and writes the
// result as canonical JSON, for the native CLI (`native/cli/src/config_cache.rs`) to cache.
//
// Besides the config, the result lists everything the evaluation depended on (files read,
// directories listed, environment variables read), so the native side can tell without Node
// whether a cached copy is still valid. It also lists anything it could not track (network,
// child processes, printed output, values JSON cannot hold), which keeps the result from being
// cached or, for values that are not data, from being used natively at all.
//
// Lean entry (see `bin.ts`): it loads no command module.

import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { observeModuleLoads, registerTsHooks } from "../runtime/ts-loader";
import { loadMergedVisConfig } from "./config";

/** Bump when the shape of {@link EmittedConfig} changes; the native reader refuses other versions. */
const EMIT_VERSION = 1;

type TrackedKind = "dir" | "exists" | "file";

interface TrackedPath {
    kind: TrackedKind;
    path: string;
}

interface EmittedConfig {
    /** The merged user config (no secure defaults). Absent when `nonData` is not empty. */
    config?: unknown;
    env: string[];
    files: TrackedPath[];
    /** Paths of values JSON cannot hold (functions, `Date`, `NaN`, …). The native side leaves such a config to Node. */
    nonData: string[];
    status: "node-only" | "ok";
    /** Reasons the result must not be reused on a later run. */
    uncacheable: string[];
    version: number;
}

const KIND_RANK: Record<TrackedKind, number> = { dir: 2, exists: 0, file: 1 };

/** Original function references, taken before anything is patched. */
const original = {
    environment: process.env,
    existsSync: fs.existsSync,
    realpathSync: fs.realpathSync,
    writeFileSync: fs.writeFileSync,
};

const toPath = (value: unknown): string | undefined => {
    try {
        if (typeof value === "string") {
            return resolve(value);
        }

        if (value instanceof URL) {
            return fileURLToPath(value);
        }

        if (Buffer.isBuffer(value)) {
            return resolve(value.toString());
        }
    } catch {
        return undefined;
    }

    return undefined;
};

/** The `package.json` that owns a file inside `node_modules`, so an upgrade invalidates without hashing the package. */
const owningManifest = (path: string): string | undefined => {
    const marker = `${sep}node_modules${sep}`;
    const index = path.lastIndexOf(marker);

    if (index === -1) {
        return undefined;
    }

    let directory = dirname(path);
    const floor = path.slice(0, index + marker.length);

    while (directory.length > floor.length) {
        const candidate = join(directory, "package.json");

        if (original.existsSync(candidate)) {
            return candidate;
        }

        directory = dirname(directory);
    }

    return undefined;
};

interface Tracker {
    env: Set<string>;
    files: Map<string, TrackedKind>;
    stop: () => void;
    uncacheable: Set<string>;
}

const FS_PATH_FIRST: Record<string, TrackedKind> = {
    access: "exists",
    accessSync: "exists",
    createReadStream: "file",
    exists: "exists",
    existsSync: "exists",
    lstat: "exists",
    lstatSync: "exists",
    open: "file",
    opendir: "dir",
    opendirSync: "dir",
    openSync: "file",
    readdir: "dir",
    readdirSync: "dir",
    readFile: "file",
    readFileSync: "file",
    stat: "exists",
    statSync: "exists",
};

/** File APIs whose results cannot be attributed to a path, so a config using them is not reusable. */
const UNTRACKED_READS = ["glob", "globSync"];

const FLAGGED: [object, string, string][] = [
    [childProcess, "spawn", "starts a process"],
    [childProcess, "spawnSync", "starts a process"],
    [childProcess, "exec", "starts a process"],
    [childProcess, "execSync", "starts a process"],
    [childProcess, "execFile", "starts a process"],
    [childProcess, "execFileSync", "starts a process"],
    [childProcess, "fork", "starts a process"],
    [http, "request", "uses the network"],
    [http, "get", "uses the network"],
    [https, "request", "uses the network"],
    [https, "get", "uses the network"],
    [net, "connect", "uses the network"],
    [net, "createConnection", "uses the network"],
    [globalThis, "fetch", "uses the network"],
];

/**
 * Start recording what the evaluation reads. Patches are installed on the shared builtin module
 * objects and removed by `stop`; the user's config is the only code that runs while they are active
 * apart from vis's own loader, whose reads (the config files themselves) belong in the list anyway.
 */
const startTracking = (): Tracker => {
    const files = new Map<string, TrackedKind>();
    const env = new Set<string>();
    const uncacheable = new Set<string>();
    const restore: (() => void)[] = [];

    const record = (path: string | undefined, kind: TrackedKind): void => {
        if (path === undefined) {
            return;
        }

        const manifest = owningManifest(path);
        const target = manifest ?? path;
        const effective = manifest === undefined ? kind : "file";
        const known = files.get(target);

        if (known === undefined || KIND_RANK[effective] > KIND_RANK[known]) {
            files.set(target, effective);
        }
    };

    const patch = (target: Record<string, unknown>, name: string, wrap: (inner: (...arguments_: unknown[]) => unknown) => (...arguments_: unknown[]) => unknown): void => {
        const inner = target[name];

        if (typeof inner !== "function") {
            return;
        }

        target[name] = wrap(inner as (...arguments_: unknown[]) => unknown);
        restore.push(() => {
            target[name] = inner;
        });
    };

    for (const [name, kind] of Object.entries(FS_PATH_FIRST)) {
        for (const target of [fs, fs.promises] as Record<string, unknown>[]) {
            patch(target, name, (inner) => function wrapped(this: unknown, ...arguments_: unknown[]) {
                record(toPath(arguments_[0]), kind);

                return inner.apply(this, arguments_);
            });
        }
    }

    for (const name of UNTRACKED_READS) {
        for (const target of [fs, fs.promises] as Record<string, unknown>[]) {
            patch(target, name, (inner) => function wrapped(this: unknown, ...arguments_: unknown[]) {
                uncacheable.add("reads files in a way that cannot be tracked");

                return inner.apply(this, arguments_);
            });
        }
    }

    for (const [target, name, reason] of FLAGGED) {
        patch(target as Record<string, unknown>, name, (inner) => function wrapped(this: unknown, ...arguments_: unknown[]) {
            uncacheable.add(reason);

            return inner.apply(this, arguments_);
        });
    }

    for (const stream of [process.stdout, process.stderr]) {
        patch(stream as unknown as Record<string, unknown>, "write", (inner) => function wrapped(this: unknown, ...arguments_: unknown[]) {
            uncacheable.add("prints output");

            return inner.apply(this, arguments_);
        });
    }

    const unobserve = observeModuleLoads((path) => {
        record(path, "file");
    });

    process.env = new Proxy(original.environment, {
        get(target, key, receiver) {
            if (typeof key === "string") {
                env.add(key);
            }

            return Reflect.get(target, key, receiver) as unknown;
        },
        getOwnPropertyDescriptor(target, key) {
            if (typeof key === "string") {
                env.add(key);
            }

            return Reflect.getOwnPropertyDescriptor(target, key);
        },
        has(target, key) {
            if (typeof key === "string") {
                env.add(key);
            }

            return Reflect.has(target, key);
        },
        ownKeys(target) {
            uncacheable.add("lists every environment variable");

            return Reflect.ownKeys(target);
        },
    });

    syncBuiltinESMExports();

    return {
        env,
        files,
        stop: () => {
            process.env = original.environment;
            unobserve();

            for (const undo of restore.toReversed()) {
                undo();
            }

            syncBuiltinESMExports();
        },
        uncacheable,
    };
};

/** Paths of values a JSON copy would change or drop, for example functions in `plugins`. */
const findNonData = (value: unknown, path: string, found: string[], seen: Set<object>): void => {
    switch (typeof value) {
        case "boolean":
        case "string": {
            return;
        }
        case "number": {
            if (!Number.isFinite(value)) {
                found.push(path);
            }

            return;
        }
        case "object": {
            if (value === null) {
                return;
            }

            if (seen.has(value)) {
                found.push(path);

                return;
            }

            const prototype = Object.getPrototypeOf(value) as object | null;
            const isArray = Array.isArray(value);

            if (!isArray && prototype !== Object.prototype && prototype !== null) {
                found.push(path);

                return;
            }

            seen.add(value);

            for (const [key, item] of Object.entries(value)) {
                findNonData(item, isArray ? `${path}[${key}]` : `${path}.${key}`, found, seen);
            }

            seen.delete(value);

            return;
        }
        case "undefined": {
            // JSON drops the key, which reads the same as an absent key.
            return;
        }
        default: {
            found.push(path);
        }
    }
};

/**
 * Evaluate the config at `configPath` and describe the result. Throws what the Node loader throws,
 * so a config that fails to load fails here the same way.
 */
export const emitConfig = async (configPath: string): Promise<EmittedConfig> => {
    const absolute = resolve(configPath);
    const uncacheableFromStart: string[] = [];

    if (!registerTsHooks()) {
        uncacheableFromStart.push("Node has no module hooks, so imports cannot be tracked");
    }

    const tracker = startTracking();

    let merged: unknown;

    try {
        merged = await loadMergedVisConfig(dirname(absolute), { explicitConfigPath: absolute });
    } finally {
        tracker.stop();
    }

    tracker.files.set(absolute, "file");

    const nonData: string[] = [];

    findNonData(merged, "$", nonData, new Set());

    const files: TrackedPath[] = [...tracker.files]
        .map(([path, kind]) => { return { kind, path: safeRealPath(path) ?? path }; })
        .sort((a, b) => a.path.localeCompare(b.path));

    return {
        ...(nonData.length === 0 ? { config: merged } : {}),
        env: [...tracker.env].sort(),
        files,
        nonData,
        status: nonData.length === 0 ? "ok" : "node-only",
        uncacheable: [...uncacheableFromStart, ...tracker.uncacheable],
        version: EMIT_VERSION,
    };
};

const safeRealPath = (path: string): string | undefined => {
    try {
        return original.realpathSync(path);
    } catch {
        return undefined;
    }
};

/* eslint-disable unicorn/no-process-exit -- CLI entry: the exit code is the contract with the native caller */

/** Entry for `vis __emit-config &lt;config-file> --out &lt;file>`. Exits 1 with the loader's error text when the config does not load. */
export const runEmitConfig = async (argv: string[]): Promise<void> => {
    const outIndex = argv.indexOf("--out");
    const configPath = argv[0];
    const out = outIndex === -1 ? undefined : argv[outIndex + 1];

    if (configPath === undefined || configPath.startsWith("-") || out === undefined) {
        process.stderr.write("usage: vis __emit-config <config-file> --out <file>\n");
        process.exit(2);
    }

    try {
        const emitted = await emitConfig(configPath);

        original.writeFileSync(out, JSON.stringify(emitted));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exit(1);
    }
};
