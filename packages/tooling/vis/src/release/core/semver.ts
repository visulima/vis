/**
 * Channel-aware semver bumping (RFC §10.1).
 *
 * Wraps the `semver` package with the channel-transition rules from the
 * RFC's table:
 *
 *   from main, last 1.2.3   + minor + alpha → 1.3.0-alpha.0  (open prerelease line)
 *   on alpha, last 1.3.0-alpha.5 + patch + alpha → 1.3.0-alpha.6 (counter increments)
 *   on beta, last 1.3.0-alpha.5 + (no bump) → 1.3.0-beta.0   (re-counter on new preid)
 *   on next, last 1.3.0-beta.5 + (no bump) → 1.3.0-rc.0       (next channel preid)
 *   on main, last 1.3.0-rc.5 + (no bump) → 1.3.0              (preid stripped — final)
 *   on main, last 1.0.0-alpha.76 + patch → 1.0.0               (graduates to its base)
 *   on beta, last 1.0.0-alpha.76 + minor → 1.0.0-beta.0        (base already covers minor)
 *   on main, last 1.3.0-rc.5 + major → 2.0.0                   (bump exceeds the base)
 *
 * Pure functions; no I/O. Re-exports `satisfies`/`coerce`/etc. from `semver`
 * so callers don't need to import both.
 */

import semver from "semver";

import { VisReleaseError } from "../errors";
import type { BumpLevel } from "../types";

export type ReleaseType = Exclude<BumpLevel, "none">;

export interface BumpInput {
    /** Bump level requested (or `"none"` for channel-only transitions). */
    bump: BumpLevel;

    /**
     * For pre-1.0 versions, demote major bumps to minor and minor bumps
     * to patch. Matches release-please's `bump-minor-pre-major` /
     * `bump-patch-for-minor-pre-major` flags — keeps libraries pre-1.0
     * from jumping all the way to 2.0 on the first breaking change.
     */
    bumpMinorPreMajor?: boolean;

    /**
     * Companion to `bumpMinorPreMajor` — for pre-1.0 versions, demote
     * minor bumps to patch as well. Only meaningful when
     * `bumpMinorPreMajor` is also set.
     */
    bumpPatchForMinorPreMajor?: boolean;
    /** Currently-published version. */
    current: string;
    /** Pre-release identifier (e.g. `"alpha"`). Omit for stable channels. */
    prerelease?: string;
}

/**
 * Compute the next version given the current version, requested bump level,
 * and active channel's prerelease id.
 *
 * Encapsulates the channel-transition rules (re-counter on preid change,
 * collapse to stable when preid is dropped, etc.).
 */
// Promotion order of the prerelease channels (RFC §10.1, see semver.ts): a
// release moves alpha → beta → rc, so a later channel's tags are never a base
// for an earlier one.
const PRERELEASE_LADDER = ["alpha", "beta", "rc"];

/**
 * The channel identifier a prerelease version carries: its prerelease
 * components without the trailing counter, so `1.0.0-alpha.canary.4` is
 * `alpha.canary` and `1.0.0-42.3` is `42`. Stable versions have none.
 */
const channelOf = (version: string): string | undefined => {
    const parts = [...(semver.prerelease(version) ?? [])];

    if (parts.length > 1 && typeof parts.at(-1) === "number") {
        parts.pop();
    }

    return parts.length > 0 ? parts.join(".") : undefined;
};

/**
 * A stable version is on every channel. A prerelease is on its own channel,
 * and on a later one only if that channel comes earlier on the ladder, so
 * the beta line may start from an alpha base but alpha never starts from beta.
 * Channels off the ladder match only their own tags.
 */
export const isOnChannel = (version: string, channel: string | undefined): boolean => {
    if (channel === undefined) {
        return true;
    }

    const identifier = channelOf(version);

    if (identifier === undefined || identifier === channel) {
        return true;
    }

    const channelRank = PRERELEASE_LADDER.indexOf(channel);
    const identifierRank = PRERELEASE_LADDER.indexOf(identifier);

    return channelRank !== -1 && identifierRank !== -1 && identifierRank < channelRank;
};

export { channelOf, PRERELEASE_LADDER };

export const bumpVersion = (input: BumpInput): string => {
    const { current, prerelease } = input;
    let { bump } = input;

    if (!semver.valid(current)) {
        throw new VisReleaseError({
            code: "CONFIG_INVALID",
            message: `Invalid current version: ${JSON.stringify(current)}`,
        });
    }

    const currentParsed = semver.parse(current)!;
    const currentChannel = channelOf(current);
    const currentIsPrerelease = currentParsed.prerelease.length > 0;

    // Pre-1.0 demotion. Apply before the rest of the logic so escalation
    // paths through prerelease channels (alpha/beta/rc) see the demoted
    // level too. Demotion is a no-op once `current.major >= 1`.
    if (currentParsed.major === 0 && input.bumpMinorPreMajor) {
        if (bump === "major") {
            bump = "minor";
        }

        if (bump === "minor" && input.bumpPatchForMinorPreMajor) {
            bump = "patch";
        }
    }

    // Case 1: no bump requested + channel transition.
    if (bump === "none") {
        // Same channel, same version — just return.
        if (currentChannel === prerelease) {
            return current;
        }

        // Stable → prerelease (open new prerelease line on the SAME version).
        if (!currentIsPrerelease && prerelease) {
            return `${currentParsed.major}.${currentParsed.minor}.${currentParsed.patch}-${prerelease}.0`;
        }

        // Prerelease → stable (collapse — strip preid).
        if (currentIsPrerelease && !prerelease) {
            return `${currentParsed.major}.${currentParsed.minor}.${currentParsed.patch}`;
        }

        // Prerelease → different prerelease (re-counter on new preid).
        if (currentIsPrerelease && prerelease) {
            return `${currentParsed.major}.${currentParsed.minor}.${currentParsed.patch}-${prerelease}.0`;
        }

        return current;
    }

    // Case 2: explicit bump.
    if (currentIsPrerelease && prerelease && currentChannel === prerelease) {
        // Bumping within the same prerelease line.
        // - If the requested bump is <= the level that opened the line (e.g. a
        //   `patch` on a `minor`-opened line), just increment the counter.
        // - If the requested bump escalates above the line's base, strip the
        //   preid, perform the bump, and reapply the preid at .0.
        const baseType = inferBaseTypeFromPrerelease(currentParsed);

        if (RELEASE_TYPE_RANK[bump] <= RELEASE_TYPE_RANK[baseType]) {
            const next = bumpCounter(current, prerelease);

            if (!next) {
                throw new VisReleaseError({
                    code: "CONFIG_INVALID",
                    message: `semver.inc returned null for prerelease bump on ${current}`,
                });
            }

            return next;
        }

        // Escalation — e.g. on alpha line `1.3.0-alpha.5`, user requests `major`.
        const stable = `${currentParsed.major}.${currentParsed.minor}.${currentParsed.patch}`;
        const escalated = semver.inc(stable, bump);

        if (!escalated) {
            throw new VisReleaseError({
                code: "CONFIG_INVALID",
                message: `semver.inc returned null for ${bump} bump on ${stable}`,
            });
        }

        return `${escalated}-${prerelease}.0`;
    }

    // Everything else — stable → stable, stable → prerelease, and a
    // prerelease graduating to stable or switching preid — bumps `current`
    // itself, not its stripped base. semver.inc on a prerelease only moves
    // past the base when the bump exceeds what the base already covers
    // (`1.0.0-alpha.76` + minor → `1.0.0`, + patch on `1.2.1-rc.0` → `1.2.1`,
    // + major on `1.3.0-rc.0` → `2.0.0`), which is semantic-release's rule.
    const next = semver.inc(current, bump);

    if (!next) {
        throw new VisReleaseError({
            code: "CONFIG_INVALID",
            message: `semver.inc returned null for ${bump} bump on ${current}`,
        });
    }

    return prerelease ? `${next}-${prerelease}.0` : next;
};

/**
 * Increments the trailing counter of a same-channel prerelease. `semver.inc`
 * only recognises a single-word identifier, so `1.0.0-42.3` or
 * `1.0.0-alpha.canary.4` would otherwise restart at `.0`.
 */
const bumpCounter = (current: string, channel: string): string | null => {
    const parsed = semver.parse(current)!;
    const counter = parsed.prerelease.at(-1);

    if (typeof counter !== "number") {
        return semver.inc(current, "prerelease", channel);
    }

    return `${parsed.major}.${parsed.minor}.${parsed.patch}-${channel}.${counter + 1}`;
};

/**
 * Heuristic: given a prerelease version like `1.3.0-alpha.0`, infer what
 * release type opened the line. `1.x.0` → minor, `1.0.x` → patch, `x.0.0` → major.
 * Used to decide whether a bump within the same prerelease is a counter
 * increment or an escalation.
 */
const RELEASE_TYPE_RANK: Record<ReleaseType, number> = { major: 3, minor: 2, patch: 1 };

const inferBaseTypeFromPrerelease = (parsed: semver.SemVer): ReleaseType => {
    if (parsed.minor === 0 && parsed.patch === 0) {
        return "major";
    }

    if (parsed.patch === 0) {
        return "minor";
    }

    return "patch";
};

// ── Range satisfaction (re-export semver helpers) ───────────────────

/**
 * Check whether `version` satisfies `range`. Wraps `semver.satisfies`
 * with `includePrerelease: true` so prerelease versions can match
 * non-prerelease ranges (the propagation algorithm needs this — without it,
 * every prerelease bump would propagate everywhere as out-of-range).
 */
export const satisfiesRange = (version: string, range: string): boolean => {
    const cleaned = cleanRange(range);

    if (!cleaned) {
        // Unparseable / catalog: / workspace shorthand — treat as "always satisfied".
        return true;
    }

    return semver.satisfies(version, cleaned, { includePrerelease: true });
};

/**
 * Strip workspace/catalog protocol prefixes from a dep range and return the
 * underlying semver expression. Returns `null` for ranges that have no
 * meaningful semver constraint (`workspace:*`, `catalog:`, etc. — these are
 * effectively "always satisfied" until the publish step rewrites them).
 */
export const cleanRange = (range: string): string | null => {
    if (!range) {
        return null;
    }

    if (range.startsWith("catalog:")) {
        return null;
    }

    if (range === "*" || range === "workspace:*" || range === "workspace:^" || range === "workspace:~") {
        return null;
    }

    if (range.startsWith("workspace:")) {
        const stripped = range.slice("workspace:".length);

        if (stripped === "*" || stripped === "^" || stripped === "~") {
            return null;
        }

        return stripped;
    }

    if (range.startsWith("npm:")) {
        // npm:<name>@<spec>
        const at = range.lastIndexOf("@");

        if (at > "npm:".length) {
            return range.slice(at + 1);
        }

        return null;
    }

    return range;
};
