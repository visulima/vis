// All known lint-staged config file names.
// JSON-parseable ones come first so they can be auto-migrated.
const LINT_STAGED_JSON_CONFIG_FILES = [".lintstagedrc.json", ".lintstagedrc"] as const;

const LINT_STAGED_OTHER_CONFIG_FILES = [
    ".lintstagedrc.yaml",
    ".lintstagedrc.yml",
    ".lintstagedrc.mjs",
    "lint-staged.config.mjs",
    ".lintstagedrc.cjs",
    "lint-staged.config.cjs",
    ".lintstagedrc.js",
    "lint-staged.config.js",
    ".lintstagedrc.ts",
    "lint-staged.config.ts",
    ".lintstagedrc.mts",
    "lint-staged.config.mts",
    ".lintstagedrc.cts",
    "lint-staged.config.cts",
] as const;

const LINT_STAGED_ALL_CONFIG_FILES: ReadonlyArray<string> = [...LINT_STAGED_JSON_CONFIG_FILES, ...LINT_STAGED_OTHER_CONFIG_FILES];

// Lint-staged invocation patterns — replaced in-place with `vis staged`.
// The optional prefix group captures env var assignments like `NODE_OPTIONS=... `.
const STALE_LINT_STAGED_PATTERNS: ReadonlyArray<RegExp> = [
    // eslint-disable-next-line sonarjs/regex-complexity -- pattern must match all common package runner prefixes
    /^((?:[A-Z_][A-Z0-9_]*(?:=\S*)?\s+)*)(pnpm|pnpm exec|npx|yarn|yarn run|npm exec|npm run|bunx|bun run|bun x)\s+lint-staged\b/,
    /^((?:[A-Z_][A-Z0-9_]*(?:=\S*)?\s+)*)lint-staged\b/,
];

// All known nano-staged config file names.
// JSON-parseable ones come first so they can be auto-migrated.
const NANO_STAGED_JSON_CONFIG_FILES = [".nano-staged.json", ".nanostagedrc"] as const;

const NANO_STAGED_OTHER_CONFIG_FILES = [
    ".nano-staged.mjs",
    ".nano-staged.cjs",
    ".nano-staged.js",
    "nano-staged.config.mjs",
    "nano-staged.config.cjs",
    "nano-staged.config.js",
    "nano-staged.config.mts",
    "nano-staged.config.cts",
    "nano-staged.config.ts",
] as const;

const NANO_STAGED_ALL_CONFIG_FILES: ReadonlyArray<string> = [...NANO_STAGED_JSON_CONFIG_FILES, ...NANO_STAGED_OTHER_CONFIG_FILES];

// Nano-staged invocation patterns — replaced in-place with `vis staged`.
const STALE_NANO_STAGED_PATTERNS: ReadonlyArray<RegExp> = [
    // eslint-disable-next-line sonarjs/regex-complexity -- pattern must match all common package runner prefixes
    /^((?:[A-Z_][A-Z0-9_]*(?:=\S*)?\s+)*)(pnpm|pnpm exec|npx|yarn|yarn run|npm exec|npm run|bunx|bun run|bun x)\s+nano-staged\b/,
    /^((?:[A-Z_][A-Z0-9_]*(?:=\S*)?\s+)*)nano-staged\b/,
];

// Packages removed during the `migrate deps` pass.
// Strictly hook/orchestrator tools that vis natively replaces (vis hook / vis staged).
// Tools with their own dedicated `vis migrate <tool>` command (e.g. sherif, syncpack,
// gitleaks, secretlint) are intentionally NOT listed here — they would otherwise be
// stripped from devDependencies without their scripts/configs being rewritten.
const REPLACED_PACKAGES = ["husky", "lint-staged", "nano-staged"] as const;

const VIS_HOOK_INSTALL = "vis hook install";

/**
 * A husky install call in command position: `husky`, `husky install`, `husky install DIR`, or `npx husky`, at
 * the start of a command, that is after the start of the script or a shell separator (`;`, `|`, `(` or a logical
 * AND or OR), and followed by a separator or the end of the script. Arguments such as `rm -rf husky` are not command positions.
 */
const HUSKY_CALL = String.raw`(?:npx\s+)?husky(?:\s+install(?:\s+[\w./-]+)?)?`;

const HUSKY_CALL_RE = new RegExp(String.raw`(?<=(?:^|[;&|(])\s*)${HUSKY_CALL}(?=\s*(?:&&|\|\||;|\)|$))`, "g");

/** A husky call together with the separator that joins it to the rest of the script, for scripts that already install through vis. */
const HUSKY_CALL_WITH_SEPARATOR_RE = new RegExp(
    String.raw`(?<=(?:^|[;&|(])\s*)${HUSKY_CALL}\s*(?:&&|\|\||;)\s*|\s*(?:&&|\|\||;)\s*${HUSKY_CALL}(?=\s*(?:$|[;&|)]))`,
    "g",
);

/**
 * Rewrites a script that calls husky, so that installing hooks keeps working. A husky install call in
 * command position becomes `installCommand` in place. A script that already installs through vis only
 * loses the husky call, so the command never appears twice.
 */
const rewriteHuskyScript = (scriptValue: string, installCommand: string = VIS_HOOK_INSTALL): string => {
    if (scriptValue.includes(VIS_HOOK_INSTALL)) {
        return scriptValue.replaceAll(HUSKY_CALL_WITH_SEPARATOR_RE, "").trim();
    }

    return scriptValue.replaceAll(HUSKY_CALL_RE, installCommand);
};

export {
    LINT_STAGED_ALL_CONFIG_FILES,
    LINT_STAGED_JSON_CONFIG_FILES,
    LINT_STAGED_OTHER_CONFIG_FILES,
    NANO_STAGED_ALL_CONFIG_FILES,
    NANO_STAGED_JSON_CONFIG_FILES,
    NANO_STAGED_OTHER_CONFIG_FILES,
    REPLACED_PACKAGES,
    rewriteHuskyScript,
    STALE_LINT_STAGED_PATTERNS,
    STALE_NANO_STAGED_PATTERNS,
    VIS_HOOK_INSTALL,
};
