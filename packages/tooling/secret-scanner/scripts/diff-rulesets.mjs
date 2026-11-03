// Compare two `ruleset.json` files and summarise rule ids that were added,
// removed, renamed or changed. Used by the rules-sync workflow for the PR body
// and by humans reviewing a `.ref` bump. Rule ids end up in user baselines and
// `rules.disable` lists, so removed and renamed ids are the part to read.
//
// Usage: node scripts/diff-rulesets.mjs <old ruleset.json> <new ruleset.json>
//
// A removed id and an added id count as a rename when they come from the same
// source and share the same regex (or, for path-only rules, the same path).

import { readFileSync } from "node:fs";
import { argv, exit, stdout } from "node:process";

const WHITESPACE_PATTERN = /\s+/g;

const loadRules = (path) => {
    const rules = JSON.parse(readFileSync(path, "utf8")).rules ?? [];

    return new Map(rules.filter((rule) => typeof rule?.id === "string").map((rule) => [rule.id, rule]));
};

// Free-spacing (`(?x)`) Kingfisher patterns get reformatted upstream without
// changing what they match; compare without whitespace.
const matcherOf = (rule) => `${rule.source ?? ""}\u0000${(rule.regex ?? "").replaceAll(WHITESPACE_PATTERN, "")}\u0000${rule.path ?? ""}`;

const detectionOf = (rule) =>
    JSON.stringify({
        entropy: rule.entropy,
        keywords: rule.keywords,
        path: rule.path,
        patternRequirements: rule.patternRequirements,
        regex: rule.regex,
        secretGroup: rule.secretGroup,
    });

export const diffRulesets = (oldRules, newRules) => {
    const removed = [...oldRules.keys()].filter((id) => !newRules.has(id));
    const added = [...newRules.keys()].filter((id) => !oldRules.has(id));
    const changed = [...newRules.keys()].filter((id) => oldRules.has(id) && detectionOf(oldRules.get(id)) !== detectionOf(newRules.get(id)));

    const addedByMatcher = new Map();

    for (const id of added) {
        const key = matcherOf(newRules.get(id));

        if (!addedByMatcher.has(key)) {
            addedByMatcher.set(key, []);
        }

        addedByMatcher.get(key).push(id);
    }

    const renamed = [];

    for (const id of removed) {
        const candidates = addedByMatcher.get(matcherOf(oldRules.get(id)));

        if (candidates && candidates.length > 0) {
            renamed.push({ from: id, to: candidates.shift() });
        }
    }

    const renamedFrom = new Set(renamed.map((entry) => entry.from));
    const renamedTo = new Set(renamed.map((entry) => entry.to));

    return {
        added: added.filter((id) => !renamedTo.has(id)).toSorted(),
        changed: changed.toSorted(),
        newCount: newRules.size,
        oldCount: oldRules.size,
        removed: removed.filter((id) => !renamedFrom.has(id)).toSorted(),
        renamed: renamed.toSorted((a, b) => a.from.localeCompare(b.from)),
    };
};

const idList = (ids) => (ids.length === 0 ? "_none_\n" : `${ids.map((id) => `- \`${id}\``).join("\n")}\n`);

export const formatMarkdown = (diff) => {
    const lines = [
        `Rules: ${diff.oldCount} -> ${diff.newCount}. Added ${diff.added.length}, removed ${diff.removed.length}, renamed ${diff.renamed.length}, detection changed ${diff.changed.length}.`,
        "",
        `### Removed ids (${diff.removed.length})`,
        "",
        "Baselines and `rules.disable` entries naming these ids stop matching.",
        "",
        idList(diff.removed),
        `### Renamed ids (${diff.renamed.length})`,
        "",
        diff.renamed.length === 0 ? "_none_\n" : `${diff.renamed.map(({ from, to }) => `- \`${from}\` -> \`${to}\``).join("\n")}\n`,
        `### Added ids (${diff.added.length})`,
        "",
        "<details><summary>Show</summary>",
        "",
        idList(diff.added),
        "</details>",
        "",
        `### Same id, detection changed (${diff.changed.length})`,
        "",
        "<details><summary>Show</summary>",
        "",
        idList(diff.changed),
        "</details>",
        "",
    ];

    return lines.join("\n");
};

if (import.meta.url === `file://${argv[1]}`) {
    if (argv.length < 4) {
        // eslint-disable-next-line no-console -- CLI usage
        console.error("usage: node scripts/diff-rulesets.mjs <old ruleset.json> <new ruleset.json>");
        exit(2);
    }

    stdout.write(formatMarkdown(diffRulesets(loadRules(argv[2]), loadRules(argv[3]))));
}
