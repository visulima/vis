import { coerce, compare, parse } from "semver";

import type { ParsedVersion, ReleaseChannel } from "./types";

const PREFIX_REGEX = /^([\^~]|>=|<=|[><=])/;

export const parseVersion = (input: string): ParsedVersion | undefined => {
    // Strip range prefixes (^, ~, >=, <=, >, <) before parsing
    const stripped = input.replace(/^[\^~]|^>=|^<=|^[><]/, "");

    // Try parse first (handles exact semver like "5.3.0-beta.1")
    const parsed = parse(stripped);

    if (parsed) {
        return {
            major: parsed.major,
            minor: parsed.minor,
            patch: parsed.patch,
            prerelease: Array.isArray(parsed.prerelease) ? parsed.prerelease.join(".") : String(parsed.prerelease ?? ""),
        };
    }

    // coerce handles partial versions like "19" -> "19.0.0"
    const coerced = coerce(input);

    if (coerced) {
        return {
            major: coerced.major,
            minor: coerced.minor,
            patch: coerced.patch,
            prerelease: "",
        };
    }

    return undefined;
};

export const extractPrefix = (range: string): string => {
    const match = PREFIX_REGEX.exec(range);

    return match?.[1] ?? "";
};

/**
 * Extract the prerelease channel identifier — `"alpha"`, `"rc"`, `"beta-dev"`
 * etc. — from a parsed version. Returns the empty string for stable releases.
 *
 * The channel is the first dot-separated tag, ignoring trailing numeric ids
 * (`alpha.5`, `rc.0`, `beta`). Mirrors how Renovate / syncpack group
 * prereleases when applying their `releaseChannel` policy.
 */
const extractChannel = (version: ParsedVersion): string => {
    if (!version.prerelease) {
        return "";
    }

    const head = version.prerelease.split(".")[0] ?? "";

    return /^\d+$/.test(head) ? "" : head;
};

export const matchesReleaseChannel = (candidate: ParsedVersion, current: ParsedVersion, releaseChannel: ReleaseChannel | undefined): boolean => {
    if (releaseChannel === "any") {
        return true;
    }

    if (releaseChannel === "same") {
        return extractChannel(candidate) === extractChannel(current);
    }

    return candidate.prerelease === "";
};

const versionToString = (v: ParsedVersion): string => {
    const base = `${String(v.major)}.${String(v.minor)}.${String(v.patch)}`;

    return v.prerelease ? `${base}-${v.prerelease}` : base;
};

export const getUpdateType = (current: ParsedVersion, target: ParsedVersion): "major" | "minor" | "none" | "patch" => {
    if (current.major !== target.major) {
        return "major";
    }

    if (current.minor !== target.minor) {
        return "minor";
    }

    if (current.patch !== target.patch) {
        return "patch";
    }

    if (current.prerelease !== target.prerelease) {
        return "patch";
    }

    return "none";
};

const compareVersions = (a: ParsedVersion, b: ParsedVersion): number => {
    if (a.major !== b.major) {
        return a.major - b.major;
    }

    if (a.minor !== b.minor) {
        return a.minor - b.minor;
    }

    if (a.patch !== b.patch) {
        return a.patch - b.patch;
    }

    // No prerelease is greater than any prerelease
    if (!a.prerelease && b.prerelease) {
        return 1;
    }

    if (a.prerelease && !b.prerelease) {
        return -1;
    }

    if (a.prerelease && b.prerelease) {
        return compare(versionToString(a), versionToString(b));
    }

    return 0;
};

export const isNewer = (current: ParsedVersion, target: ParsedVersion): boolean => compareVersions(target, current) > 0;

/** Formats a ParsedVersion as "major.minor.patch", or "" if parsing failed. */
export const formatVersionString = (parsed: ParsedVersion | undefined): string => (parsed ? versionToString(parsed) : "");
