import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeBinary } from "../../bin/resolve-binary.mjs";

/**
 * `vis secrets` exists twice: the Node handler (`src/commands/secrets/handler.ts`, over the scanner
 * package's post-scan pipeline) and the native scan (`native/cli/src/secrets.rs`, over the same
 * engine crate). Every fixture below is built here, with planted fake secrets assembled at runtime so
 * that this repository's own scan stays clean, and runs through both with the same arguments and CI
 * context. Stdout, stderr (up to the clock in pail's header and the fixture's path) and the exit code
 * must match. The native run's fallback entry is a stub that prints a marker, so a run that quietly
 * delegated is caught: the marker must be absent exactly when the native path is expected to answer.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolveNativeBinary(packageRoot);
const nodeEntry = join(packageRoot, "dist", "bin.js");
const scannerPackage = join(packageRoot, "node_modules", "@visulima", "secret-scanner");
const marker = "NATIVE-DELEGATED";
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };

const part = (...pieces: string[]): string => pieces.join("");

// Fake credentials in the shape the bundled rules detect. Each is split so no source line holds one.
const STRIPE = part("sk", "_live_", "4eC39Hq", "LyjWDarjtT1zdp7dc");
const GITHUB = part("gh", "p_", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jK5");
const SLACK = part("xo", "xb-", "123456789012-1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx");
const GENERIC = part("Zx9fK2mQ", "7pLw3VnR8tYb4HcD");
const NPM = part("n", "pm_", "q1W2e3R4t5Y6u7I8o9P0aSdFgHjKlZxCvBnM");
const UUID = part("123e4567-e89b-12d3-", "a456-426614174000");

const write = (root: string, path: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
};

/** A pnpm workspace root the native gate accepts, with a git repository so `.gitignore` applies. */
const workspace = (root: string): void => {
    write(root, "package.json", JSON.stringify({ name: "fixture", private: true }));
    write(root, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    spawnSync("git", ["init", "--quiet"], { cwd: root });
};

/** Findings, and every stage the post-scan pipeline applies to them, each with a hit. */
const findings = (root: string): void => {
    workspace(root);
    // A finding of two rules, a generic key, a secret inside a base64 value, and findings that
    // the pipeline drops: a UUID, a sequence, a lock file, an inline marker, an ignored directory.
    write(
        root,
        "app.env",
        [
            `stripe = "${STRIPE}"`,
            `github = ${GITHUB}`,
            `api_key = "${GENERIC}"`,
            `api_key = "${STRIPE}"`,
            `secret_key = "${UUID}"`,
            'password = "abcdefghijklmnopqrst"',
            `allowed = ${GITHUB} # gitleaks:allow`,
            "",
        ].join("\n"),
    );
    write(root, "dir one/my file.env", `slack = ${SLACK}\n`);
    write(root, "yarn.lock", `token "${STRIPE}"\n`);
    write(root, "ignored/x.env", `k = ${STRIPE}\n`);
    write(root, ".gitignore", "ignored/\n");
    write(root, "enc.txt", `data = ${Buffer.from(`token = ${GITHUB}`).toString("base64")}\n`);
    // Skipped (larger than the default limit), and an allow marker that names no rule.
    write(root, "big.txt", Buffer.alloc(11 * 1024 * 1024, "0"));
    write(root, "allowwarn.txt", `x = ${GITHUB} # gitleaks:allow no-such-rule\n`);
};

/** One finding, small enough to run at several terminal widths. */
const oneFinding = (root: string): void => {
    workspace(root);
    write(root, "app.env", `stripe = "${STRIPE}"\n`);
};

const clean = (root: string): void => {
    workspace(root);
    write(root, "readme.txt", "nothing to see here\n");
};

/** `findings` plus a baseline that hides one finding by content, one by position, and lists a resolved one. */
const baselined = (root: string): void => {
    findings(root);
    write(
        root,
        ".secrets-baseline.json",
        JSON.stringify([
            { file: "app.env", ruleId: "github-pat", secret: GITHUB, startLine: 2 },
            { file: "dir one/my file.env", ruleId: "kingfisher.slack.2", startLine: 1 },
            { file: "gone.env", ruleId: "github-pat", secret: GITHUB, startLine: 9 },
            "not an entry",
        ]),
    );
};

const malformedBaseline = (root: string): void => {
    findings(root);
    write(root, ".secrets-baseline.json", "{ not json");
};

const gitleaksIgnored = (root: string): void => {
    findings(root);
    write(root, ".gitleaksignore", "app.env:github-pat:2\n");
};

const secretlintIgnored = (root: string): void => {
    findings(root);
    write(root, ".secretlintignore", "enc.txt\n");
};

const configured = (root: string): void => {
    findings(root);
    write(root, "vis.config.json", "{}\n");
};

/** A finding of a rule whose findings Node filters by a checksum. */
const checksummed = (root: string): void => {
    workspace(root);
    write(root, "n.txt", `x = ${NPM}\n`);
};

const FIXTURES: Record<string, (root: string) => void> = {
    baselined,
    checksummed,
    clean,
    configured,
    findings,
    gitleaksIgnored,
    malformedBaseline,
    oneFinding,
    secretlintIgnored,
};

/** The invocations the native path answers, per fixture. */
const NATIVE: [string, string[]][] = [
    ["findings", ["--format", "json"]],
    ["findings", ["--format=sarif"]],
    ["findings", ["--quiet"]],
    ["findings", ["--quiet", "--format", "json"]],
    ["findings", ["--format", "json", "--baseline", "missing.json"]],
    ["baselined", ["--format", "json", "--baseline", ".secrets-baseline.json"]],
    ["baselined", ["--baseline=.secrets-baseline.json", "--quiet"]],
    ["baselined", ["--format", "sarif", "--baseline", ".secrets-baseline.json"]],
    ["clean", ["--format", "json"]],
    ["clean", ["--format", "sarif"]],
    ["clean", ["--quiet"]],
];

/** The invocations the native path hands to Node; the marker of the stub entry shows it. */
const DELEGATED: [fixture: string, args: string[]][] = [
    ["findings", []],
    ["findings", ["--format", "text"]],
    ["findings", ["--format", "json", "--no-redact"]],
    ["findings", ["--format", "csv"]],
    ["findings", ["--format", "json", "dir one"]],
    ["clean", []],
    ["malformedBaseline", ["--format", "json", "--baseline", ".secrets-baseline.json"]],
    ["gitleaksIgnored", ["--format", "json"]],
    ["secretlintIgnored", ["--format", "json"]],
    ["configured", ["--format", "json"]],
    ["checksummed", ["--format", "json"]],
];

/**
 * The delegations that are decided late (after the scan) or on a file in the tree, which also run the
 * binary with the real Node entry: its output must be Node's. A second Node run each, so only these.
 * (The default text view is not among them: its progress frames depend on timing.)
 */
const DELEGATED_AND_COMPARED: [fixture: string, args: string[]][] = [
    ["malformedBaseline", ["--format", "json", "--baseline", ".secrets-baseline.json"]],
    ["gitleaksIgnored", ["--format", "json"]],
    ["checksummed", ["--format", "json"]],
];

// What changes Node's output apart from the arguments: the CI marker, colour, and test mode.
const DROPPED_ENVIRONMENT = new Set(["CI", "CONTINUOUS_INTEGRATION", "FORCE_COLOR", "NODE_ENV", "VIS_FALLBACK_ENTRY", "VIS_FALLBACK_ENTRY_OVERRIDE", "VIS_MONOREPO_ROOT", "VIS_VERSION"]);

const contextEnvironment = (ci: boolean, columns: string | undefined = "80"): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED_ENVIRONMENT.has(key)));

    env["COLUMNS"] = columns;
    env["VIS_NO_UPDATE_CHECK"] = "1";

    if (ci) {
        env["CI"] = "1";
    }

    return env;
};

/** The fixture's path and pail's clock differ between runs. */
const normalize = (text: string, root: string): string => text.replaceAll(root, "<ROOT>").replaceAll(/\d{2}:\d{2}:\d{2}/g, "HH:MM:SS");

interface Run {
    status: number | null;
    stderr: string;
    stdout: string;
}

/**
 * Runs a command with stdout and stderr redirected to files: Node cuts a large report short when
 * its stdout is a pipe and the process then exits, which is a Node behaviour this test must not trip over.
 */
const capture = (command: string, args: string[], directory: string, env: Record<string, string | undefined>): Run => {
    const name = randomUUID();
    const out = join(directory, "..", `${name}.out`);
    const err = join(directory, "..", `${name}.err`);
    const outFd = openSync(out, "w");
    const errFd = openSync(err, "w");

    try {
        const { status } = spawnSync(command, args, { cwd: directory, env, stdio: ["ignore", outFd, errFd] });

        return { status, stderr: readFileSync(err, "utf8"), stdout: readFileSync(out, "utf8") };
    } finally {
        closeSync(outFd);
        closeSync(errFd);
    }
};

const runNode = (directory: string, args: string[], ci: boolean, columns?: string): Run =>
    capture(process.execPath, [nodeEntry, "secrets", ...args], directory, contextEnvironment(ci, columns));

const runNative = (directory: string, args: string[], ci: boolean, entry: string, columns?: string): Run =>
    // A binary in a platform package keeps the entry and version the launcher passes; one inside the vis
    // package (a dev copy) takes the override instead. Set both.
    capture(binary as string, ["secrets", ...args], directory, {
        ...contextEnvironment(ci, columns),
        VIS_FALLBACK_ENTRY: entry,
        VIS_FALLBACK_ENTRY_OVERRIDE: entry,
        VIS_NODE: process.execPath,
        VIS_VERSION: version,
    });

/** The Node side needs the scanner package built and its compiled binding present, which a bare checkout lacks. */
const scannerLoads = (): boolean =>
    existsSync(join(scannerPackage, "data", "ruleset.json")) && spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("@visulima/secret-scanner");'], { cwd: packageRoot }).status === 0;

const ready = Boolean(binary) && process.platform !== "win32" && existsSync(nodeEntry) && scannerLoads();

// A native scan in a debug build compiles about 1,400 rules unoptimised; CI runs the release binary.
const TIMEOUT = 300_000;

describe.skipIf(!ready)("vis secrets: native vs Node", () => {
    const paths = { fixtures: new Map<string, string>(), scratch: "", stub: "" };

    beforeAll(() => {
        paths.scratch = realpathSync(mkdtempSync(join(tmpdir(), "vis-secrets-parity-")));

        for (const [name, build] of Object.entries(FIXTURES)) {
            const root = join(paths.scratch, name);

            build(root);
            paths.fixtures.set(name, root);
        }

        // The native path loads the ruleset of the scanner package that the Node entry resolves, so
        // the stub entry sits in a package that resolves it too.
        const stubPackage = join(paths.scratch, "stub-package");

        write(stubPackage, "dist/bin.js", `console.log("${marker}");\nprocess.exit(99);\n`);
        mkdirSync(join(stubPackage, "node_modules", "@visulima"), { recursive: true });
        symlinkSync(realpathSync(scannerPackage), join(stubPackage, "node_modules", "@visulima", "secret-scanner"), "dir");
        paths.stub = join(stubPackage, "dist", "bin.js");
    }, TIMEOUT);

    afterAll(() => {
        rmSync(paths.scratch, { force: true, recursive: true });
    });

    const directoryOf = (fixture: string): string => paths.fixtures.get(fixture) as string;

    it.each(NATIVE)("%s %j is answered natively and matches Node in CI", (fixture, args) => {
        expect.assertions(4);

        const directory = directoryOf(fixture);
        const node = runNode(directory, args, true);
        // The stub entry shows which path answers: the marker appears only on delegation.
        const native = runNative(directory, args, true, paths.stub);

        expect(native.stdout).not.toContain(marker);
        expect(normalize(native.stdout, directory)).toBe(normalize(node.stdout, directory));
        expect(normalize(native.stderr, directory)).toBe(normalize(node.stderr, directory));
        expect(native.status).toBe(node.status);
    }, TIMEOUT);

    // pail pads its header with dots to the terminal width and wraps the message to it. Every status
    // kind (warning and notice with findings, success without) runs at narrow, wide and unset widths.
    it.each([
        ["oneFinding", "40"],
        ["oneFinding", "50"],
        ["oneFinding", "120"],
        ["oneFinding", undefined],
        ["clean", "40"],
        ["clean", "120"],
        ["clean", undefined],
    ] as const)("%s prints the same status lines at COLUMNS=%s", (fixture, columns) => {
        expect.assertions(4);

        const directory = directoryOf(fixture);
        const node = runNode(directory, ["--format", "json"], true, columns);
        const native = runNative(directory, ["--format", "json"], true, paths.stub, columns);

        expect(native.stdout).not.toContain(marker);
        expect(normalize(native.stdout, directory)).toBe(normalize(node.stdout, directory));
        expect(normalize(native.stderr, directory)).toBe(normalize(node.stderr, directory));
        expect(native.status).toBe(node.status);
    }, TIMEOUT);

    it.each(DELEGATED)("%s %j is delegated", (fixture, args) => {
        expect.assertions(1);

        // The stub entry answers with the marker, which only a delegation reaches.
        expect(runNative(directoryOf(fixture), args, true, paths.stub).stdout).toContain(marker);
    }, TIMEOUT);

    it.each(DELEGATED_AND_COMPARED)("%s %j is delegated to the Node CLI unchanged", (fixture, args) => {
        expect.assertions(3);

        const directory = directoryOf(fixture);
        const node = runNode(directory, args, true);
        const native = runNative(directory, args, true, nodeEntry);

        expect(normalize(native.stdout, directory)).toBe(normalize(node.stdout, directory));
        expect(normalize(native.stderr, directory)).toBe(normalize(node.stderr, directory));
        expect(native.status).toBe(node.status);
    }, TIMEOUT);

    it.each([
        ["outside CI", {}, false],
        ["with NODE_ENV=test, which silences pail's status lines in Node", { NODE_ENV: "test" }, true],
        ["with a CEREBRO_ variable, which sets Node's output level", { CEREBRO_OUTPUT_LEVEL: "16" }, true],
        ["with FORCE_COLOR, which colours Node's output", { FORCE_COLOR: "1" }, true],
        ["with NODE_ENV=debug, which makes pail log more", { NODE_ENV: "debug" }, true],
        ["with DEBUG set, which makes pail log more", { DEBUG: "1" }, true],
        ["with PAIL_LOG_LEVEL set", { PAIL_LOG_LEVEL: "error" }, true],
        ["with a COLUMNS too narrow for pail's header", { COLUMNS: "39" }, true],
        ["with a COLUMNS that is not a number", { COLUMNS: "wide" }, true],
    ] as const)("delegates %s", (_name, extra, ci) => {
        expect.assertions(1);

        const probe = capture(binary as string, ["secrets", "--format", "json"], directoryOf("clean"), {
            ...contextEnvironment(ci),
            ...extra,
            VIS_FALLBACK_ENTRY: paths.stub,
            VIS_FALLBACK_ENTRY_OVERRIDE: paths.stub,
            VIS_NODE: process.execPath,
            VIS_VERSION: version,
        });

        expect(probe.stdout).toContain(marker);
    }, TIMEOUT);

    it.each([["cs_CZ.UTF-8"], ["da_DK.UTF-8"]])("delegates a SARIF report in the %s locale, where rule ids collate differently", (locale) => {
        expect.assertions(1);

        const probe = capture(binary as string, ["secrets", "--format", "sarif"], directoryOf("clean"), {
            ...contextEnvironment(true),
            LC_ALL: locale,
            VIS_FALLBACK_ENTRY: paths.stub,
            VIS_FALLBACK_ENTRY_OVERRIDE: paths.stub,
            VIS_NODE: process.execPath,
            VIS_VERSION: version,
        });

        expect(probe.stdout).toContain(marker);
    }, TIMEOUT);

    it("reports what Node reports, so the fixture covers every stage", () => {
        expect.assertions(9);

        const report = runNode(directoryOf("findings"), ["--format", "json"], true);
        const found = JSON.parse(report.stdout) as { decoded?: string[]; file: string; ruleId: string; startLine: number }[];
        const files = new Set(found.map((finding) => finding.file));
        const inApp = (ruleId: string): number[] => found.filter((finding) => finding.file === "app.env" && finding.ruleId === ruleId).map((finding) => finding.startLine);

        // Reported: the key rules, the decoded value, a path with a space.
        expect(inApp("stripe-access-token")).toStrictEqual([1, 4]);
        expect(found.some((finding) => finding.decoded?.[0] === "base64")).toBe(true);
        expect(files.has("dir one/my file.env")).toBe(true);
        // The generic rule yields where another rule overlaps it (line 4), and not elsewhere (line 3).
        expect(inApp("generic-api-key")).toStrictEqual([3]);
        // Dropped by the pipeline or the walk: lock file, ignored directory.
        expect(files.has("yarn.lock")).toBe(false);
        expect(files.has("ignored/x.env")).toBe(false);
        // The UUID (line 5), the sequence (line 6) and the inline-allowed line (7) report nothing.
        expect(found.filter((finding) => finding.file === "app.env" && finding.startLine > 4)).toStrictEqual([]);
        expect(report.stderr).toContain("not scanned");
        expect(report.stderr).toContain("unknown: no-such-rule");
    }, TIMEOUT);
});
