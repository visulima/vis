/**
 * Apply a release plan to disk: rewrite package.json versions, update
 * internal-dep ranges (preserving `workspace:` prefix), prepend changelog
 * entries, delete consumed change files (RFC §6.1, §11.1, §17.4).
 *
 * Pure logic for the rewrites; fs interactions injected via `Fs` adapter
 * so the same code paths are testable without a real filesystem.
 */

import semver from "semver";

import { VisReleaseError } from "../errors";
import type { DependencyKind, InternalDependencyRangesMode, PackageManifest, PlannedRelease, ReleasePlan, WorkspacePackage } from "../types";
import type { DependencyGraph } from "./dep-graph";
import { cleanRange } from "./semver";

const DEPENDENCY_KINDS: ReadonlyArray<DependencyKind> = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// ── Range rewrite (preserves workspace: prefix per RFC §11.1) ──────

/**
 * Rewrite a single dep range to point at `newVersion`, preserving:
 *   - `workspace:` prefix and shorthands (`workspace:*`, `workspace:^`, `workspace:~`)
 *   - `catalog:` refs (catalog version updates flow through pnpm-workspace.yaml)
 *   - `npm:&lt;alias&gt;@&lt;spec&gt;` syntax
 *   - prefix operators (`^`, `~`, `&gt;=`, `&gt;`, `&lt;=`, `&lt;`, `=`); defaults to `^`
 */
export const rewriteRangeForVersion = (currentRange: string, newVersion: string): string => {
    if (currentRange.startsWith("catalog:")) {
        return currentRange;
    }

    if (currentRange === "*") {
        return currentRange;
    }

    if (currentRange === "workspace:*" || currentRange === "workspace:^" || currentRange === "workspace:~") {
        return currentRange;
    }

    if (currentRange.startsWith("workspace:")) {
        const inner = currentRange.slice("workspace:".length);
        const prefix = extractPrefix(inner);

        return `workspace:${prefix}${newVersion}`;
    }

    if (currentRange.startsWith("npm:")) {
        const at = currentRange.lastIndexOf("@");

        if (at <= "npm:".length) {
            return currentRange;
        }

        const aliasName = currentRange.slice("npm:".length, at);
        const spec = currentRange.slice(at + 1);
        const prefix = extractPrefix(spec);

        return `npm:${aliasName}@${prefix}${newVersion}`;
    }

    const prefix = extractPrefix(currentRange);

    return `${prefix}${newVersion}`;
};

const PREFIX_RE = /^([\^~=]|>=?|<=?)/;

const extractPrefix = (range: string): string => {
    const match = PREFIX_RE.exec(range);

    if (match) {
        return match[1] ?? "^";
    }

    // No explicit prefix → default to `^` (matches semantic-release/changesets/bumpy).
    return "^";
};

/** An exact version or a bare `^`/`~`/`=` version: specs that move in lockstep with the dependency. */
const LOCKSTEP_SPEC_RE = /^[\^~=]?\s*v?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/**
 * `internalDependencyRanges: "preserve-satisfying"` (multi-semantic-release's `deps.bump: "satisfy"`):
 * a range that still admits `newVersion` is returned byte-for-byte; an outgrown one has the floor of
 * the alternative that can admit it raised to `newVersion`, keeping its ceiling and the other `||`
 * alternatives. Exact pins and `^`/`~` specs keep the `rewrite` behaviour.
 *
 * Throws when no alternative's ceiling admits `newVersion`: rewriting would either publish a
 * dependent whose declared range excludes the version it ships with, or silently widen a
 * deliberate ceiling — both are decisions for a human.
 */
export const updateRangeForVersion = (
    currentRange: string,
    newVersion: string,
    mode: InternalDependencyRangesMode = "rewrite",
    context: { dependent?: string; depName?: string; kind?: DependencyKind } = {},
): string => {
    const spec = mode === "preserve-satisfying" ? cleanRange(currentRange) : null;

    if (spec === null || LOCKSTEP_SPEC_RE.test(spec.trim()) || semver.validRange(spec) === null) {
        return rewriteRangeForVersion(currentRange, newVersion);
    }

    // npm semantics (no `includePrerelease`): this is the range installers will evaluate.
    if (semver.satisfies(newVersion, spec)) {
        return currentRange;
    }

    const alternatives = spec.split("||").map((alternative) => alternative.trim());
    // With `includePrerelease`, the only way an alternative admits `newVersion` that npm rejects
    // is prerelease tuple scoping (`>=1.0.0-alpha.1 <2.0.0-0` vs `1.0.1-alpha.0`), which raising
    // the floor onto `newVersion`'s tuple fixes.
    const index = alternatives.findIndex((alternative) => semver.satisfies(newVersion, alternative, { includePrerelease: true }));

    if (index === -1) {
        const where = context.dependent ? ` in ${context.dependent}'s ${context.kind ?? "dependencies"}` : "";

        throw new VisReleaseError({
            code: "DEPENDENCY_RANGE_EXCEEDED",
            hint: "Widen the range by hand (or set `internalDependencyRanges: \"rewrite\"`), then re-run the release.",
            message: `${context.depName ?? "dependency"}@${newVersion} is outside "${currentRange}"${where}; refusing to rewrite the range.`,
            packageName: context.dependent,
        });
    }

    const ceiling = (new semver.Range(alternatives[index] as string).set[0] ?? [])
        .filter((comparator) => comparator.operator.startsWith("<"))
        .map((comparator) => comparator.value);

    alternatives[index] = [`>=${newVersion}`, ...ceiling].join(" ");

    return `${currentRange.slice(0, currentRange.length - spec.length)}${alternatives.join(" || ")}`;
};

// ── apply ──────────────────────────────────────────────────────────

export interface AppliedFileChange {
    /** New content (stringified JSON for manifests, markdown for changelogs). */
    content: string;
    /** Absolute path to the file. */
    path: string;
}

export interface AppliedPlan {
    /** Change files that should be removed (consumed). */
    deletions: string[];
    /** Files that should be written (manifests + changelogs). */
    writes: AppliedFileChange[];
}

/**
 * Compute the file-system changes needed to apply a release plan.
 * Returns a structured diff; the caller (the CLI handler) is responsible
 * for writing/deleting the files (so dry-run mode can print without
 * touching disk).
 *
 * `serializeManifest` is injected so the caller can preserve formatting
 * (e.g. detect existing indentation). Defaults to 4-space JSON + trailing newline.
 */
export const applyReleasePlan = async (
    plan: ReleasePlan,
    depGraph: DependencyGraph,
    options: {
        changelogPath?: (pkg: WorkspacePackage) => string;
        internalDependencyRanges?: InternalDependencyRangesMode;
        readChangelog?: (path: string) => string | undefined;
        readManifest?: (path: string) => string | undefined;
        renderChangelogEntry?: (release: PlannedRelease) => string | Promise<string>;
        serializeManifest?: (m: PackageManifest, original?: string) => string;
    } = {},
): Promise<AppliedPlan> => {
    const serializeManifest = options.serializeManifest ?? defaultSerializeManifest;
    const changelogPath = options.changelogPath ?? defaultChangelogPath;
    const renderChangelogEntry = options.renderChangelogEntry ?? defaultRenderChangelogEntry;

    const newVersionByPackage = new Map(plan.releases.map((r) => [r.name, r.newVersion] as const));
    // Parallelize per-release work — the github changelog formatter
    // shells out to git + gh per file (RFC §6.1 / nx-style). Sequential
    // formatter calls dominated wall time on a 49-package release wave;
    // Promise.all collapses them to a single batch.
    const perReleaseResults = await Promise.all(
        plan.releases.map(async (release) => {
            const pkg = depGraph.getPackage(release.name);

            if (!pkg) {
                return undefined;
            }

            const updatedManifest = applyVersionToManifest(pkg.manifest, release.newVersion, newVersionByPackage, options.internalDependencyRanges);
            const originalManifest = options.readManifest?.(pkg.manifestPath);
            const cl = changelogPath(pkg);
            const entry = await renderChangelogEntry(release);

            return {
                changelogEntry: entry,
                changelogPath: cl,
                // A non-npm manifest (Cargo.toml, pyproject.toml) is TOML: its version and
                // requirements are written by the ecosystem plan, never serialized from the synthetic manifest.
                manifestWrite:
                    pkg.ecosystem === undefined
                        ? ({
                            content: serializeManifest(updatedManifest, originalManifest),
                            path: pkg.manifestPath,
                        } satisfies AppliedFileChange)
                        : undefined,
            };
        }),
    );

    const writes: AppliedFileChange[] = [];

    // Bucket changelog entries by path so multiple packages routed to a
    // shared file (changesets #1059: fixed/linked groups with
    // `changelog.mode: "shared"`) all prepend into the same target.
    // Per-package routing falls out of this for free — each package has
    // a unique path and ends up alone in its bucket.
    const changelogBuckets = new Map<string, string[]>();

    for (const result of perReleaseResults) {
        if (!result) {
            continue;
        }

        if (result.manifestWrite) {
            writes.push(result.manifestWrite);
        }

        const existing = changelogBuckets.get(result.changelogPath);

        if (existing) {
            existing.push(result.changelogEntry);
        } else {
            changelogBuckets.set(result.changelogPath, [result.changelogEntry]);
        }
    }

    // Each bucket reads its existing changelog once, then prepends the
    // aggregated entries in plan order (Releases are pre-sorted by
    // package name in `assembleReleasePlan`).
    for (const [path, entries] of changelogBuckets) {
        const aggregated = entries.join("\n\n");
        const existingChangelog = options.readChangelog?.(path);

        writes.push({
            content: prependChangelog(aggregated, existingChangelog),
            path,
        });
    }

    return {
        deletions: plan.consumedChangeFiles.map((f) => f.path),
        writes,
    };
};

const applyVersionToManifest = (
    manifest: PackageManifest,
    newVersion: string,
    newVersionByPackage: ReadonlyMap<string, string>,
    rangesMode: InternalDependencyRangesMode | undefined,
): PackageManifest => {
    const out: PackageManifest = { ...manifest, version: newVersion };

    for (const kind of DEPENDENCY_KINDS) {
        const block = manifest[kind];

        if (!block || typeof block !== "object") {
            continue;
        }

        const next: Record<string, string> = { ...block };
        let changed = false;

        for (const [depName, range] of Object.entries(block)) {
            const newDepVersion = newVersionByPackage.get(depName);

            if (newDepVersion === undefined) {
                continue;
            }

            const newRange = updateRangeForVersion(range, newDepVersion, rangesMode, { dependent: manifest.name, depName, kind });

            if (newRange !== range) {
                next[depName] = newRange;
                changed = true;
            }
        }

        if (changed) {
            out[kind] = next;
        }
    }

    return out;
};

// ── Changelog prepend (handles 3 cases per RFC §17.4) ──────────────

const TITLE_HEADER_RE = /^# .+/;
const ENTRY_HEADER_RE = /^## /m;

/**
 * Prepend a changelog entry to existing CHANGELOG.md content.
 * Handles three real-world starting states (RFC §17.4):
 *   1. `# Title` then `##` entries (bumpy / changesets convention) →
 *      insert after the `# Title` line, before the first `##`.
 *   2. Starts directly with `##` (semantic-release / visulima) →
 *      insert at the very top.
 *   3. Empty / missing file → create with `# Changelog\n\n` header,
 *      then insert.
 */
export const prependChangelog = (entry: string, existing: string | undefined): string => {
    const trimmedEntry = entry.trim();

    if (!existing || existing.trim() === "") {
        return `# Changelog\n\n${trimmedEntry}\n`;
    }

    const lines = existing.split(/\r?\n/);

    // Case 1: file starts with `# Title`.
    if (lines[0] && TITLE_HEADER_RE.test(lines[0])) {
        // Find the line of the first `##` header (or end of file).
        let insertAt = 1;

        while (insertAt < lines.length && !(lines[insertAt] ?? "").startsWith("## ")) {
            insertAt += 1;
        }

        const before = lines.slice(0, insertAt);
        const after = lines.slice(insertAt);

        // Ensure a blank line between title and entry.
        if (before.length > 0 && before[before.length - 1] !== "") {
            before.push("");
        }

        return [...before, trimmedEntry, "", ...after].join("\n").replaceAll(/\n{3,}/g, "\n\n");
    }

    // Case 2: starts directly with `##` or other content.
    if (ENTRY_HEADER_RE.test(existing)) {
        return `${trimmedEntry}\n\n${existing.trimStart()}`;
    }

    // No `##` header anywhere → just prepend.
    return `${trimmedEntry}\n\n${existing.trimStart()}`;
};

// ── Defaults ────────────────────────────────────────────────────────

const defaultSerializeManifest = (manifest: PackageManifest, original?: string): string => {
    const indent = detectJsonIndent(original);

    return `${JSON.stringify(manifest, null, indent)}\n`;
};

const detectJsonIndent = (content: string | undefined): number => {
    if (!content) {
        return 4;
    }

    const match = /\n(\s+)"/.exec(content);

    if (!match) {
        return 4;
    }

    const len = (match[1] ?? "").length;

    return len === 2 || len === 4 ? len : 4;
};

const defaultChangelogPath = (pkg: WorkspacePackage): string => `${pkg.dir}/CHANGELOG.md`;

const defaultRenderChangelogEntry = (release: PlannedRelease): string => {
    const date = new Date().toISOString().slice(0, 10);
    const lines = [`## ${release.newVersion}`, `<sub>${date}</sub>`, ""];

    if (release.isCascadeBump || release.isGroupBump) {
        for (const source of release.sources) {
            lines.push(`- Version bump from ${source.name}@${source.newVersion}`);
        }
    } else if (release.isDependencyBump && release.changeFiles.length === 0) {
        for (const source of release.sources) {
            // F13: a catalog REMOVAL reports `newVersion === ""` (the
            // release-plan stores `entry.newVersion ?? ""` for the
            // synthetic catalog source). Rendering `${source.newVersion}`
            // as-is yields a trailing `@` like
            // `catalog:default/lodash@` — emit a removal line instead.
            if (source.newVersion === "") {
                lines.push(`- Removed dependency ${source.name}`);
            } else {
                lines.push(`- Updated dependency ${source.name}@${source.newVersion}`);
            }
        }
    } else {
        for (const file of release.changeFiles) {
            for (const line of file.body.split(/\r?\n/)) {
                if (line.trim() === "") {
                    lines.push("");

                    continue;
                }

                lines.push(line.startsWith("-") || line.startsWith("*") ? line : `- ${line}`);
            }
        }
    }

    return lines.join("\n");
};
