// `allowlists[].commits` support for the git-history scan (gitleaks #2165/#2318).
//
// The native detector never sees a commit SHA, so it ignores the `commits`
// field, and it skips an allowlist that has no paths, regexes or stopwords.
// Commit allowlists are therefore applied here, after detection:
//
//   - A global allowlist whose commit list matches, without `targetRules`,
//     skips the whole commit (nothing in it is scanned).
//   - A global allowlist with `targetRules` drops findings from those rules.
//   - A rule's own allowlist drops that rule's findings.
//
// With the default OR condition a commit match alone is enough. An allowlist
// using `condition = "AND"` that also lists paths, regexes or stopwords needs
// every criterion to match; the history scan passes the commit to the native
// detector, which evaluates those entries, so they are ignored here.
//
// SHAs match exactly (full 40-char id), ignoring case, like gitleaks.

import type { GitleaksConfig } from "./config-loader";

interface RawAllowlist {
    commits?: unknown;
    condition?: unknown;
    paths?: unknown;
    regexes?: unknown;
    stopwords?: unknown;
    targetRules?: unknown;
}

interface RuleWithAllowlists {
    allowlist?: unknown;
    allowlists?: unknown;
    id?: unknown;
}

export interface CommitAllowlist {
    /** Should the whole commit be skipped before any blob is read? */
    isCommitSkipped: (sha: string) => boolean;
    /** Is a finding from `ruleId` in commit `sha` allowlisted? */
    isFindingAllowed: (ruleId: string, sha: string) => boolean;
}

const toList = (value: unknown): RawAllowlist[] => {
    if (Array.isArray(value)) {
        return value.filter((entry): entry is RawAllowlist => typeof entry === "object" && entry !== null);
    }

    return typeof value === "object" && value !== null ? [value] : [];
};

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

const hasEntries = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/** Commits an allowlist matches on by itself, or `undefined` when its commit list can't apply alone. */
const standaloneCommits = (allowlist: RawAllowlist): Set<string> | undefined => {
    const commits = stringList(allowlist.commits);

    if (commits.length === 0) {
        return undefined;
    }

    const isAnd = typeof allowlist.condition === "string" && ["&&", "AND"].includes(allowlist.condition.trim().toUpperCase());
    const hasOtherCriteria = hasEntries(allowlist.paths) || hasEntries(allowlist.regexes) || hasEntries(allowlist.stopwords);

    if (isAnd && hasOtherCriteria) {
        return undefined;
    }

    return new Set(commits.map((commit) => commit.trim().toLowerCase()));
};

/** Each allowlisted commit set with the rules it covers; `undefined` covers every rule. */
const collectGrants = (config: GitleaksConfig | undefined): { commits: Set<string>; ruleIds: string[] | undefined }[] => {
    const grants: { commits: Set<string>; ruleIds: string[] | undefined }[] = [];

    for (const allowlist of [...toList(config?.allowlists), ...toList(config?.allowlist)]) {
        const commits = standaloneCommits(allowlist);
        const targetRules = stringList(allowlist.targetRules);

        if (commits !== undefined) {
            grants.push({ commits, ruleIds: targetRules.length > 0 ? targetRules : undefined });
        }
    }

    for (const rule of (config?.rules ?? []) as RuleWithAllowlists[]) {
        const ruleId = rule?.id;

        if (typeof ruleId !== "string") {
            continue;
        }

        for (const allowlist of [...toList(rule.allowlists), ...toList(rule.allowlist)]) {
            const commits = standaloneCommits(allowlist);

            if (commits !== undefined) {
                grants.push({ commits, ruleIds: [ruleId] });
            }
        }
    }

    return grants;
};

export const buildCommitAllowlist = (config: GitleaksConfig | undefined): CommitAllowlist => {
    const skippedCommits = new Set<string>();
    const ruleCommits = new Map<string, Set<string>>();

    for (const { commits, ruleIds } of collectGrants(config)) {
        if (ruleIds === undefined) {
            commits.forEach((commit) => skippedCommits.add(commit));

            continue;
        }

        for (const ruleId of ruleIds) {
            ruleCommits.set(ruleId, new Set([...(ruleCommits.get(ruleId) ?? []), ...commits]));
        }
    }

    return {
        isCommitSkipped: (sha) => skippedCommits.has(sha.toLowerCase()),
        isFindingAllowed: (ruleId, sha) => ruleCommits.get(ruleId)?.has(sha.toLowerCase()) === true,
    };
};
