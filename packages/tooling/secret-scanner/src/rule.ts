// Typed authoring helpers for custom rules. `defineRule` compiles a
// TypeScript-friendly description into the plain gitleaks-shaped object the
// native scanner consumes. No runtime loader is involved: import the compiled
// JavaScript config as usual.

import type { GitleaksRule } from "./config-loader";
import type { Confidence } from "./types";

/** Default shortest literal worth using as an Aho-Corasick prefilter keyword. */
export const DEFAULT_KEYWORD_MIN_LENGTH = 4;

const MAX_KEYWORDS = 8;

// The native keyword window reaches 4 KiB past a hit; stay well inside it so a match that
// contains a keyword also contains the text the regex needs to reach it.
const MAX_MATCH_SPAN = 2048;

/** How a rule's prefilter keywords are chosen: inferred from the regex, none, or an explicit list. */
export type KeywordHint = "auto" | false | string[];

/** Native allowlist entry, in the gitleaks shape. */
export interface RuleAllowlist {
    commits?: string[];
    /** `"AND"` requires every populated field to match; the default is `"OR"`. */
    condition?: string;
    description?: string;
    paths?: string[];
    regexes?: string[];
    regexTarget?: string;
    stopwords?: string[];
    targetRules?: string[];
}

/** Cheap post-match filters applied to the captured secret. */
export interface RulePatternRequirements {
    ignoreIfContains?: string[];
    minDigits?: number;
    minLength?: number;
    minLowercase?: number;
    minUppercase?: number;
}

/** A composite-rule dependency: another rule that must also fire in the same file. */
export interface RuleRequirement {
    id: string;
    withinColumns?: number;
    withinLines?: number;
}

export interface RuleInput {
    /** Native allowlist entries, either the singular or the plural gitleaks field. */
    allowlist?: RuleAllowlist | RuleAllowlist[];
    allowlists?: RuleAllowlist[];
    /** Author-declared quality signal; defaults to `low`. */
    confidence?: Confidence;

    /**
     * Rules are on by default. Set `false` to make the rule opt-in: it only
     * runs when its id is listed in `rules.enable` or `rules.include`.
     */
    defaultEnabled?: boolean;

    description: string;
    /** Flag entropy threshold. */
    entropy?: number;
    id: string;
    /** Shortest fragment `keywords: "auto"` will use. Default: 4. */
    keywordMinLength?: number;

    /**
     * Literal prefilter hints. `"auto"` extracts only literals that are
     * mandatory on every path through the regex, and returns none when it
     * can't fully understand the regex, when the regex is case-insensitive
     * (no `k` or `s` keywords), when its counted repetitions can span more
     * than the native keyword window, or when `preRegexReplace` is set;
     * `false` (or an empty result) leaves the keyword list off so the rule
     * always runs. Explicit strings replace
     * inference entirely — make sure they match every candidate.
     */
    keywords?: KeywordHint;
    /** Path filter, for rules that match file names rather than content. */
    path?: string;
    patternRequirements?: RulePatternRequirements;
    /** Ordered replacements applied to file content before the rule's regex runs. */
    preRegexReplace?: { from: string; to?: string }[];
    /** Rule priority on overlapping spans. */
    priority?: number;
    regex: string | RegExp;
    /** Compiled dependency rules for composite rules. */
    required?: RuleRequirement[];
    /** Capture-group index holding the secret; defaults to the whole match. */
    secretGroup?: number;
    /** Run the rule so others can require it, but never report its own findings. */
    skipReport?: boolean;
    /** Rule provenance. Keep the source's own value when wrapping a rule. */
    source?: string;
    tags?: string[];
}

/** A rule ready to put in `config.inline.rules` or a config file. */
export type DefinedRule = GitleaksRule & { id: string; regex: string };

/** Raised internally when the regex uses a construct the inference doesn't fully model. */
class UnsupportedPattern extends Error {}

const bail = (): never => {
    throw new UnsupportedPattern("unsupported regex construct");
};

interface ParseState {
    index: number;
}

/** Escapes that match a class or a position and contribute no literal text. */
const ATOM_ESCAPES = new Set(["A", "a", "B", "b", "D", "d", "f", "n", "r", "S", "s", "t", "v", "W", "w", "Z", "z"]);
const CODE_POINT_ESCAPE_WIDTH: Record<string, number> = { U: 8, u: 4, x: 2 };
const FLAG_GROUP = /\?[imsUuR-]*([:)])/y;
const POSIX_CLASS = /^:\^?[a-z]+:\]/;
const QUANTIFIER_BRACES = /\{(\d+)(?:,\d*)?\}/y;
// Verbose mode makes whitespace and `#` comments insignificant, so a scan can't tell literals from comments.
const COUNTED_REPETITION = /\{(\d+)(?:,(\d*))?\}/g;
// Unicode case folding lets U+212A (Kelvin) match `k` and U+017F (long s) match `s`, which the ASCII-only prefilter can't see.
const CASE_FOLDING_LETTER = /[ks]/;
const CASE_INSENSITIVE_FLAG = /\(\?[msUuR]*i/;
const VERBOSE_FLAG = /\(\?[imsUuR-]*x[imsUuR-]*[:)]/;
// Rust accepts a backslash before any ASCII character except alphanumerics and `<`/`>` (word boundaries).
const LITERAL_ESCAPE = /^(?![\dA-Z<>])[\0-\u007F]$/i;

/** Intersect literal fragments so a keyword is mandatory on every branch. */
const intersect = (groups: string[][]): string[] => {
    const [first, ...rest] = groups;

    if (first === undefined) {
        return [];
    }

    return first.filter((fragment) => rest.every((group) => group.includes(fragment)));
};

/* eslint-disable no-param-reassign, no-plusplus, sonarjs/cognitive-complexity -- the scanner helpers advance a shared cursor */

/** Move the cursor just past the next `terminator`, or give up if there is none. */
const skipPast = (source: string, state: ParseState, terminator: string): void => {
    const end = source.indexOf(terminator, state.index);

    if (end === -1) {
        bail();
    }

    state.index = end + terminator.length;
};

/**
 * Skip a character class whose `[` was just consumed: a leading `^`, a leading
 * literal `]`, escapes, POSIX `[:alpha:]` items and nested classes.
 */
const skipClass = (source: string, state: ParseState): void => {
    if (source[state.index] === "^") {
        state.index += 1;
    }

    if (source[state.index] === "]") {
        state.index += 1;
    }

    while (state.index < source.length) {
        const char = source[state.index];

        state.index += 1;

        switch (char) {
            case "[": {
                const posix = POSIX_CLASS.exec(source.slice(state.index));

                if (posix === null) {
                    skipClass(source, state);
                } else {
                    state.index += posix[0].length;
                }

                break;
            }
            case "\\": {
                state.index += 1;

                break;
            }
            case "]": {
                return;
            }
            default: {
                break;
            }
        }
    }

    bail();
};

/** Skip a `(?…)` group we can't reason about, including its nested parentheses. */
const skipGroup = (source: string, state: ParseState): void => {
    let depth = 1;

    while (state.index < source.length && depth > 0) {
        const char = source[state.index];

        state.index += 1;

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
                skipClass(source, state);

                break;
            }
            case "\\": {
                state.index += 1;

                break;
            }
            default: {
                break;
            }
        }
    }

    if (depth > 0) {
        bail();
    }
};

type Quantifier = "none" | "optional" | "repeated";

/** Consume the quantifier at the cursor and classify its minimum count. */
const readQuantifier = (source: string, state: ParseState): Quantifier => {
    const char = source[state.index];

    if (char === "?" || char === "*") {
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

    QUANTIFIER_BRACES.lastIndex = state.index;

    const braces = QUANTIFIER_BRACES.exec(source);

    if (braces === null) {
        return bail();
    }

    state.index = QUANTIFIER_BRACES.lastIndex;

    return Number(braces[1]) === 0 ? "optional" : "repeated";
};

/**
 * Consume the escape whose backslash was just read. Returns the literal text
 * it stands for, or `undefined` for an escape that matches a class, a
 * position or a code point we don't model as text. Anything outside the
 * known sets (backreferences, `\h`, `\K`, `\&lt;`, `\b{start}`, …) gives up.
 */
const readEscape = (source: string, state: ParseState): string | undefined => {
    const next = source[state.index];

    state.index += 1;

    if (next === undefined) {
        return bail();
    }

    if (LITERAL_ESCAPE.test(next)) {
        return next;
    }

    if ((next === "b" || next === "B") && source[state.index] === "{") {
        return bail();
    }

    if (ATOM_ESCAPES.has(next)) {
        return undefined;
    }

    const codePointWidth = CODE_POINT_ESCAPE_WIDTH[next];

    if (codePointWidth === undefined && next !== "p" && next !== "P") {
        return bail();
    }

    if (source[state.index] === "{") {
        skipPast(source, state, "}");
    } else {
        state.index += codePointWidth ?? 1;
    }

    return undefined;
};

/**
 * Parse one sequence (a whole pattern or a group body) into its alternatives,
 * each a list of literal fragments that every match of that alternative contains.
 */
const parseSequence = (source: string, state: ParseState, nested: boolean): string[][] => {
    const alternatives: string[][] = [[]];
    let current = alternatives[0] as string[];
    let literal = "";
    let lastWasLiteral = false;
    let closed = !nested;
    const flush = (): void => {
        if (literal.length > 0) {
            current.push(literal);
            literal = "";
            lastWasLiteral = true;
        }
    };
    const breakLiteral = (): void => {
        flush();
        lastWasLiteral = false;
    };
    const trimLast = (): void => {
        const last = lastWasLiteral ? current.at(-1) : undefined;

        if (last === undefined) {
            return;
        }

        if (last.length === 1) {
            current.pop();
        } else {
            current[current.length - 1] = last.slice(0, -1);
        }
    };

    while (state.index < source.length) {
        const char = source[state.index++] as string;

        if (char === ")") {
            if (!nested) {
                bail();
            }

            closed = true;

            break;
        }

        switch (char) {
            case "$":
            case ".":
            case "^": {
                breakLiteral();

                break;
            }
            case "(": {
                breakLiteral();

                if (source[state.index] === "?") {
                    FLAG_GROUP.lastIndex = state.index;

                    const flags = FLAG_GROUP.exec(source);

                    if (flags === null) {
                        skipGroup(source, state);

                        continue;
                    }

                    state.index = FLAG_GROUP.lastIndex;

                    // Bare inline flags `(?i)` apply from here on; they have no body.
                    if (flags[1] === ")") {
                        continue;
                    }
                }

                const inner = parseSequence(source, state, true);

                if (readQuantifier(source, state) !== "optional") {
                    current.push(...intersect(inner));
                }

                break;
            }
            case "*":
            case "+":
            case "?":
            case "{": {
                state.index -= 1;
                flush();

                if (readQuantifier(source, state) === "optional") {
                    trimLast();
                }

                lastWasLiteral = false;

                break;
            }
            case "[": {
                breakLiteral();
                skipClass(source, state);

                break;
            }
            case "\\": {
                const text = readEscape(source, state);

                if (text === undefined) {
                    breakLiteral();
                } else {
                    literal += text;
                }

                break;
            }
            case "|": {
                breakLiteral();
                current = [];
                alternatives.push(current);

                break;
            }
            case "}": {
                bail();

                break;
            }
            default: {
                literal += char;
            }
        }
    }

    if (!closed) {
        bail();
    }

    flush();

    return alternatives;
};

/* eslint-enable no-param-reassign, no-plusplus, sonarjs/cognitive-complexity */

/** Upper bound on the text counted repetitions can consume, summed over the pattern. */
const countedSpan = (pattern: string): number => {
    let total = 0;

    for (const [, min, max] of pattern.matchAll(COUNTED_REPETITION)) {
        total += Number(max === undefined || max === "" ? min : max);
    }

    return total;
};

/**
 * Collect literal fragments that must be present for a regex to match.
 * Alternatives are intersected at every level, escaped punctuation is
 * unescaped, character classes and non-consuming groups contribute nothing,
 * and optional tokens are dropped. Any construct that isn't fully understood
 * (verbose mode, backreferences, unknown escapes, malformed classes or
 * quantifiers) yields no keywords: an always-run rule is slower but never a
 * false negative.
 */
const mandatoryFragments = (pattern: string): string[] => {
    if (VERBOSE_FLAG.test(pattern) || countedSpan(pattern) > MAX_MATCH_SPAN) {
        return [];
    }

    try {
        return intersect(parseSequence(pattern, { index: 0 }, false));
    } catch (error) {
        if (error instanceof UnsupportedPattern) {
            return [];
        }

        throw error;
    }
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

    const foldsCase = CASE_INSENSITIVE_FLAG.test(pattern);

    return [...new Set(mandatoryFragments(pattern))]
        .filter((fragment) => fragment.length >= minLength && isAscii(fragment) && !(foldsCase && CASE_FOLDING_LETTER.test(fragment.toLowerCase())))
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

    // The native prefilter reads the original content, but a rewritten buffer is what the regex sees.
    if (keywordHint === false || (keywordHint === "auto" && (input.preRegexReplace?.length ?? 0) > 0)) {
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
