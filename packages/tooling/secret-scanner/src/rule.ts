// Typed authoring helpers for custom rules. `defineRule` compiles a
// TypeScript-friendly description into the plain gitleaks-shaped object the
// native scanner consumes. No runtime loader is involved: import the compiled
// JavaScript config as usual.

/* eslint-disable no-param-reassign, no-plusplus, default-case, sonarjs/cognitive-complexity -- the keyword parser is a small recursive-descent scanner with an explicit cursor */

import type { GitleaksRule } from "./config-loader";
import type { Confidence } from "./types";

/** Default shortest literal worth using as an Aho-Corasick prefilter keyword. */
export const DEFAULT_KEYWORD_MIN_LENGTH = 4;

const MAX_KEYWORDS = 8;

/** `true` when an input rule has no keywords and therefore runs on every file. */
export type KeywordHint = "auto" | false | string[];

export interface RuleInput {
    // Anything else the native rule schema understands (validation,
    // patternRequirements, preRegexReplace, …) passes through untouched.
    [key: string]: unknown;
    /** Native allowlist entries, either the singular or the plural gitleaks field. */
    allowlist?: unknown;
    allowlists?: unknown[];
    /** Author-declared quality signal; defaults to `low`. */
    confidence?: Confidence;

    /** Always emit this rule when the ruleset is loaded. */
    defaultEnabled?: boolean;

    description: string;
    /** Flag entropy threshold. */
    entropy?: number;
    id: string;
    /** Shortest fragment `keywords: "auto"` will use. Default: 4. */
    keywordMinLength?: number;

    /**
     * Literal prefilter hints. `"auto"` extracts only literals that are
     * mandatory on every path through the regex; `false` (or an empty result)
     * leaves the keyword list off so the rule always runs. Explicit strings
     * replace inference entirely — make sure they match every candidate.
     */
    keywords?: KeywordHint;
    /** Path filter, for rules that match file names rather than content. */
    path?: string;
    /** Rule priority on overlapping spans. */
    priority?: number;
    regex: string | RegExp;
    /** Compiled dependency ids for composite rules. */
    required?: unknown[];
    /** Capture-group index holding the secret; defaults to the whole match. */
    secretGroup?: number;
    /** Rule provenance. Keep the source's own value when wrapping a rule. */
    source?: string;
    tags?: string[];
}

/** A rule ready to put in `config.inline.rules` or a config file. */
export type DefinedRule = GitleaksRule & { id: string; regex: string };

const NON_LITERAL_ESCAPES = new Set(["0", "A", "B", "b", "d", "D", "f", "n", "r", "s", "S", "t", "v", "w", "W", "Z", "z"]);

interface ParseState {
    index: number;
}

/** Intersect literal fragments so a keyword is mandatory on every branch. */
const intersect = (groups: string[][]): string[] => {
    const [first, ...rest] = groups;

    if (first === undefined) {
        return [];
    }

    return first.filter((fragment) => rest.every((group) => group.includes(fragment)));
};

/** Skip a `(?…)` group we can't reason about, including its nested parentheses. */
const skipGroup = (source: string, state: ParseState): void => {
    let depth = 1;

    while (state.index < source.length && depth > 0) {
        const char = source[state.index++] as string;

        switch (char) {
            case "(": {
                depth += 1;

                break;
            }
            case ")": {
                depth -= 1;

                break;
            }
            case "[": {
                while (state.index < source.length && source[state.index] !== "]") {
                    if (source[state.index] === "\\") {
                        state.index += 1;
                    }

                    state.index += 1;
                }
                state.index += 1;

                break;
            }
            case "\\": {
                state.index += 1;

                break;
            }
            // No default
        }
    }
};

type Quantifier = "none" | "optional" | "repeated";

/** Consume the quantifier following a token and classify its minimum count. */
const readQuantifier = (source: string, state: ParseState): Quantifier => {
    const char = source[state.index];

    if (char === "?") {
        state.index += 1;

        return "optional";
    }

    if (char === "*") {
        state.index += 1;

        return "optional";
    }

    if (char === "+") {
        state.index += 1;

        return "repeated";
    }

    if (char !== "{") {
        return "none";
    }

    const end = source.indexOf("}", state.index);
    const body = end === -1 ? undefined : source.slice(state.index + 1, end);

    state.index = end === -1 ? source.length : end + 1;

    const minimum = Number.parseInt(body?.split(",")[0] ?? "1", 10);

    return Number.isNaN(minimum) || minimum > 0 ? "repeated" : "optional";
};

/**
 * Collect literal fragments that must be present for a regex to match.
 * Alternatives are intersected at every level, escaped punctuation is
 * unescaped, character classes and non-consuming groups contribute nothing,
 * and optional tokens are dropped. Anything ambiguous yields no keywords —
 * an always-run rule is slower but never a false negative.
 */
const mandatoryFragments = (pattern: string): string[] => {
    const parse = (source: string, state: ParseState, nested: boolean): string[][] => {
        const alternatives: string[][] = [[]];
        let current = alternatives[0] as string[];
        let literal = "";
        let lastWasLiteral = false;
        const flush = (): void => {
            if (literal.length > 0) {
                current.push(literal);
                literal = "";
                lastWasLiteral = true;
            }
        };
        const trimLast = (): void => {
            if (!lastWasLiteral) {
                return;
            }

            const last = current.at(-1);

            if (last === undefined) {
                return;
            }

            const trimmed = last.slice(0, -1);

            if (trimmed.length === 0) {
                current.pop();
            } else {
                current[current.length - 1] = trimmed;
            }
        };

        while (state.index < source.length) {
            const char = source[state.index++] as string;

            if (nested && char === ")") {
                break;
            }

            if (char === "\\") {
                const next = source[state.index++];

                if (next === undefined) {
                    break;
                }

                if (NON_LITERAL_ESCAPES.has(next)) {
                    flush();
                    lastWasLiteral = false;
                    continue;
                }

                if (next === "p" || next === "P") {
                    flush();
                    lastWasLiteral = false;

                    while (state.index < source.length && source[state.index] !== "}") {
                        state.index += 1;
                    }
                    state.index += 1;
                    continue;
                }

                if (next === "x" || next === "u") {
                    flush();
                    lastWasLiteral = false;

                    if (source[state.index] === "{") {
                        while (state.index < source.length && source[state.index] !== "}") {
                            state.index += 1;
                        }
                        state.index += 1;
                    } else {
                        state.index += next === "x" ? 2 : 4;
                    }

                    continue;
                }

                if (next === "k" && source[state.index] === "<") {
                    flush();
                    lastWasLiteral = false;

                    while (state.index < source.length && source[state.index] !== ">") {
                        state.index += 1;
                    }
                    state.index += 1;
                    continue;
                }

                literal += next;
                continue;
            }

            if (char === "[") {
                flush();
                lastWasLiteral = false;

                while (state.index < source.length && source[state.index] !== "]") {
                    if (source[state.index] === "\\") {
                        state.index += 1;
                    }

                    state.index += 1;
                }
                state.index += 1;
                continue;
            }

            if (char === "(") {
                flush();
                lastWasLiteral = false;

                if (source[state.index] === "?") {
                    let cursor = state.index + 1;

                    while (cursor < source.length && "imsUx-".includes(source[cursor] as string)) {
                        cursor += 1;
                    }

                    const terminator = source[cursor];

                    if (terminator === ")") {
                        // Bare inline flags `(?i)` apply from here on; they don't
                        // form a group with its own alternatives.
                        state.index = cursor + 1;
                        continue;
                    }

                    if (terminator !== ":") {
                        skipGroup(source, state);
                        continue;
                    }

                    state.index = cursor + 1;
                }

                const inner = parse(source, state, true);
                const quantifier = readQuantifier(source, state);

                if (quantifier !== "optional") {
                    current.push(...intersect(inner));
                }

                lastWasLiteral = false;
                continue;
            }

            if (char === "|") {
                flush();
                lastWasLiteral = false;
                current = [];
                alternatives.push(current);
                continue;
            }

            if (char === "*" || char === "?") {
                flush();
                trimLast();
                lastWasLiteral = false;
                continue;
            }

            if (char === "{") {
                flush();
                const quantifier = readQuantifier(source, state);

                if (quantifier === "optional") {
                    trimLast();
                }

                lastWasLiteral = false;
                continue;
            }

            if (char === "." || char === "^" || char === "$" || char === "+" || char === "}") {
                flush();
                lastWasLiteral = false;
                continue;
            }

            literal += char;
        }

        flush();

        return alternatives;
    };

    return intersect(parse(pattern, { index: 0 }, false));
};

/** The native keyword prefilter lowercases and matches ASCII only. */
const isAscii = (value: string): boolean => {
    for (const character of value) {
        const codePoint = character.codePointAt(0);

        if (codePoint === undefined || codePoint > 0x7f) {
            return false;
        }
    }

    return true;
};

/**
 * Suggest conservative prefilter keywords for a regex. Only ASCII literals are
 * eligible: the native matcher is ASCII-case-insensitive, so a non-ASCII
 * fragment would be lowercased and then fail to match uppercase content.
 * Returns an empty array when no fragment is safe, meaning the rule always runs.
 */
export const inferKeywords = (pattern: string, options: { minLength?: number } = {}): string[] => {
    const minLength = options.minLength ?? DEFAULT_KEYWORD_MIN_LENGTH;

    return [...new Set(mandatoryFragments(pattern))]
        .filter((fragment) => fragment.length >= minLength && isAscii(fragment))
        .map((fragment) => fragment.toLowerCase())
        .toSorted((a, b) => b.length - a.length || a.localeCompare(b))
        .slice(0, MAX_KEYWORDS);
};

const normalizeKeywords = (keywords: string[]): string[] => {
    const nonAscii = keywords.find((keyword) => !isAscii(keyword));

    if (nonAscii !== undefined) {
        throw new TypeError(`Keyword ${JSON.stringify(nonAscii)} isn't ASCII; the native prefilter only supports ASCII keywords. Use keywords: false.`);
    }

    return [...new Set(keywords.map((keyword) => keyword.toLowerCase()))];
};

const normalizePattern = (regex: string | RegExp): string => {
    if (typeof regex === "string") {
        if (regex.length === 0) {
            throw new TypeError("A rule regex can't be empty.");
        }

        // Pass strings through untouched: Rust accepts `\/` as a literal `/`,
        // and rewriting it would corrupt an already-escaped backslash (`\\/`).
        return regex;
    }

    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- regex flags are ASCII
    const unsupported = [...regex.flags].filter((flag) => !"ims".includes(flag));

    if (unsupported.length > 0) {
        throw new TypeError(`RegExp flags ${unsupported.join("")} can't be represented by the native regex engine; use i, m and s only.`);
    }

    // RegExp.prototype.source keeps JS's `/` escape; Rust understands it too.
    const inline = ["i", "m", "s"].filter((flag) => regex.flags.includes(flag)).join("");

    return inline === "" ? regex.source : `(?${inline})${regex.source}`;
};

/** Compile a typed rule definition into the native config's plain object. */
export const defineRule = (input: RuleInput): DefinedRule => {
    if (input.id.trim() === "") {
        throw new TypeError("A rule needs a non-empty id.");
    }

    const { keywordMinLength = DEFAULT_KEYWORD_MIN_LENGTH, keywords: keywordHint = "auto", regex, ...rest } = input;
    const pattern = normalizePattern(regex);
    const rule: DefinedRule = { ...rest, id: input.id, regex: pattern };

    if (keywordHint === false) {
        return rule;
    }

    const keywords = keywordHint === "auto" ? inferKeywords(pattern, { minLength: keywordMinLength }) : normalizeKeywords(keywordHint);

    if (keywords.length > 0) {
        rule.keywords = keywords;
    }

    return rule;
};

/** Compile several definitions into an inline ruleset. */
export const defineRuleset = (rules: RuleInput[], title = "custom"): { rules: DefinedRule[]; title: string } => {
    return { rules: rules.map((rule) => defineRule(rule)), title };
};
