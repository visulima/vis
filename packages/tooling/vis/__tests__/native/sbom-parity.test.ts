import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";
import { COLOUR_ENVIRONMENTS, COLOUR_VARIABLES, DELEGATED_COLOUR_ENVIRONMENTS } from "./colour-environments";
import { CONFIG_CASES, GRAPH_ONLY_CASES } from "./config-workspace-cases";

/**
 * `vis sbom` exists twice: the Node handler (`src/commands/sbom/handler.ts`, over the lockfile parser of
 * `@visulima/package` and the CycloneDX builder in `src/sbom/`) and the native path (`native/cli/src/sbom/`).
 * Every fixture below is built twice, once for each engine, and run with the same arguments and CI context.
 * stdout, stderr, the exit status and every file the run wrote must match, byte for byte, with two
 * exceptions that are random by design and are checked for their shape instead of their value (decision 2 of
 * plan 012: random fields are compared masked): the `serialNumber` (a version 4 UUID) and the `timestamp` (an ISO
 * date close to now) of the BOM, in the JSON and in the XML form, and pail's clock (`HH:MM:SS`) in the status
 * lines. The native run uses a copy of the binary outside the package and no
 * fallback entry, so a call the binary declines exits 70 and cannot pass for an answer.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const repositoryLockfile = join(packageRoot, "..", "..", "..", "pnpm-lock.yaml");

// ---------------------------------------------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const write = (root: string, path: string, content: string | Json): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : `${JSON.stringify(content, undefined, 2)}\n`);
};

type Algorithm = "sha256" | "sha384" | "sha512";

const sri = (algorithm: Algorithm, seed: string): string => `${algorithm}-${createHash(algorithm).update(seed).digest("base64")}`;

interface Pkg {
    /** Ranges under `peerDependencies` of the `packages:` entry (lockfile version 9 keeps them only there). */
    declaredPeers?: Record<string, string>;
    /** `dependencies` of the snapshot (version 9) or of the entry (version 6). */
    deps?: Record<string, string>;
    /** `false` writes no integrity, a string writes it as given. */
    integrity?: false | string;
    name: string;
    optional?: Record<string, string>;
    /** Peer suffix of the snapshot key, `(react@18.2.0)`. */
    suffix?: string;
    version: string;
}

const entries = (map: Record<string, string> | undefined, indent: string): string =>
    Object.entries(map ?? {})
        .map(([name, value]) => `${indent}${/^[@\d]/.test(name) || name.includes("/") ? `'${name}'` : name}: ${value}`)
        .join("\n");

const quote = (key: string): string => (key.startsWith("@") || key.includes("(") ? `'${key}'` : key);

const integrityOf = (pkg: Pkg): string | undefined => {
    if (pkg.integrity === false) {
        return undefined;
    }

    return pkg.integrity === undefined ? sri("sha512", `${pkg.name}@${pkg.version}`) : ["sha256", "sha384", "sha512"].includes(pkg.integrity) ? sri(pkg.integrity as Algorithm, `${pkg.name}@${pkg.version}`) : pkg.integrity;
};

/** A lockfile version 9 file: the `packages:` entries with their declared peers, then the `snapshots:`. */
const lockV9 = (packages: Pkg[], importers = "  .: {}\n"): string => {
    const section = packages
        .filter((pkg, index) => packages.findIndex((other) => other.name === pkg.name && other.version === pkg.version) === index)
        .map((pkg) => {
            const integrity = integrityOf(pkg);
            const lines = [`  ${quote(`${pkg.name}@${pkg.version}`)}:`, integrity ? `    resolution: {integrity: ${integrity}}` : "    resolution: {tarball: https://example.test/x.tgz}"];

            if (pkg.declaredPeers) {
                lines.push("    peerDependencies:", entries(pkg.declaredPeers, "      "));
            }

            return lines.join("\n");
        })
        .join("\n\n");

    const snapshots = packages
        .map((pkg) => {
            const lines = [`  ${quote(`${pkg.name}@${pkg.version}${pkg.suffix ?? ""}`)}:`];

            if (pkg.deps) {
                lines.push("    dependencies:", entries(pkg.deps, "      "));
            }

            if (pkg.optional) {
                lines.push("    optionalDependencies:", entries(pkg.optional, "      "));
            }

            return pkg.deps || pkg.optional ? lines.join("\n") : `${lines[0]} {}`;
        })
        .join("\n\n");

    return `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n${importers}\npackages:\n\n${section}\n\nsnapshots:\n\n${snapshots}\n`;
};

/** A lockfile version 6 file: the dependency maps sit inside the `packages:` entries, under keys that start with `/`. */
const lockV6 = (packages: Pkg[]): string => {
    const section = packages
        .map((pkg) => {
            const integrity = integrityOf(pkg);
            const lines = [`  /${pkg.name}@${pkg.version}${pkg.suffix ?? ""}:`, `    resolution: {integrity: ${integrity ?? "sha512-short"}}`];

            for (const [field, map] of [["dependencies", pkg.deps], ["peerDependencies", pkg.declaredPeers], ["optionalDependencies", pkg.optional]] as const) {
                if (map) {
                    lines.push(`    ${field}:`, entries(map, "      "));
                }
            }

            lines.push("    dev: false");

            return lines.join("\n");
        })
        .join("\n\n");

    return `lockfileVersion: '6.0'\n\nsettings:\n  autoInstallPeers: true\n\npackages:\n\n${section}\n`;
};

interface Workspace {
    lock: string;
    /** Project name to its `package.json`, under `packages/&lt;dir>`. */
    projects: Record<string, Json>;
    root?: Json;
}

const workspace = (root: string, spec: Workspace): void => {
    write(root, "package.json", spec.root ?? { name: "fixture", private: true, version: "1.0.0" });
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write(root, "pnpm-lock.yaml", spec.lock);

    for (const [directory, manifest] of Object.entries(spec.projects)) {
        write(root, `packages/${directory}/package.json`, manifest);
    }
};

const LEFT_PAD: Pkg[] = [
    { name: "left-pad", version: "1.0.0" },
    { integrity: "sha256", name: "left-pad", version: "1.3.0" },
    { integrity: "sha384", name: "left-pad", version: "2.0.0-beta.1" },
];

/** Project dependencies of every kind, scoped and unscoped, several versions of one package, and peer variants. */
const basic = (root: string): void => {
    workspace(root, {
        lock: lockV9([
            ...LEFT_PAD,
            { declaredPeers: { react: "^18.0.0" }, deps: { "left-pad": "1.3.0", react: "18.2.0" }, name: "@scope/pkg", suffix: "(react@18.2.0)", version: "2.1.0" },
            { deps: { "loose-envify": "1.4.0" }, name: "react", version: "18.2.0" },
            { name: "react", version: "17.0.2" },
            { deps: { "js-tokens": "4.0.0" }, name: "loose-envify", version: "1.4.0" },
            { name: "js-tokens", version: "4.0.0" },
            { integrity: "sha512", name: "fsevents", version: "2.3.3" },
            { name: "chokidar", optional: { fsevents: "2.3.3" }, version: "3.5.3" },
            { deps: { "left-pad": "1.0.0" }, name: "dev-only", version: "1.0.0" },
            { deps: { "js-tokens": "4.0.0" }, name: "optional-only", version: "1.0.0" },
            { integrity: false, name: "no-integrity", version: "1.0.0" },
            { integrity: "sha512-aGVsbG8=", name: "short-integrity", version: "1.0.0" },
            { integrity: "md5-AAAA", name: "md5-integrity", version: "1.0.0" },
            { name: "Upper-Case", version: "1.0.0-RC.1" },
            { name: "dotted.name_x", version: "1.0.0+build.5" },
            { name: "@Scope/Mixed", version: "2.0.0-Beta" },
        ]),
        projects: {
            a: { dependencies: { "@fixture/b": "workspace:*", "@scope/pkg": "^2.0.0", "left-pad": "^1.0.0" }, devDependencies: { "dev-only": "1.0.0" }, name: "@fixture/a", optionalDependencies: { chokidar: "~3.5.0", "optional-only": "1.0.0" }, version: "1.2.3" },
            b: { bin: "x.js", dependencies: { "@Scope/Mixed": "2.0.0-Beta", "dotted.name_x": "1.0.0+build.5", "left-pad": "~1.3.0", react: "^17.0.0 || ^18.0.0", "Upper-Case": "1.0.0-RC.1" }, name: "@fixture/b", peerDependencies: { "md5-integrity": ">=1", "no-integrity": "*", "short-integrity": "1.x" }, version: "0.0.1" },
        },
    });
};

/** Dependencies resolved through the range grammar, and the ways a range does not resolve. */
const ranges = (root: string): void => {
    const versions = ["0.0.3", "0.1.0", "0.1.5", "0.2.0", "1.0.0", "1.2.3", "1.9.9", "2.0.0", "2.0.0-rc.1", "10.1.0"];

    workspace(root, {
        lock: lockV9(["caret", "tilde", "gte", "lt", "star", "or", "xrange", "pre", "tag", "exact", "empty", "protocol", "missing-fallback", "hyphen", "spaced"].flatMap((name) => versions.map((version): Pkg => { return { integrity: false, name, version }; }))),
        projects: {
            a: {
                dependencies: { caret: "^1.2.0", empty: "", exact: "1.2.3", gte: ">=1.0.0 <2.0.0", hyphen: "1.2 - 1.9", lt: "<1.9.9", or: "^0.1.0 || ^10.0.0", pre: "^2.0.0-rc.0", spaced: ">= 0.1.5 < 2", star: "*", tag: "latest", tilde: "~0.1.0", xrange: "1.x" },
                devDependencies: { protocol: "workspace:^" },
                name: "ranges-a",
                optionalDependencies: { "missing-fallback": "catalog:" },
                version: "1.0.0",
            },
            b: { dependencies: { caret: "^0.0.3", exact: "npm:1.9.9", gte: ">1", hyphen: "2.x - 3.x", lt: "<=0.1", or: "0.0.x", spaced: "^ 1.2.3", star: "x", tilde: "~1" }, name: "ranges-b", version: "1.0.0" },
        },
    });
};

/** Aliases, patched dependencies, peer suffixes, and resolutions the parser has to skip. */
const resolutions = (root: string): void => {
    const lock = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .: {}

patchedDependencies:
  patched@1.0.0:
    hash: abc123
    path: patches/patched@1.0.0.patch

packages:

  string-width@4.2.3:
    resolution: {integrity: ${sri("sha512", "sw")}}
    engines: {node: '>=8'}

  string-width@5.1.2:
    resolution: {integrity: ${sri("sha512", "sw5")}}

  patched@1.0.0:
    resolution: {integrity: ${sri("sha512", "patched")}}

  'react-dom@18.2.0':
    resolution: {integrity: ${sri("sha512", "rd")}}
    peerDependencies:
      react: ^18.2.0

  react@18.2.0:
    resolution: {integrity: ${sri("sha512", "r")}}

  from-git@1.0.0:
    resolution: {commit: abc, repo: git+https://example.test/x.git, type: git}

  '@scope/tarball@https://codeload.example.test/x/tar.gz/abc':
    resolution: {tarball: https://codeload.example.test/x/tar.gz/abc}
    version: 1.0.0

  local@file:../local:
    resolution: {directory: ../local, type: directory}

  linked@link:../linked:
    resolution: {directory: ../linked, type: directory}

  wsp@workspace:packages/x:
    resolution: {directory: packages/x, type: directory}

snapshots:

  string-width@4.2.3: {}

  string-width@5.1.2: {}

  patched@1.0.0(patch_hash=abc123):
    dependencies:
      react: 18.2.0

  'react-dom@18.2.0(react@18.2.0)':
    dependencies:
      react: 18.2.0
      string-width-cjs: string-width@4.2.3
      string-width-esm: string-width@5.1.2(extra@1.0.0)
      'quoted-key': 18.2.0

  react@18.2.0: {}

  from-git@1.0.0: {}
`;

    workspace(root, {
        lock,
        projects: {
            a: { dependencies: { "from-git": "git+https://example.test/x.git", patched: "1.0.0", "react-dom": "^18.2.0", "string-width": "^4.2.3", "string-width-esm": "npm:string-width@^5.1.0" }, name: "aliases-a", version: "1.0.0" },
        },
    });
};

/** The lockfile of version 6, with dependency maps inside the entries. */
const legacy = (root: string): void => {
    workspace(root, {
        lock: lockV6([
            { deps: { "js-tokens": "4.0.0", "left-pad": "1.0.0" }, name: "loose-envify", version: "1.4.0" },
            { name: "js-tokens", version: "4.0.0" },
            { name: "left-pad", version: "1.0.0" },
            { declaredPeers: { react: "^17 || ^18" }, name: "uses-react", suffix: "(react@17.0.2)", version: "3.0.0" },
            { name: "react", version: "17.0.2" },
        ]),
        projects: { a: { dependencies: { "loose-envify": "^1.4.0", "uses-react": "3.0.0" }, name: "legacy-a", version: "1.0.0" } },
    });
};

/** Workspace projects that depend on each other, for `--focus`. */
const graph = (root: string): void => {
    workspace(root, {
        lock: lockV9([{ name: "lodash", version: "4.17.21" }, { name: "zod", version: "3.22.0" }, { deps: { zod: "3.22.0" }, name: "vitest", version: "1.0.0" }, { name: "peer-dep", version: "1.0.0" }]),
        projects: {
            "alpha-b": { name: "alpha-b", version: "1.0.0-beta.1+build.5" },
            app: { bin: { app: "x.js" }, dependencies: { "@fixture/lib": "workspace:*", lodash: "^4.0.0" }, devDependencies: { vitest: "^1.0.0" }, name: "@fixture/app", version: "1.0.0" },
            core: { dependencies: { zod: "^3.0.0" }, devDependencies: { "@fixture/app": "workspace:*" }, name: "@fixture/core", version: "0.1.0" },
            lib: { dependencies: { "@fixture/core": "workspace:*" }, name: "@fixture/lib", peerDependencies: { "peer-dep": "*" }, version: "2.0.0" },
            other: { dependencies: { lodash: "^4.0.0" }, name: "other", version: "9.9.9" },
            Zeta: { name: "Zeta" },
        },
    });
};

/** Description, author, licence and references of the root and of the projects, in every spelling the helper handles. */
const metadata = (root: string): void => {
    workspace(root, {
        lock: lockV9([{ name: "x", version: "1.0.0" }]),
        projects: {
            a: { author: "Jane <jane@example.test>", bugs: { url: "https://example.test/issues" }, description: "A project", homepage: "https://example.test", license: "MIT", name: "meta-a", repository: { type: "git", url: "git+https://example.test/a.git" }, version: "1.0.0" },
            b: { author: { email: "a@example.test", name: "Ann" }, bugs: "https://example.test/b", license: "(MIT OR Apache-2.0)", name: "meta-b", repository: "https://example.test/b.git" },
            c: { author: { name: "Only Name" }, license: { type: "ISC" }, name: "meta-c" },
            d: { author: { email: "x@example.test" }, licenses: [{ type: "Apache2" }, { type: "MIT" }], name: "meta-d" },
            e: { author: [], description: "", homepage: "", license: " mit ", name: "meta-e", repository: { url: "" } },
            f: { license: "UNLICENSED", name: "meta-f", version: "3.0.0" },
            g: { license: "SEE LICENSE IN LICENSE", name: "meta-g" },
            h: { license: "GPL-3.0 with exception", name: "meta-h" },
            i: { license: "bsd", name: "meta-i" },
            j: { license: "blueoak-1.0.0", name: "meta-j" },
            k: { license: 5, licenses: [{ type: "0BSD" }], name: "meta-k" },
            l: { author: 5, bugs: ["x"], description: null, license: { type: 5 }, name: "meta-l", repository: 7, version: null },
            m: { license: "Public Domain", name: "meta-m" },
            n: { license: "MIT AND ISC", name: "meta-n" },
            o: { license: "or", name: "meta-o" },
            p: { license: "Band", name: "meta-p" },
            q: { description: "Caf\u00E9 \u2615 \"quoted\" back\\slash\ttab\nnew \u0001 \u007F \u2028 \uD83D\uDE00", name: "meta-q", version: "0.0.1" },
        },
        root: { author: "Root Author", bugs: "https://example.test/root", description: "The root", homepage: "https://example.test/root", license: "Apache-2.0", name: "@fixture/root", repository: "https://example.test/root.git", version: "4.5.6" },
    });
};

const LICENSE_VARIANTS = ["MIT", "Apache-2.0", "(MIT OR Apache-2.0)", "weird custom", { type: "BSD-3-Clause" }];

/** Registry packages with installed copies: the virtual store (exact and peer-suffixed directories) and the hoisted fallback. */
const installed = (root: string): void => {
    const packages: Pkg[] = [
        { name: "left-pad", version: "1.3.0" },
        { deps: { "left-pad": "1.3.0" }, name: "@scope/pkg", version: "2.1.0" },
        { deps: { bare: "1.0.0", hoisted: "3.0.0", stale: "1.0.0", twin: "1.0.0" }, name: "mid", version: "1.0.0" },
        { name: "twin", version: "1.0.0" },
        { name: "hoisted", version: "3.0.0" },
        { name: "stale", version: "1.0.0" },
        { name: "bare", version: "1.0.0" },
        { name: "empty-meta", version: "1.0.0" },
        ...LICENSE_VARIANTS.map((_, index): Pkg => { return { name: `license-${index}`, version: "1.0.0" }; }),
    ];

    workspace(root, {
        lock: lockV9(packages),
        projects: {
            a: { dependencies: { "@scope/pkg": "2.1.0", "empty-meta": "1.0.0", mid: "1.0.0", ...Object.fromEntries(LICENSE_VARIANTS.map((_, index) => [`license-${index}`, "1.0.0"])) }, name: "installed-a", version: "1.0.0" },
        },
    });

    const store = (dir: string, name: string, manifest: Json): void => { write(root, `node_modules/.pnpm/${dir}/node_modules/${name}/package.json`, manifest); };

    store("left-pad@1.3.0", "left-pad", { author: "Left <l@example.test>", description: "pads", license: "WTFPL", name: "left-pad", repository: { url: "https://example.test/left-pad" }, version: "1.3.0" });
    store("@scope+pkg@2.1.0_react@18.2.0", "@scope/pkg", { bugs: { url: "https://example.test/bugs" }, homepage: "https://example.test/pkg", license: "MIT", name: "@scope/pkg", version: "2.1.0" });
    store("mid@1.0.0_a@1.0.0_b@2.0.0", "mid", { description: "variant one", license: "ISC", name: "mid", version: "1.0.0" });
    store("mid@1.0.0_c@1.0.0", "mid", { description: "variant one", license: "ISC", name: "mid", version: "1.0.0" });
    store("twin@1.0.0_x@1.0.0", "twin", { license: "Zlib", name: "twin", version: "1.0.0" });
    store("twin@1.0.0_y@2.0.0", "twin", { license: "Zlib", name: "twin", version: "1.0.0" });
    write(root, "node_modules/hoisted/package.json", { description: "hoisted copy", license: "MIT", name: "hoisted", version: "3.0.0" });
    write(root, "node_modules/stale/package.json", { description: "wrong version", license: "MIT", name: "stale", version: "0.9.0" });
    store("empty-meta@1.0.0", "empty-meta", {});
    LICENSE_VARIANTS.forEach((license, index) => { store(`license-${index}@1.0.0`, `license-${index}`, { license, name: `license-${index}`, version: "1.0.0" }); });
};

/** This repository's own lockfile, under a workspace with one project for each of its importers. */
const monorepoLock = (root: string): void => {
    const lock = readFileSync(repositoryLockfile, "utf8");
    const importers = lock.slice(lock.indexOf("\nimporters:\n") + 1, lock.indexOf("\npackages:\n"));
    const projects: Record<string, Json> = {};
    let current: { directory: string; fields: Record<string, Record<string, string>> } | undefined;
    let field = "";
    let dependency = "";

    for (const line of importers.split("\n").slice(1)) {
        const importer = /^ {2}(\S.*):$/.exec(line);

        if (importer && importer[1] !== ".") {
            current = { directory: importer[1] as string, fields: {} };
            projects[current.directory] = { name: `m-${current.directory.replaceAll("/", "-")}`, version: "1.0.0" };
            field = "";
            continue;
        }

        const kind = /^ {4}(dependencies|devDependencies|optionalDependencies):$/.exec(line);

        if (current && kind) {
            field = kind[1] as string;
            current.fields[field] = {};
            (projects[current.directory] as Json)[field] = current.fields[field];
            continue;
        }

        const name = /^ {6}(\S.*):$/.exec(line);

        if (name) {
            dependency = (name[1] as string).replaceAll("'", "");
            continue;
        }

        const specifier = /^ {8}specifier: (.*)$/.exec(line);

        if (current && field && specifier && dependency) {
            (current.fields[field] as Record<string, string>)[dependency] = (specifier[1] as string).replaceAll("'", "");
        }
    }

    write(root, "package.json", { name: "monorepo-fixture", private: true, version: "0.0.0" });
    write(root, "pnpm-workspace.yaml", `packages:\n${Object.keys(projects).map((directory) => `  - "${directory}"`).join("\n")}\n`);
    write(root, "pnpm-lock.yaml", lock);

    for (const [directory, manifest] of Object.entries(projects)) {
        write(root, `${directory}/package.json`, manifest);
    }
};

/** The monorepo's lockfile over this checkout's own install: the virtual store and the hoisted copies are real. */
const monorepoInstalled = (root: string): void => {
    monorepoLock(root);
    symlinkSync(join(packageRoot, "..", "..", "..", "node_modules"), join(root, "node_modules"));
};

/** A directory that is a symlink: `ensureDirSync` of the Node handler refuses it, so the binary must not write through it. */
const symlinkDirectory = (root: string): void => {
    basic(root);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
};

// Fixtures the native path hands to Node. Each one still has a plain lockfile, so only the named thing differs.
const plain = (root: string, extra: (root: string) => void = () => undefined): void => {
    basic(root);
    extra(root);
};

const configured = (root: string): void => { plain(root, (directory) => { write(directory, "vis.config.json", "{}\n"); }); };
const withCargoLock = (root: string): void => { plain(root, (directory) => { write(directory, "Cargo.lock", "version = 3\n"); }); };
const withGoSum = (root: string): void => { plain(root, (directory) => { write(directory, "go.sum", "example.test/m v1.0.0 h1:AAAA=\n"); }); };
const withProjectJson = (root: string): void => { plain(root, (directory) => { write(directory, "packages/a/project.json", { name: "renamed-a", projectType: "tool" }); }); };
const withUvLock = (root: string): void => { plain(root, (directory) => { write(directory, "uv.lock", "version = 1\n"); }); };
const crlf = (root: string): void => {
    basic(root);
    write(root, "pnpm-lock.yaml", readFileSync(join(root, "pnpm-lock.yaml"), "utf8").replaceAll("\n", "\r\n"));
};
const NO_BREAK_SPACE = String.fromCodePoint(0xA0);
const BYTE_ORDER_MARK = String.fromCodePoint(0xFE_FF);

const unicodeSpace = (root: string): void => {
    basic(root);
    write(root, "pnpm-lock.yaml", `${readFileSync(join(root, "pnpm-lock.yaml"), "utf8")}\n# note${NO_BREAK_SPACE}here\n`);
};
const protoDependency = (root: string): void => { workspace(root, { lock: lockV9([{ deps: { constructor: "1.0.0" }, name: "a-pkg", version: "1.0.0" }, { name: "constructor", version: "1.0.0" }]), projects: { a: { dependencies: { "a-pkg": "1.0.0" }, name: "proto-a" } } }); };
const unsupportedRange = (root: string): void => { workspace(root, { lock: lockV9([{ name: "lodash", version: "4.17.21" }]), projects: { a: { dependencies: { lodash: "~>4.0.0" }, name: "unsupported-a" } } }); };
const nonAsciiName = (root: string): void => { workspace(root, { lock: lockV9([{ name: "lodash", version: "4.17.21" }]), projects: { a: { dependencies: { lodash: "4.17.21" }, name: "café" } } }); };
const nonAsciiLicense = (root: string): void => { workspace(root, { lock: lockV9([{ name: "lodash", version: "4.17.21" }]), projects: { a: { license: "MÄT", name: "umlaut-a" } } }); };
const numberDescription = (root: string): void => { workspace(root, { lock: lockV9([]), projects: { a: { description: 42, name: "number-a" } } }); };
const brokenInstalled = (root: string): void => {
    installed(root);
    write(root, "node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json", "{ not json");
};
const conflictingInstalled = (root: string): void => {
    installed(root);
    write(root, "node_modules/.pnpm/mid@1.0.0_c@1.0.0/node_modules/mid/package.json", { description: "variant two", license: "MIT", name: "mid", version: "1.0.0" });
};
const bomManifest = (root: string): void => {
    basic(root);
    write(root, "packages/a/package.json", `${BYTE_ORDER_MARK}${JSON.stringify({ dependencies: { "left-pad": "1.3.0" }, name: "@fixture/a", version: "1.2.3" })}`);
};
const yarnOnly = (root: string): void => {
    write(root, "package.json", { name: "yarn-root", private: true, version: "1.0.0", workspaces: ["packages/*"] });
    write(root, "yarn.lock", '# yarn lockfile v1\n\n\nleft-pad@^1.0.0:\n  version "1.3.0"\n  resolved "https://registry.example.test/left-pad/-/left-pad-1.3.0.tgz"\n');
    write(root, "packages/a/package.json", { dependencies: { "left-pad": "^1.0.0" }, name: "yarn-a", version: "1.0.0" });
};
const emptyLock = (root: string): void => { workspace(root, { lock: "lockfileVersion: '9.0'\n", projects: { a: { name: "empty-a", version: "1.0.0" } } }); };
const noProjects = (root: string): void => { workspace(root, { lock: lockV9([{ name: "lodash", version: "4.17.21" }]), projects: {} }); };

/**
 * A registry package for every kind of edge, beside a `vis.config` that drops one project and leaves the rest: the
 * dependencies of the dropped project are not in the BOM, and a project that depends on it resolves it as a registry
 * package (the lockfile lists it) instead of as a workspace edge.
 */
const configuredRegistry = (root: string): void => {
    workspace(root, {
        lock: lockV9([...LEFT_PAD, { deps: { "left-pad": "1.3.0" }, name: "@scope/pkg", version: "2.1.0" }, { name: "only-dropped", version: "1.0.0" }, { name: "@fixture/dropped", version: "3.0.0" }]),
        projects: {
            a: { dependencies: { "@fixture/dropped": "^3.0.0", "@fixture/kept": "workspace:*", "@scope/pkg": "^2.0.0" }, devDependencies: { "left-pad": "1.0.0" }, name: "@fixture/a", version: "1.0.0" },
            dropped: { dependencies: { "only-dropped": "1.0.0" }, name: "@fixture/dropped", version: "3.0.0" },
            kept: { dependencies: { "left-pad": "~1.3.0" }, name: "@fixture/kept", version: "2.0.0" },
        },
    });
    write(root, "vis.config.ts", 'export default { projectIgnore: ["dropped"], sponsor: { enabled: false } };\n');
};

/** `configuredRegistry` with the ignore rule and the config of every spelling the binary reads. */
const configuredIgnoreRules = (root: string): void => {
    configuredRegistry(root);
    write(root, ".gitignore", "kept\n");
    write(root, "vis.config.ts", 'export default { projectIgnore: ["dropped/"], strictEnv: true };\n');
};

/** A config that opts a gated ecosystem in (the lock file it reads is not there, so only the config differs), in each of the two ways. */
const optInByList = (root: string): void => {
    configuredRegistry(root);
    write(root, "vis.config.ts", 'export default { sbom: { ecosystems: ["go"] } };\n');
};
const optInByDiscover = (root: string): void => {
    configuredRegistry(root);
    write(root, "vis.config.ts", "export default { go: { discover: true } };\n");
};
const optInUnknown = (root: string): void => {
    configuredRegistry(root);
    write(root, "vis.config.ts", 'export default { sbom: { ecosystems: ["rust"] } };\n');
};

const FIXTURES: Record<string, (root: string) => void> = {
    basic,
    configuredIgnoreRules,
    optInByDiscover,
    optInByList,
    optInUnknown,
    configuredRegistry,
    bomManifest,
    brokenInstalled,
    configured,
    conflictingInstalled,
    crlf,
    emptyLock,
    graph,
    installed,
    legacy,
    metadata,
    monorepoInstalled,
    monorepoLock,
    nonAsciiLicense,
    nonAsciiName,
    noProjects,
    numberDescription,
    protoDependency,
    ranges,
    resolutions,
    symlinkDirectory,
    unicodeSpace,
    unsupportedRange,
    withCargoLock,
    withGoSum,
    withProjectJson,
    withUvLock,
    yarnOnly,
};

/** The workspaces of `config-workspace-cases.ts` (the ones `vis graph` and `vis status` run on), over a lockfile of this suite. */
const CONFIG_FIXTURE_PREFIX = "config: ";

for (const entry of [...CONFIG_CASES, ...GRAPH_ONLY_CASES]) {
    FIXTURES[`${CONFIG_FIXTURE_PREFIX}${entry.name}`] = (root: string): void => {
        for (const [path, content] of Object.entries(entry.files)) {
            if (typeof content === "object" && "link" in content) {
                throw new TypeError(`${path}: a link is not a fixture of this suite`);
            }

            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), content);
        }

        write(root, "pnpm-lock.yaml", lockV9([...LEFT_PAD]));
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Running both engines
// ---------------------------------------------------------------------------------------------------------------

const UNSET = "unset";

// What changes the output apart from the arguments: the CI marker, colour, and test mode.
const DROPPED_ENVIRONMENT = new Set<string>([...COLOUR_VARIABLES, "CI", "COLUMNS", "CONTINUOUS_INTEGRATION", "DEBUG", "NODE_ENV", "PAIL_LOG_LEVEL", "VIS_FALLBACK_ENTRY", "VIS_FALLBACK_ENTRY_OVERRIDE", "VIS_MONOREPO_ROOT", "VIS_VERSION"]);

const environment = (ci: boolean, extra: Record<string, string> = {}): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED_ENVIRONMENT.has(key) && !key.startsWith("CEREBRO_")));

    env["COLUMNS"] = "80";
    env["VIS_NO_UPDATE_CHECK"] = "1";

    if (ci) {
        env["CI"] = "1";
    }

    for (const [key, value] of Object.entries(extra)) {
        if (value === UNSET) {
            delete env[key];
        } else {
            env[key] = value;
        }
    }

    return env;
};

interface Run {
    files: Record<string, string>;
    status: number | null;
    stderr: string;
    stdout: string;
}

/** Every file under `root`, by relative path, except `.git` and the fixture's `node_modules` (which is never written). */
const snapshot = (root: string): Record<string, string> => {
    const found: Record<string, string> = {};
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);

            if (name === ".git" || name === "node_modules") {
                continue;
            }

            const info = lstatSync(path);

            if (info.isSymbolicLink()) {
                continue;
            }

            if (info.isDirectory()) {
                visit(path);
            } else {
                found[relative(root, path)] = readFileSync(path, "utf8");
            }
        }
    };

    visit(root);

    return found;
};

const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Blanks the two random values of a BOM after checking that each has the shape it must have (a version 4 UUID, an
 * ISO timestamp within a minute of now), and pail's clock. Everything else is left alone.
 */
const mask = (text: string, root: string): string => {
    let masked = text.replaceAll(root, "<ROOT>").replaceAll(/\(node:\d+\)/g, "(node:PID)");

    for (const found of masked.matchAll(/^ {2}"serialNumber": "([^"]*)",$/gm)) {
        expect(found[1]).toMatch(UUID);
    }

    for (const found of masked.matchAll(/^ {4}"timestamp": "([^"]*)",$/gm)) {
        expect(found[1]).toMatch(TIMESTAMP);
        expect(Math.abs(Date.parse(found[1] as string) - Date.now())).toBeLessThan(60_000);
    }

    // The XML form, which Node answers for `--format xml`.
    for (const found of masked.matchAll(/ serialNumber="([^"]*)"/g)) {
        expect(found[1]).toMatch(UUID);
    }

    for (const found of masked.matchAll(/<timestamp>([^<]*)<\/timestamp>/g)) {
        expect(found[1]).toMatch(TIMESTAMP);
    }

    masked = masked.replaceAll(/( serialNumber=")[^"]*(")/g, "$1<UUID>$2").replaceAll(/(<timestamp>)[^<]*(<\/timestamp>)/g, "$1<TIMESTAMP>$2");
    masked = masked.replaceAll(/^( {2}"serialNumber": ")[^"]*(",)$/gm, "$1<UUID>$2").replaceAll(/^( {4}"timestamp": ")[^"]*(",)$/gm, "$1<TIMESTAMP>$2");

    return masked.replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS");
};

const maskRun = (run: Run, root: string): Run => {
    return {
        files: Object.fromEntries(Object.entries(run.files).map(([path, content]) => [path, mask(content, root)])),
        status: run.status,
        stderr: mask(run.stderr, root),
        stdout: mask(run.stdout, root),
    };
};

let scratch: string;
let nativeBinary: string;
let counter = 0;
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

const fresh = (fixture: string): string => {
    // A path the status line prints must be plain ASCII for the binary to answer, so the case names that hold spaces are not used as they are.
    // A `.git` anywhere in the path would make Node's workspace walk skip every project (its skip regex runs on the absolute path), so no dots either.
    const root = join(scratch, `${fixture.replaceAll(/[^\w-]+/g, "_")}-${String(counter++)}`);

    mkdirSync(root, { recursive: true });
    (FIXTURES[fixture] as (root: string) => void)(root);

    return realpathSync(root);
};

const substitute = (args: string[], root: string): string[] => args.map((argument) => argument.replaceAll("{root}", root));

/**
 * Runs a command with stdout and stderr redirected to files outside the fixture. Node on macOS cuts a large
 * document short when its stdout is a pipe and the process then exits (at 128 KiB), a Node behaviour this
 * test must not trip over; the binary writes the whole document to a pipe.
 */
const execute = (command: string, argv: string[], root: string, env: Record<string, string | undefined>): Run => {
    const before = new Set(Object.keys(snapshot(root)));
    const name = randomUUID();
    const out = join(scratch, `${name}.out`);
    const err = join(scratch, `${name}.err`);
    const outFd = openSync(out, "w");
    const errFd = openSync(err, "w");
    let status: number | null;

    try {
        ({ status } = spawnSync(command, argv, { cwd: root, env, stdio: ["ignore", outFd, errFd] }));
    } finally {
        closeSync(outFd);
        closeSync(errFd);
    }

    const stdout = readFileSync(out, "utf8");
    const stderr = readFileSync(err, "utf8");
    const after = snapshot(root);

    // Only what the run wrote; the fixture's own files are the same on both sides.
    const files = Object.fromEntries(Object.entries(after).filter(([path]) => !before.has(path)));

    return { files, status, stderr, stdout };
};

const runNode = (fixture: string, args: string[], ci: boolean, extra?: Record<string, string>): { root: string; run: Run } => {
    const root = fresh(fixture);

    return { root, run: maskRun(execute(process.execPath, [nodeEntry, "sbom", ...substitute(args, root)], root, environment(ci, extra)), root) };
};

/** `entry` is the fallback Node entry, or none: then a call the binary declines exits 70. */
const runNative = (fixture: string, args: string[], ci: boolean, extra?: Record<string, string>, entry?: string): { root: string; run: Run } => {
    const root = fresh(fixture);
    const env = environment(ci, extra);

    if (entry !== undefined) {
        env["VIS_FALLBACK_ENTRY"] = entry;
        env["VIS_FALLBACK_ENTRY_OVERRIDE"] = entry;
        env["VIS_NODE"] = process.execPath;
        env["VIS_VERSION"] = version;
    }

    return { root, run: maskRun(execute(nativeBinary, ["sbom", ...substitute(args, root)], root, env), root) };
};

// ---------------------------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------------------------

const SBOM_FILE = "sbom.cdx.json";

/** The shapes the native path answers, over the fixtures that exercise the reader. */
const NATIVE: [fixture: string, args: string[], env?: Record<string, string>][] = [
    ["basic", []],
    ["basic", ["--output", "-"]],
    // Node reads `VIS_MONOREPO_ROOT || cwd`, so an empty value is no value.
    ["basic", ["--output", "-"], { VIS_MONOREPO_ROOT: "" }],
    ["basic", ["--output=-", "--include-dev"]],
    ["basic", ["--format", "json", "--output", "nested/dir/out.json"]],
    ["basic", ["--output", "{root}/abs/out.json"]],
    ["basic", ["--include-dev"]],
    ["basic", ["--focus", "@fixture/a", "--output", "-"]],
    ["basic", ["--focus=@fixture/b,@fixture/a", "--include-dev", "--output", "-"]],
    ["basic", ["--focus", "@fixture/a,@fixture/a", "--output", "-"]],
    ["basic", ["--focus", " @fixture/b , ", "--output", "-"]],
    ["basic", ["--focus", ",", "--output", "-"]],
    ["ranges", ["--output", "-"]],
    ["ranges", ["--output", "-", "--include-dev"]],
    ["resolutions", ["--output", "-"]],
    ["resolutions", []],
    ["legacy", ["--output", "-"]],
    ["graph", ["--output", "-"]],
    ["graph", ["--output", "-", "--include-dev"]],
    ["graph", ["--focus", "@fixture/app", "--output", "-"]],
    ["graph", ["--focus", "@fixture/lib", "--output", "-", "--include-dev"]],
    ["graph", ["--focus", "@fixture/core", "--output", "-"]],
    ["graph", ["--focus", "other,Zeta", "--output", "-"]],
    ["graph", ["--focus", "alpha-b", "--output", "-"]],
    ["metadata", ["--output", "-"]],
    ["metadata", []],
    ["installed", ["--output", "-"]],
    ["installed", ["--output", "-", "--include-dev"]],
    ["emptyLock", ["--output", "-"]],
    ["emptyLock", []],
    ["noProjects", ["--output", "-"]],
    ["monorepoLock", ["--output", "-"]],
    ["monorepoLock", ["--output", "-", "--include-dev"]],
    ["monorepoLock", ["--output", "{root}/out/monorepo.json"]],
    ["monorepoInstalled", ["--output", "-"]],
    ["monorepoInstalled", ["--output", "-", "--include-dev"]],
    ["monorepoInstalled", []],
];

/** Shapes the native path hands to Node; the fallback entry then makes Node answer, and its output must be Node's. */
const DELEGATED: [fixture: string, args: string[], env?: Record<string, string>][] = [
    ["basic", ["--format", "xml", "--output", "-"]],
    ["basic", ["--format", "xml"]],
    ["basic", ["--format", "yaml"]],
    ["basic", ["--format", "JSON", "--output", "-"]],
    ["basic", ["--unknown"]],
    ["basic", ["--output", "-", "extra"]],
    ["basic", ["--include-dev=false", "--output", "-"]],
    ["basic", ["--no-include-dev", "--output", "-"]],
    ["basic", ["--focus", "missing", "--output", "-"]],
    ["basic", ["--output", "../outside.json"]],
    ["basic", ["--output", "dir/../x.json"]],
    ["basic", ["--output", "./x.json"]],
    ["basic", ["--output", "{root}/dir/"]],
    // `resolve` folds the double slash, which the message then shows.
    ["basic", ["--output", "/{root}/x.json"]],
    ["symlinkDirectory", ["--output", "link/x.json"]],
    ["basic", ["--output", "with space.json"]],
    ["basic", ["--output", "package.json/x.json"]],
    ["basic", ["--output", "packages"]],
    ["basic", ["--output", "sub dir/x.json"]],
    ["basic", ["--output", "-", "--output", "-"]],
    ["basic", ["--output", "-"], { NODE_ENV: "test" }],
    ["basic", ["--output", "-"], { NODE_ENV: "debug" }],
    ["basic", ["--output", "-"], { DEBUG: "1" }],
    ["basic", ["--output", "-"], { PAIL_LOG_LEVEL: "error" }],
    ["basic", ["--output", "-"], { CEREBRO_OUTPUT_LEVEL: "16" }],
    ["basic", ["--output", "-"], { VIS_MONOREPO_ROOT: "/elsewhere" }],
    // pail's header does not fit its label below 40 columns, so the binary leaves the width to Node.
    ["basic", [], { COLUMNS: "30" }],
    ["basic", ["--output", "-"], { FORCE_COLOR: "1", NO_COLOR: "1" }],
    ["basic", ["--output", "-", "--no-color"]],
    ["configured", ["--output", "-"]],
    ["optInByList", ["--output", "-"]],
    ["optInByDiscover", ["--output", "-"]],
    // Node refuses an unknown ecosystem id and fails the run.
    ["optInUnknown", ["--output", "-"]],
    ["withCargoLock", ["--output", "-"]],
    ["withUvLock", ["--output", "-"]],
    ["withGoSum", ["--output", "-"]],
    ["withProjectJson", ["--output", "-"]],
    ["yarnOnly", ["--output", "-"]],
    ["crlf", ["--output", "-"]],
    ["unicodeSpace", ["--output", "-"]],
    ["protoDependency", ["--output", "-"]],
    ["unsupportedRange", ["--output", "-"]],
    ["nonAsciiName", ["--output", "-"]],
    ["nonAsciiLicense", ["--output", "-"]],
    ["numberDescription", ["--output", "-"]],
    ["bomManifest", ["--output", "-"]],
    ["brokenInstalled", ["--output", "-"]],
    ["conflictingInstalled", ["--output", "-"]],
];

const probe = (): boolean => {
    if (!binary || process.platform === "win32" || !existsSync(nodeEntry)) {
        return false;
    }

    const directory = mkdtempSync(join(tmpdir(), "vis-sbom-probe-"));

    try {
        workspace(directory, { lock: "lockfileVersion: '9.0'\n", projects: { a: { name: "probe-a" } } });

        const { status } = spawnSync(process.execPath, [nodeEntry, "sbom", "--output", "-"], { cwd: directory, env: environment(true) });

        return status === 0;
    } finally {
        rmSync(directory, { force: true, recursive: true });
    }
};

describe.skipIf(!probe())("vis sbom: native vs Node", () => {
    beforeAll(() => {
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-sbom-parity-")));
        nativeBinary = join(scratch, "bin", "vis");

        mkdirSync(join(scratch, "bin"));
        copyFileSync(binary as string, nativeBinary);
    });

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    const label = (fixture: string, args: string[], env?: Record<string, string>): string => `${fixture}: sbom ${args.join(" ")} ${env ? JSON.stringify(env) : ""}`;

    it.each(NATIVE.map(([fixture, args, env]) => [label(fixture, args, env), fixture, args, env] as const))("%s is answered natively and matches Node", (_name, fixture, args, env) => {
        const node = runNode(fixture, args, true, env);
        const native = runNative(fixture, args, true, env);

        // The binary has no fallback entry here: a declined call would have exited 70.
        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.stderr).toBe(node.run.stderr);
        expect(native.run.files).toStrictEqual(node.run.files);
        expect(node.run.status).toBe(0);
    }, 120_000);

    it.each(DELEGATED.map(([fixture, args, env]) => [label(fixture, args, env), fixture, args, env] as const))("%s is declined by the binary and answered by Node", (_name, fixture, args, env) => {
        const node = runNode(fixture, args, true, env);
        const bare = runNative(fixture, args, true, env);
        const native = runNative(fixture, args, true, env, nodeEntry);

        expect(bare.run.status).toBe(70);
        expect(bare.run.files).toStrictEqual({});
        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.stderr).toBe(node.run.stderr);
        expect(native.run.files).toStrictEqual(node.run.files);
    }, 120_000);

    // A literal `vis.config` at the workspace root: the BOM depends on it through `projectIgnore`, the `discover` flags of
    // the gated ecosystems and `sbom.ecosystems`, and on nothing else (see `config_workspace.rs`). Every case that `vis graph`
    // is answered natively for runs through both engines, to stdout and to a file; every other is handed to Node.
    // One case that `vis graph` answers is Node's here: a `vis.config.js` in a package without a `type` makes Node print its
    // MODULE_TYPELESS_PACKAGE_JSON warning on stderr, which the BOM command (that prints stderr lines of its own) does not reproduce.
    const SBOM_DECLINES = new Set(["vis.config.js without a package type"]);
    const configCases = [...CONFIG_CASES, ...GRAPH_ONLY_CASES].map((entry) => [entry.name, `${CONFIG_FIXTURE_PREFIX}${entry.name}`, entry.graph && !SBOM_DECLINES.has(entry.name)] as const);

    it.each(configCases.filter(([, , native]) => native).flatMap(([name, fixture]) => [[name, fixture, ["--output", "-"]], [name, fixture, []], [name, fixture, ["--output", "-", "--include-dev"]]] as const))("with a config, %s %j is answered natively and matches Node", (_name, fixture, args) => {
        const node = runNode(fixture, [...args], true);
        const native = runNative(fixture, [...args], true);

        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.stderr).toBe(node.run.stderr);
        expect(native.run.files).toStrictEqual(node.run.files);
        expect(node.run.status).toBe(0);
    }, 120_000);

    it.each(configCases.filter(([, , native]) => !native).map(([name, fixture]) => [name, fixture] as const))("with a config, %s is declined by the binary and answered by Node", (_name, fixture) => {
        const args = ["--output", "-"];
        const node = runNode(fixture, args, true);
        const bare = runNative(fixture, args, true);
        const native = runNative(fixture, args, true, undefined, nodeEntry);

        expect(bare.run.status).toBe(70);
        expect(bare.run.files).toStrictEqual({});
        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.stderr).toBe(node.run.stderr);
        expect(native.run.files).toStrictEqual(node.run.files);
    }, 120_000);

    it.each([
        ["configuredRegistry", ["--output", "-"]],
        ["configuredRegistry", ["--output", "-", "--include-dev"]],
        ["configuredRegistry", []],
        ["configuredRegistry", ["--focus", "@fixture/a", "--output", "-"]],
        ["configuredRegistry", ["--focus", "@fixture/kept", "--output", "-", "--include-dev"]],
        ["configuredIgnoreRules", ["--output", "-"]],
        ["configuredIgnoreRules", ["--output", "-", "--include-dev"]],
    ] as const)("%s with a projectIgnore: sbom %j matches Node", (fixture, args) => {
        const node = runNode(fixture, [...args], true);
        const native = runNative(fixture, [...args], true);

        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.stderr).toBe(node.run.stderr);
        expect(native.run.files).toStrictEqual(node.run.files);
        expect(node.run.status).toBe(0);
    }, 120_000);

    // The project that the config drops is no project: a focus on it is Node's to refuse.
    it("hands a focus on a project that the config drops to Node", () => {
        const args = ["--focus", "@fixture/dropped", "--output", "-"];
        const node = runNode("configuredRegistry", args, true);
        const bare = runNative("configuredRegistry", args, true);
        const native = runNative("configuredRegistry", args, true, undefined, nodeEntry);

        expect(bare.run.status).toBe(70);
        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.stderr).toBe(node.run.stderr);
    }, 120_000);

    // Node loads the config of the workspace root and the binary reads that one only: from a project directory it hands over.
    it("hands a configured run from a project directory to Node", () => {
        const root = fresh("configuredRegistry");
        const bare = spawnSync(nativeBinary, ["sbom", "--output", "-"], { cwd: join(root, "packages", "a"), encoding: "utf8", env: environment(true) });

        expect(bare.status).toBe(70);
    });

    it("hands a configured run outside CI to Node", () => {
        const bare = runNative("configuredRegistry", ["--output", "-"], false);

        expect(bare.run.status).toBe(70);
        expect(bare.run.files).toStrictEqual({});
    });

    it.each(["40", "120", UNSET])("prints the same status lines as Node for a configured workspace at COLUMNS=%s", (columns) => {
        const node = runNode("configuredRegistry", [], true, { COLUMNS: columns, GITHUB_ACTIONS: "true" });
        const native = runNative("configuredRegistry", [], true, { COLUMNS: columns, GITHUB_ACTIONS: "true" });

        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.stderr).toBe(node.run.stderr);
        expect(native.run.files).toStrictEqual(node.run.files);
    }, 120_000);

    // Node writes to a pipe asynchronously and exits right after, so a document larger than the pipe's buffer (64 KiB)
    // reaches the reader cut short, at a length that depends on the reader. A small one arrives whole, and the binary
    // writes the same bytes; a larger one is left to Node, whose answer is then Node's own.
    it("writes a small document to a pipe like Node", () => {
        expect.hasAssertions();

        const nodeRoot = fresh("basic");
        const nativeRoot = fresh("basic");
        const node = spawnSync(process.execPath, [nodeEntry, "sbom", "--output", "-"], { cwd: nodeRoot, encoding: "utf8", env: environment(true) });
        const native = spawnSync(nativeBinary, ["sbom", "--output", "-"], { cwd: nativeRoot, encoding: "utf8", env: environment(true) });

        expect(native.status).toBe(node.status);
        expect(mask(native.stdout, nativeRoot)).toBe(mask(node.stdout, nodeRoot));
        expect(native.stderr).toBe(node.stderr);
        expect(Buffer.byteLength(native.stdout)).toBeLessThan(64 * 1024);
    }, 120_000);

    it("leaves a document that does not fit a pipe to Node", () => {
        expect.hasAssertions();

        const root = fresh("monorepoLock");
        const bare = spawnSync(nativeBinary, ["sbom", "--output", "-"], { cwd: root, encoding: "utf8", env: environment(true) });

        expect(bare.status).toBe(70);
        expect(bare.stdout).toBe("");
    }, 120_000);

    it("declines outside CI, where Node adds notices of its own", () => {
        const bare = runNative("basic", ["--output", "-"], false);

        expect(bare.run.status).toBe(70);
        expect(bare.run.files).toStrictEqual({});
    });

    it("declines when the working directory is below the workspace root", () => {
        const root = fresh("basic");
        const bare = spawnSync(nativeBinary, ["sbom", "--output", "-"], { cwd: join(root, "packages", "a"), encoding: "utf8", env: environment(true) });

        expect(bare.status).toBe(70);
    });

    // pail colours the header of its status lines where its colour detection says so, and pads the header to the
    // terminal width; the binary prints the same codes. The JSON on stdout is not coloured, whatever the environment.
    it.each(COLOUR_ENVIRONMENTS.map((env) => [JSON.stringify(env), env] as const))("prints the same status lines as Node in the colour environment %s", (_name, env) => {
        const node = runNode("basic", [], true, env);
        const native = runNative("basic", [], true, env);

        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.stderr).toBe(node.run.stderr);
        expect(native.run.files).toStrictEqual(node.run.files);
        expect(Object.keys(native.run.files)).toStrictEqual([SBOM_FILE]);
    }, 120_000);

    it.each(["40", "50", "120", UNSET])("wraps the status lines like Node at COLUMNS=%s", (columns) => {
        const deep = { COLUMNS: columns };
        const node = runNode("basic", ["--output", "{root}/a/very/long/directory/name/that/forces/the/message/to/wrap/around/sbom.json"], true, deep);
        const native = runNative("basic", ["--output", "{root}/a/very/long/directory/name/that/forces/the/message/to/wrap/around/sbom.json"], true, deep);

        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.stderr).toBe(node.run.stderr);
        expect(native.run.files).toStrictEqual(node.run.files);
    }, 120_000);

    it.each(DELEGATED_COLOUR_ENVIRONMENTS.map((env) => [JSON.stringify(env), env] as const))("leaves the colour environment %s to Node", (_name, env) => {
        const node = runNode("basic", [], true, env);
        const bare = runNative("basic", [], true, env);
        const native = runNative("basic", [], true, env, nodeEntry);

        expect(bare.run.status).toBe(70);
        expect(native.run.status).toBe(node.run.status);
        expect(native.run.stdout).toBe(node.run.stdout);
        expect(native.run.files).toStrictEqual(node.run.files);
    }, 120_000);

    // The colour flags are read by Node's argument handling; the binary leaves them to it.
    it.each([["--no-color"], ["--color"]])("leaves %s to Node", (flag) => {
        const bare = runNative("basic", [flag], true);

        expect(bare.run.status).toBe(70);
        expect(bare.run.files).toStrictEqual({});
    });
});
