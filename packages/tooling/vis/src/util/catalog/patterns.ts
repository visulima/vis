import type { UpdateTarget } from "./types";

const CONSECUTIVE_WILDCARDS_REGEX = /\*+/g;

const GLOB_SPECIAL_CHARS_REGEX = /[.+^${}()|[\]\\]/g;

const globRegexCache = new Map<string, RegExp>();

export const matchesPattern = (name: string, pattern: string): boolean => {
    let regex = globRegexCache.get(pattern);

    if (!regex) {
        // Collapse consecutive wildcards to prevent ReDoS, then convert glob to regex
        const collapsed = pattern.replaceAll(CONSECUTIVE_WILDCARDS_REGEX, "*");
        const escaped = collapsed.replaceAll(GLOB_SPECIAL_CHARS_REGEX, String.raw`\$&`);

        regex = new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`);
        globRegexCache.set(pattern, regex);
    }

    return regex.test(name);
};

export const matchesFilters = (name: string, include: string[], exclude: string[]): boolean => {
    if (exclude.some((p) => matchesPattern(name, p))) {
        return false;
    }

    if (include.length > 0) {
        return include.some((p) => matchesPattern(name, p));
    }

    return true;
};

const packageModeRegexCache = new Map<string, RegExp>();

export const resolvePackageTarget = (packageName: string, globalTarget: UpdateTarget, packageMode?: Record<string, UpdateTarget>): UpdateTarget => {
    if (!packageMode) {
        return globalTarget;
    }

    // Exact matches beat regex / glob patterns so users can override a broad
    // rule for one specific package without worrying about entry ordering.
    const exact = packageMode[packageName];

    if (exact !== undefined) {
        return exact;
    }

    for (const [pattern, target] of Object.entries(packageMode)) {
        if (pattern === packageName) {
            continue;
        }

        if (pattern.startsWith("/") && pattern.endsWith("/")) {
            let regex = packageModeRegexCache.get(pattern);

            if (!regex) {
                regex = new RegExp(pattern.slice(1, -1));
                packageModeRegexCache.set(pattern, regex);
            }

            if (regex.test(packageName)) {
                return target;
            }
        } else if (matchesPattern(packageName, pattern)) {
            return target;
        }
    }

    return globalTarget;
};
