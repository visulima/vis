import { isAccessibleSync, readFileSync, readJsonSync } from "@visulima/fs";
import { join } from "@visulima/path";

import { whichBin } from "#native";

import type { DevEngineEntry } from "./env-consistency";
import { devEnginesEntries } from "./env-consistency";

/**
 * Runtime-version mismatch finding. vis doesn't manage runtimes directly,
 * but it can warn when the currently running Node/Bun doesn't match
 * whatever the repo has declared — usually a sign the user forgot to
 * switch runtimes for this workspace.
 */
export interface RuntimeFinding {
    actual: string;
    expected: string;
    kind: "node" | "packageManager";
    message: string;
    severity: "error" | "warning";
}

interface RootPackageJson {
    devEngines?: Record<string, unknown>;
    engines?: { bun?: string; node?: string; npm?: string; pnpm?: string; yarn?: string };
    packageManager?: string;
}

/**
 * Tries to read a `.nvmrc` or `.node-version` file at the workspace root.
 */
const readNodeVersionFile = (workspaceRoot: string): string | undefined => {
    for (const name of [".nvmrc", ".node-version"]) {
        const path = join(workspaceRoot, name);

        if (!isAccessibleSync(path)) {
            continue;
        }

        try {
            const content = readFileSync(path).trim();

            return content.replace(/^v/, "");
        } catch {
            // ignore
        }
    }

    return undefined;
};

/**
 * Compares two dotted version strings. Returns negative if a < b,
 * 0 if equal, positive if a > b. Non-numeric components are ignored.
 */
const compareVersions = (a: string, b: string): number => {
    const aParts = a.split(/[.\-+]/).map((p) => Number.parseInt(p, 10) || 0);
    const bParts = b.split(/[.\-+]/).map((p) => Number.parseInt(p, 10) || 0);

    const len = Math.max(aParts.length, bParts.length);

    for (let i = 0; i < len; i++) {
        const ai = aParts[i] ?? 0;
        const bi = bParts[i] ?? 0;

        if (ai !== bi) {
            return ai - bi;
        }
    }

    return 0;
};

/**
 * Evaluates a minimal subset of semver ranges: `>=X`, `X.Y`, `X.Y.Z`,
 * and compound `>=X &lt;Y`. Returns true if `actual` satisfies the range.
 * Falls back to "true" for unrecognised syntax rather than false so we
 * don't spam warnings on exotic ranges.
 */
export const satisfiesRange = (actual: string, range: string): boolean => {
    const normalized = range.trim();

    if (normalized === "" || normalized === "*") {
        return true;
    }

    const clauses = normalized.split(/\s+/).filter(Boolean);

    for (const clause of clauses) {
        if (clause.startsWith(">=")) {
            if (compareVersions(actual, clause.slice(2).trim()) < 0) {
                return false;
            }
        } else if (clause.startsWith("<=")) {
            if (compareVersions(actual, clause.slice(2).trim()) > 0) {
                return false;
            }
        } else if (clause.startsWith(">")) {
            if (compareVersions(actual, clause.slice(1).trim()) <= 0) {
                return false;
            }
        } else if (clause.startsWith("<")) {
            if (compareVersions(actual, clause.slice(1).trim()) >= 0) {
                return false;
            }
        } else if (/^\d/.test(clause)) {
            const actualParts = actual.split(".");
            const clauseParts = clause.split(".");

            for (const [i, clausePart] of clauseParts.entries()) {
                if (clausePart !== actualParts[i]) {
                    return false;
                }
            }
        }
    }

    return true;
};

/**
 * Checks a `devEngines.runtime` or `devEngines.packageManager` declaration against the version
 * that is running. An array is a list of alternatives, so the tool only fails when none of its
 * entries is satisfied. The failing entry's `onFail` picks the severity.
 *
 * Unset `onFail` is a warning, not the spec default of `error`, so existing projects do not start
 * failing on upgrade. `download` is a warning too, because vis does not install runtimes.
 * @param value Raw `devEngines.&lt;kind>` value from package.json.
 * @param tool Tool that is running (`node`, or the package manager name).
 * @param actual Version that is running.
 * @param kind Which devEngines field the value came from.
 * @returns A finding when the declaration is violated, otherwise `undefined`.
 */
const checkDevEngines = (value: unknown, tool: string, actual: string, kind: "node" | "packageManager"): RuntimeFinding | undefined => {
    const entries = devEnginesEntries(value);
    const sameTool = entries.filter((entry): entry is DevEngineEntry & { version: string } => entry.name === tool && typeof entry.version === "string");

    if (sameTool.some((entry) => satisfiesRange(actual, entry.version))) {
        return undefined;
    }

    // Judged only against entries that name the running tool. The process that launched vis is not
    // necessarily the project's package manager (`npx vis doctor` runs under npm).
    const failing = sameTool.at(-1);

    if (!failing?.version) {
        return undefined;
    }

    const onFail = failing.onFail ?? "warn";

    if (onFail === "ignore") {
        return undefined;
    }

    const hint = onFail === "download" ? " vis does not install runtimes; install it yourself." : "";

    return {
        actual,
        expected: failing.version,
        kind,
        message: `devEngines.${kind === "node" ? "runtime" : "packageManager"} requires ${failing.name ?? tool}@${failing.version}, but the current ${tool} is ${actual}.${hint}`,
        severity: onFail === "error" ? "error" : "warning",
    };
};

/**
 * Checks `engines.node`, `.nvmrc`, `.node-version`, and `packageManager`
 * against the running process.
 * @param workspaceRoot Absolute path to the workspace root.
 * @returns Findings; an empty array means everything matches.
 */
export const checkRuntimeVersions = (workspaceRoot: string): RuntimeFinding[] => {
    const findings: RuntimeFinding[] = [];
    const pkgPath = join(workspaceRoot, "package.json");

    let rootPkg: RootPackageJson;

    try {
        rootPkg = readJsonSync(pkgPath) as RootPackageJson;
    } catch {
        return findings;
    }

    const actualNode = process.versions.node;
    const { devEngines } = rootPkg;
    // npm_config_user_agent looks like "pnpm/10.1.0 npm/? node/v24.0.0"; only the first token is the running manager.
    const [runningPm = "", runningPmVersion = ""] = (process.env["npm_config_user_agent"] ?? "").split(" ")[0]?.split("/") ?? [];

    // engines.node
    if (rootPkg.engines?.node) {
        const expected = rootPkg.engines.node;

        if (!satisfiesRange(actualNode, expected)) {
            findings.push({
                actual: actualNode,
                expected,
                kind: "node",
                message: `package.json engines.node requires ${expected}, but the current Node.js is ${actualNode}.`,
                severity: "error",
            });
        }
    }

    // devEngines.runtime
    const runtimeFinding = checkDevEngines(devEngines?.runtime, "node", actualNode, "node");

    if (runtimeFinding) {
        findings.push(runtimeFinding);
    }

    // .nvmrc / .node-version
    const pinnedNode = readNodeVersionFile(workspaceRoot);

    if (pinnedNode) {
        // Compare major.minor only (patch churn is fine).
        const [pinnedMajor, pinnedMinor] = pinnedNode.split(".");
        const [actualMajor, actualMinor] = actualNode.split(".");

        if (pinnedMajor !== actualMajor || (pinnedMinor !== undefined && pinnedMinor !== actualMinor)) {
            findings.push({
                actual: actualNode,
                expected: pinnedNode,
                kind: "node",
                message: `.nvmrc pins Node ${pinnedNode} but the current Node.js is ${actualNode}. Run \`nvm use\` or switch runtimes.`,
                severity: "warning",
            });
        }
    }

    // packageManager field
    if (rootPkg.packageManager) {
        const [expectedName, expectedVersion] = rootPkg.packageManager.split("@");
        const detectedFromUserAgent = runningPm ? `${runningPm}/${runningPmVersion}` : "";
        const detectedName = runningPm;
        const detectedVersion = runningPmVersion;

        // Aube enforces its own `packageManagerStrict` setting (tri-state:
        // off | warn | error, defaulting to warn) and emits a clear
        // diagnostic when the pin doesn't match. Double-erroring here
        // would mask aube's message — but only when aube is actually
        // installed and able to surface that diagnostic. Without aube on
        // PATH, vis's error stays as the only signal so the user is told
        // something is wrong.
        const aubePin = expectedName === "aube";
        const aubeAvailable = aubePin && whichBin("aube") !== null;

        if (detectedName && expectedName && detectedName !== expectedName) {
            findings.push({
                actual: detectedName,
                expected: expectedName,
                kind: "packageManager",
                message: `package.json packageManager pins ${rootPkg.packageManager} but the current invocation is ${detectedFromUserAgent}. Install the correct package manager.`,
                severity: aubeAvailable ? "warning" : "error",
            });
        } else if (detectedVersion && expectedVersion && detectedVersion !== expectedVersion) {
            findings.push({
                actual: detectedVersion,
                expected: expectedVersion,
                kind: "packageManager",
                message: `package.json packageManager pins ${expectedName}@${expectedVersion} but the current invocation uses ${expectedName}@${detectedVersion}.`,
                severity: "warning",
            });
        }
    }

    // devEngines.packageManager only applies when no top-level packageManager pins the tool.
    if (!rootPkg.packageManager && runningPm && runningPmVersion) {
        const pmFinding = checkDevEngines(devEngines?.packageManager, runningPm, runningPmVersion, "packageManager");

        if (pmFinding) {
            findings.push(pmFinding);
        }
    }

    return findings;
};
