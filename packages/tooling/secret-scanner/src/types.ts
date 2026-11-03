// Public types for @visulima/secret-scanner.
//
// These are the shapes consumers (CLI, tests, third-party wrappers) import.
// Internal-only types (RuleMeta, PreparedScan, IgnoreMatcher, …) live alongside
// the module that uses them — they never appear here.

import type { GitleaksConfig } from "./config-loader";
import type { CONFIDENCE_LEVELS } from "./constants";

/**
 * Author-declared rule quality. Drives the `--min-confidence` filter: unlabeled
 * rules resolve to `"low"` so raising the floor drops them along with explicit
 * low-confidence rules.
 */
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/**
 * Validation status on a finding after the optional HTTP validator runs.
 *
 * - `null` — validator was never invoked (default; `config.validate` is `false`).
 * - `"skipped"` — validator ran but the rule uses an unsupported validation type
 * (gRPC without deps, multi-step HTTP, checksum, …).
 * - `"verified"` / `"rejected"` — the provider returned a conclusive result.
 * - `"error"` — the validator ran but failed (network error, timeout, rate-limit).
 *
 * `config.onlyVerified: true` filters to the `"verified"` subset — useful for CI
 * gating where a suspect match that can't be verified is not a blocker.
 */
export type ValidationStatus = "error" | "rejected" | "skipped" | "verified";

/**
 * Grouped scan options. Keys are namespaced by concern — config source, walker,
 * rule filters, output, baseline — so autocomplete surfaces only related settings
 * at each level.
 */
export interface ScanOptions {
    /**
     * Suppression list. Accepts either:
     *
     * - a path to a baseline JSON array of findings, or
     * - an inline findings array (no file IO, ideal for `scanString`/editor hosts), or
     * - a pre-computed set of fingerprint strings (e.g. a cached set reused across calls).
     *
     * Inline findings are indexed under both the content-hash and the legacy
     * line-based fingerprint, mirroring on-disk baseline loading.
     */
    baseline?: Finding[] | ReadonlySet<string> | string;

    /** Rayon worker threads. `0` / omit = auto (use rayon's global pool). */
    concurrency?: number;

    /** Where the ruleset comes from. */
    config?: {
        /** Layer the user's rules on top of the bundled gitleaks ruleset. Default: `true`. */
        extendBundled?: boolean;

        /**
         * Post-detection heuristic false-positive filters (detect-secrets
         * parity). Every heuristic defaults to `true`; set the individual
         * key to `false` to disable. The filters are intentionally
         * conservative — they drop high-confidence placeholders only.
         */
        heuristics?: {
            /**
             * Skip findings in well-known lock files (yarn.lock, Cargo.lock,
             * package-lock.json, Gemfile.lock, …). Basename-matched.
             */
            lockFile?: boolean;

            /**
             * Drop findings whose secret contains **no** alphanumeric
             * characters (`*****`, `------`).
             */
            notAlphanumericString?: boolean;

            /** Drop findings whose secret has UUID-8-4-4-4-12 shape. */
            potentialUuid?: boolean;

            /**
             * Drop findings whose secret is a substring of a standard
             * character sequence (`abcdefgh`, `12345678`, `AAAAAAAA`).
             */
            sequentialString?: boolean;
        };
        /** Pre-parsed gitleaks-shaped object. Fastest path — zero file IO. */
        inline?: GitleaksConfig;

        /**
         * Drop every rule whose author-declared `confidence` is below this floor.
         * Rules without an explicit confidence are treated as `"low"` and therefore
         * dropped when the floor is `"medium"` or `"high"`. Omitted or `"low"` keeps
         * all rules.
         */
        minConfidence?: Confidence;

        /**
         * With `validate: true`, drop every finding whose `validation` is not
         * `"verified"`. Useful in CI gating where an unverifiable match is not
         * an actionable leak.
         */
        onlyVerified?: boolean;
        /** Path to a JSON file (gitleaks-compatible shape). */
        path?: string;

        /**
         * When `true`, every finding whose rule declares an HTTP validator is
         * verified against the provider's own API after detection. Cost: one
         * HTTP request per finding (per-host concurrency capped at 4, global at
         * 8). Default `false` — scans stay offline-safe.
         *
         * WARNING: validators send the candidate secret to the provider. Some
         * providers page their security team on failed auth attempts. Only
         * enable on repos you own.
         */
        validate?: boolean;

        /**
         * Host allowlist for **all** outbound validation traffic — HTTP
         * validators *and* transport validators (MongoDB/MySQL/Postgres/JDBC
         * connection strings plus the fixed AWS/GCP provider endpoints). When
         * set (with `validate: true`), a finding whose validator would contact a
         * host **not** in this list is reported as `"skipped"` and no request or
         * connection is made.
         *
         * Closes the untrusted-config exfiltration channel: a shared or
         * third-party config loaded via `config.path` can otherwise add a rule
         * whose `validation.url` — or a captured `mongodb://…` URI — points at an
         * attacker host and leak every matching secret. Leave unset to allow any
         * host (bundled rules only target legitimate provider APIs). Hosts are
         * matched case-insensitively against `URL.host` (`host` or `host:port`);
         * a database allowlist entry therefore includes the port
         * (e.g. `db.internal:27017`). Offline validators (JWT) open no connection
         * and are never gated.
         */
        validateAllowedHosts?: string[];
    };

    /**
     * Path to a gitleaks `.gitleaksignore` file. Each line is one of:
     *
     * - a fingerprint `file:rule:line`, or `commit:file:rule:line` for git history findings;
     * - a secret-value entry `secret:&lt;value>`, optionally scoped as
     * `rule:&lt;id>:secret:&lt;value>`, `path:&lt;file>:secret:&lt;value>` or
     * `path:&lt;file>:rule:&lt;id>:secret:&lt;value>`.
     *
     * `*` in any component matches any run of characters (`src/gen/*:generic-api-key:*`).
     * `#` starts a comment. Paths are matched relative to the directory that holds
     * the file, however the scan root was spelled. Not auto-discovered by the
     * library; `false` or omitted disables it. Matching findings are suppressed
     * with `suppressedBy: "gitleaksignore"`; entries that matched nothing are
     * returned as `unusedIgnores` by the `*Detailed` scans.
     */
    gitleaksIgnore?: string | false;

    /**
     * Honour inline suppressions — `gitleaks:allow`, `secret-scanner:allow`,
     * `pragma: allowlist secret`, `pragma: allowlist nextline secret` and
     * `gitleaks:allow-start` … `gitleaks:allow-end` blocks. Default `true`.
     * Set `false` in CI to audit what developers suppressed in code.
     */
    inlineAllow?: boolean;

    /**
     * Archive scanning depth (gitleaks `--max-archive-depth`). zip, tar, gzip and
     * tar.gz files are recognised by their magic bytes (not the extension), opened in
     * memory and their entries scanned. Findings use the virtual path
     * `archive.zip!inner/dir/file.env`. `1` opens top-level archives; each extra level
     * opens one more layer of archives nested inside them (capped at 8, `MAX_ARCHIVE_DEPTH`). A gzip stream
     * around a tar counts as one level.
     *
     * Limits per top-level archive: each entry obeys `walk.maxFileSize` (and the archive
     * file itself too), 256 MiB decompressed in total, 10,000 entries, and entries or gzip
     * streams that expand more than 100x past 1 MiB are skipped as decompression bombs.
     * Binary entries are skipped like binary files. Entries skipped for size, as bombs or
     * because they can't be read (e.g. encrypted) are listed in the `*Detailed` scans'
     * `skipped` under their virtual path. Applies to `scan` and `scanFiles`.
     * Default: `0` (archives are skipped as binary files).
     */
    maxArchiveDepth?: number;

    /**
     * How many layers of encoding to look through (gitleaks `--max-decode-depth`).
     * Base64 (standard and url-safe), hex and percent-encoded segments that decode
     * to printable UTF-8 are decoded and rescanned, recursively, up to this depth.
     * Findings from decoded text report the line/column of the original encoded
     * span and carry {@link Finding.decoded}. Decoded output is capped at 4 MiB per
     * file. Default: `2`. `0` disables decoding.
     */
    maxDecodeDepth?: number;

    /** Mask `match` / `secret` strings in every finding. */
    redact?: boolean;

    /**
     * Have the `*Detailed` scans return the findings that were suppressed —
     * by the baseline, a config allowlist, an inline pragma or
     * `.gitleaksignore` — in `suppressed`, each with a `suppressedBy` reason.
     * They never appear in `findings`. Default `false`.
     */
    reportSuppressed?: boolean;

    /**
     * Rule id + tag filters. Entries are either literal rule ids (e.g.
     * `"aws-access-token"`) or `tag:&lt;name>` selectors that expand to every rule
     * carrying the matching tag. An unknown tag throws so typos surface early.
     *
     * - `enable` — **additive**. Turns on opt-in rules (`defaultEnabled: false`
     * bundles tagged `preset:&lt;name>`). Doesn't restrict which findings are
     * emitted.
     * - `include` — **restrictive whitelist**. When set, only findings matching
     * this list are emitted. Also implies enablement for referenced opt-in
     * rules.
     * - `exclude` — **blacklist**. Drops findings matching this list. Doesn't
     * enable anything.
     */
    rules?: {
        /** Enable opt-in rules without restricting the output. Additive. */
        enable?: string[];
        /** Drop findings whose ruleId — or expanded tag membership — is in this list. */
        exclude?: string[];
        /** Only report findings whose ruleId — or expanded tag membership — is in this list. Implies enablement. */
        include?: string[];
    };

    /**
     * Abort the scan's validation stage. When `config.validate: true` a scan can
     * fire one HTTP request per finding (plus DB-driver connections); pass a
     * signal so a CLI/editor host can cancel mid-flight. The signal is forwarded
     * to each validator's `fetch()` — already-resolved detection is unaffected.
     */
    signal?: AbortSignal;

    /** Print diagnostics (skipped rules, etc.) to stderr on first run. */
    verbose?: boolean;

    /** Walker / filesystem traversal. */
    walk?: {
        /** Additional `.gitignore`-shaped files to honor (e.g. `.secretsignore`). */
        excludeFromFiles?: string[];
        /** Gitignore-syntax lines applied on top of `.gitignore`. */
        excludePatterns?: string[];
        /** Respect `.gitignore`, `.ignore` and global excludes. Default: `true`. */
        gitignore?: boolean;
        /** Visit dotfiles and hidden entries. Default: `false`. */
        includeHidden?: boolean;
        /** Skip files larger than this (bytes). Default: 10 MiB. */
        maxFileSize?: number;
    };
}

export interface Finding {
    /**
     * Rule ids that matched the same byte span as this finding and were collapsed
     * by the dedup pass. Empty when nothing overlapped.
     */
    alternateMatches: string[];
    /** `"low"` when the rule declares no confidence (default floor). */
    confidence: Confidence;

    /**
     * Present when the secret was found inside encoded text: the encoding chain,
     * outermost first (e.g. `["base64"]`, `["base64", "hex"]`). `match` and `secret`
     * hold the decoded text; the line/column fields point at the original encoded span.
     */
    decoded?: string[];
    description: string;
    endColumn: number;
    endLine: number;
    entropy: number;
    file: string;
    match: string;

    /**
     * Composite rules only (`required` in the rule config): the findings of the rule's
     * required dependencies that satisfied it, the nearest one per required id, in the
     * order the rule declares them. Redacted along with `secret` when `redact` is on.
     */
    requiredFindings?: RequiredFinding[];
    ruleId: string;
    secret: string;
    /** Provenance of the rule — `"gitleaks"`, `"kingfisher"`, `"visulima"`, or user-declared. */
    source?: string;
    startColumn: number;
    startLine: number;
    tags: string[];

    /**
     * Populated by the HTTP validator when `config.validate: true`. Omitted when
     * the validator was never invoked (default / validate off). See
     * {@link ValidationStatus} for the meaning of each value.
     */
    validation?: ValidationStatus;
}

/** A dependency finding attached to a composite-rule {@link Finding}. Same file as its primary. */
export interface RequiredFinding {
    /** Encoding chain when the dependency was found in decoded text. */
    decoded?: string[];
    endColumn: number;
    endLine: number;
    match: string;
    ruleId: string;
    secret: string;
    startColumn: number;
    startLine: number;
}

/** Why a finding was suppressed. */
export type SuppressionReason = "allowlist" | "baseline" | "gitleaksignore" | "inline-allow";

/** A finding that matched but was suppressed (see `ScanOptions.reportSuppressed`). */
export type SuppressedFinding<F extends Finding = Finding> = F & {
    suppressedBy: SuppressionReason;
    /** The `.gitleaksignore` line that suppressed it, when `suppressedBy` is `"gitleaksignore"`. */
    suppressedByEntry?: GitleaksIgnoreEntry;
};

/** One parsed `.gitleaksignore` line. */
export interface GitleaksIgnoreEntry {
    /** `fingerprint` for `[commit:]file:rule:line`, `secret` for secret-value entries. */
    kind: "fingerprint" | "secret";
    /** 1-based line number in the ignore file. */
    line: number;
    /** The line as written (trimmed). Secret entries contain the secret value. */
    raw: string;
}

/** Why a working-tree file was not scanned. */
export type SkipReason = "io-error" | "not-found" | "permission-denied" | "symlink-loop" | "too-large";

/**
 * A working-tree file (or directory) the scan could not read. With `maxArchiveDepth`,
 * also an archive entry (`a.zip!dir/file.env`), or an archive whose walk stopped at its
 * byte / entry budget (`"too-large"`).
 */
export interface SkippedFile {
    /** Path, relative to the scan root like `Finding.file` when possible. */
    path: string;
    reason: SkipReason;
}

/**
 * Result of `scanDetailed` / `scanFilesDetailed`: the findings plus everything
 * needed to tell a clean scan from one that didn't look at everything.
 */
export interface ScanResult {
    findings: Finding[];
    /** Files that could not be read. A scan with entries here is not proof of "no secrets". */
    skipped: SkippedFile[];
    /** Suppressed findings; empty unless `reportSuppressed` is on. */
    suppressed: SuppressedFinding[];
    /** `.gitleaksignore` entries that matched no finding in this scan. */
    unusedIgnores: GitleaksIgnoreEntry[];
}

export interface SkippedRule {
    reason: string;
    ruleId: string;
}

export interface RuleInfo {
    /**
     * `true` when the rule has no keywords and therefore bypasses the AC prefilter —
     * its regex runs against every file. Surface it in tooling to flag perf-regressing
     * custom rules.
     */
    alwaysRuns: boolean;
    /** `"low"` when the rule declares no confidence. */
    confidence: Confidence;
    description: string;
    entropy?: number;
    hasPathFilter: boolean;
    hasRegex: boolean;
    id: string;
    keywords: string[];
    source?: string;
    tags: string[];
}
