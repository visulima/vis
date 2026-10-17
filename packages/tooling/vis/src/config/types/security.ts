import type { PolicyName } from "./policies";

export interface VisSecurityConfig {
    /**
     * Packages whose policy findings have been reviewed and explicitly
     * accepted. Matched against every policy unless `policies` narrows the
     * scope. Replaces the legacy `security.socket.acceptedRisks` map.
     *
     * Key format: package name (`"lodash"`), name@version
     * (`"lodash@4.17.21"`), or glob (`"@myorg/*"`). Unversioned keys match
     * all versions of that package.
     * @example
     * ```
     * acceptedRisks: {
     *   "some-risky-pkg": {
     *     reason: "Internal fork, low score expected",
     *     acceptedAt: "2026-03-15T10:00:00Z",
     *     acceptedScore: 0.25,
     *     policies: ["score"],
     *     expiresAt: "2026-12-31",
     *   },
     * }
     * ```
     */
    acceptedRisks?: Record<
        string,
        {
            /** ISO 8601 timestamp when the risk was accepted. */
            acceptedAt: string;

            /**
             * The overall Socket.dev score at the time of acceptance,
             * in the range `[0, 1]` (mirrors `policies.score.minimum`).
             * Only relevant for the `score` policy; ignored elsewhere.
             */
            acceptedScore?: number;

            /**
             * ISO 8601 date (or datetime). After this point the acceptance
             * stops applying and vis emits a warning. Leave undefined for
             * non-expiring entries. Values that fail to parse as a Date
             * are rejected by the loader rather than silently treated as
             * "always expired".
             */
            expiresAt?: string;

            /**
             * Which policies this acceptance covers. When undefined the
             * acceptance applies to every policy finding on this package.
             */
            policies?: PolicyName[];
            /** User-provided reason for accepting the risk. */
            reason: string;
        }
    >;

    /**
     * Map of bin names (or `pkg#bin` qualifiers) blessed for shadowing.
     * When two installed packages expose the same bin name, vis flags
     * the collision in `vis security list` and the post-install drift
     * report — set the bin (or `pkg#bin`) to `true` here to suppress
     * the warning once you've reviewed the conflict.
     *
     * Port of LavaMoat allow-scripts' experimental `allowBins`.
     * Bare names match any conflicting bin with that name; the
     * `pkg#bin` form scopes the approval to a single package's bin.
     * @example
     * ```
     * allowBins: {
     *   tsc: true,                // bless any 'tsc' bin
     *   "typescript#tsc": true,   // bless only typescript's 'tsc'
     * }
     * ```
     */
    allowBins?: Record<string, boolean>;

    /**
     * Offline OSV advisory + `vis audit` configuration.
     *
     * Controls `vis audit --offline` and `vis advisories sync` behavior:
     * - `audit.advisories.source` is the OSV mirror to download from. It
     *   must be `https://` and resolve to a host in `allowedHosts` (or one
     *   of the built-in defaults).
     * - `audit.offlineByDefault` flips the default of `--offline`.
     *
     * Vulnerability severity gating and reachability filtering live under
     * `policies.vulnerability` (see below).
     */
    audit?: {
        /**
         * Offline advisory cache settings.
         */
        advisories?: {
            /**
             * Extra hosts permitted as `audit.advisories.source`. The
             * built-in allowlist is enforced even if this field is
             * omitted; entries here add to it.
             * @example ["mirror.corp.example.com"]
             */
            allowedHosts?: string[];

            /**
             * Bloom-filter prefilter for OSV `MAL-*` (malicious-package)
             * advisories. Probes a ~380 KB filter fetched from
             * `endevco/osv-bloom` and escalates hits to the existing
             * advisory query path for `(name, version)` confirmation.
             *
             * Cost: ~380 KB on the wire, refreshed every 10 minutes
             * upstream. False-positive rate is ~0.1%, so a typical
             * 1000-package lockfile triggers zero or one extra
             * round trip per audit.
             *
             * Independent of `audit.advisories.source` / `verify` —
             * those control the full OSV ingest. The bloom is
             * MAL-* only and aimed at cold-start preflight and
             * ephemeral CI runners that haven't synced the full DB.
             */
            bloom?: {
                /**
                 * Extra hosts permitted as `bloom.source`. The
                 * built-in allowlist (`endevco.github.io`) is enforced
                 * even if this field is omitted; entries here add to it.
                 */
                allowedHosts?: string[];

                /**
                 * Prefilter mode:
                 * - `off`: never run the bloom check.
                 * - `on`: run when a local filter is cached; on
                 *   fetch failure, fall back to the cached filter or
                 *   skip the prefilter (audit continues against the
                 *   non-bloom path).
                 * - `required`: hard-fail the audit when the bloom
                 *   refresh fails or the local cache is missing.
                 *   Use in hardened CI together with
                 *   `audit.advisories.source`.
                 * @default "off"
                 */
                mode?: "off" | "on" | "required";

                /**
                 * Bloom mirror base URL (no trailing slash). Defaults
                 * to the public `endevco/osv-bloom` GH Pages site.
                 * Override only if you mirror the bloom artifacts
                 * internally; the hostname must appear in
                 * `allowedHosts`.
                 * @default "https://endevco.github.io/osv-bloom"
                 */
                source?: string;
            };

            /**
             * Number of hours after `lastSyncIso` before `vis audit`
             * prints a "your advisory cache may be stale" notice.
             * `vis audit` never auto-syncs — the user runs
             * `vis advisories sync` themselves.
             * @default 24
             */
            refreshIntervalHours?: number;

            /**
             * OSV mirror base URL (no trailing slash). Defaults to the
             * public Google Cloud Storage bucket. Override to point at a
             * corporate mirror; the hostname must appear in `allowedHosts`
             * (or one of the built-in defaults) and the scheme must be
             * `https://`.
             * @default "https://osv-vulnerabilities.storage.googleapis.com"
             */
            source?: string;

            /**
             * Sigstore signature verification for the OSV dump.
             * Requires the native binding to be built with the
             * `verify-signatures` Cargo feature (default in the release
             * build). Off by default — the upstream OSV bucket does not
             * ship signatures today.
             */
            verify?: {
                /**
                 * Enable signature verification. The sync flow downloads
                 * `&lt;eco>/all.zip.sig` next to the zip and aborts if it
                 * cannot verify against `expectedIssuer` / `expectedSubject`.
                 * @default false
                 */
                enabled?: boolean;
                /** OIDC issuer that signed the bundle. */
                expectedIssuer?: string;
                /** OIDC subject (workload identity) that signed the bundle. */
                expectedSubject?: string;
            };
        };

        /**
         * Gates for the auto-fix flow (`vis audit --fix` /
         * `--fix-transitive`). The CLI prompts outside CI; inside CI
         * the flags refuse to run unless `--yes` is set and, for
         * transitives, `apply.transitive.enabled = true`.
         */
        apply?: {
            /**
             * Gates for `vis audit --fix-transitive`. Two-lock: the
             * CLI requires `--yes` AND this flag set to `true` before
             * it will rewrite override entries in CI.
             */
            transitive?: {
                /**
                 * When true, allows `--fix-transitive` to run in CI
                 * environments. Defaults to false because rewriting
                 * overrides is a higher blast radius than bumping a
                 * direct dep.
                 * @default false
                 */
                enabled?: boolean;
            };
        };

        /**
         * Vulnerability scanner backend.
         *
         * - `auto` (default): delegate to `aube audit` when aube is the
         *   active installer (its scanner reads the same lockfile and
         *   produces equivalent severity ratings); otherwise run vis's
         *   own OSV/Socket scanner.
         * - `aube`: always delegate to `aube audit`. Errors if `aube` is
         *   not on PATH.
         * - `vis`: always use vis's built-in scanner — never delegate.
         *
         * Delegation avoids redundant work (aube already has a
         * full-fidelity audit pass that respects its own exclusions
         * via `aube-workspace.yaml::auditConfig`) and lets users get
         * a single, consistent result regardless of which entry point
         * they invoke.
         * @default "auto"
         */
        backend?: "aube" | "auto" | "vis";

        /**
         * When true, `vis audit` skips network calls and queries the
         * offline cache. Equivalent to the CLI `--offline` flag.
         * @default false
         */
        offlineByDefault?: boolean;
    };

    /**
     * When true, prevents transitive dependencies from using exotic sources
     * (git repositories, direct tarball URLs). Only direct dependencies may
     * use such sources. Equivalent to pnpm's `blockExoticSubdeps`.
     * @default false
     */
    blockExoticSubdeps?: boolean;

    /**
     * deps.dev (Google Open Source Insights) data-source configuration.
     * Public, unauthenticated; pulls Scorecard data + advisories from
     * `api.deps.dev`. Complements or replaces Socket.dev. Heavily cached.
     * @see https://docs.deps.dev/api/v3/
     */
    depsDev?: {
        /**
         * Cache TTL for advisory entries (immutable once published). 7 days.
         * @default 604800000
         */
        advisoryCacheTtlMs?: number;

        /**
         * Enable deps.dev scanning on install/update/check/audit commands.
         * @default false
         */
        enabled?: boolean;

        /**
         * Cache TTL for OpenSSF Scorecard project data (refreshes weekly). 24 hours.
         * @default 86400000
         */
        projectCacheTtlMs?: number;

        /**
         * Request timeout in milliseconds.
         * @default 15000
         */
        timeoutMs?: number;

        /**
         * Cache TTL for npm version metadata (immutable). 7 days.
         * @default 604800000
         */
        versionCacheTtlMs?: number;
    };

    /**
     * Package names exempted from the `blockExoticSubdeps` check.
     * Bare names and a trailing `*` glob (`@scope/*`) are supported.
     * Use for an internal package legitimately published as a git or
     * tarball dependency.
     * @example ["@myorg/legacy", "internal-*"]
     */
    exoticSubdepsAllow?: string[];

    /**
     * Pre-install marshall pipeline — packument-derived supply-chain
     * gates (author, provenance, s1ngularity, new-bin, metadata,
     * downloads, expired-domains, signatures, archived-repo) that run before
     * `vis add` / `vis install &lt;pkg>` / `vis update &lt;pkg>` hand off to
     * the underlying package manager. Every entry is optional; omit a
     * key and the marshall runs with defaults. Set `enabled: false`
     * on a specific marshall to skip it without touching env vars.
     */
    marshalls?: {
        /** Archived-repo marshall (GitHub repository status). */
        archivedRepo?: {
            /** Package names to skip. */
            allowlist?: string[];
            /** Default: marshall is on. Set false to disable. */
            enabled?: boolean;
            /** GitHub PAT for the API call (5k/hr vs 60/hr). */
            githubToken?: string;
        };
        /** Author / publisher heuristics. */
        author?: {
            allowlist?: string[];
            /** Days since the publisher's last release before flagging as error. */
            dormantErrorDays?: number;
            /** Days since the publisher's last release before flagging as warning. */
            dormantWarnDays?: number;
            enabled?: boolean;
            /** Window for the "new publisher on an established package" check. */
            newPublisherWindowDays?: number;
            /** Days since the resolved version was published — error threshold. */
            recentVersionErrorDays?: number;
            /** Days since the resolved version was published — warning threshold. */
            recentVersionWarnDays?: number;
        };
        /** npm `deprecated`-flag check on the resolved version. */
        deprecation?: {
            allowlist?: string[];
            enabled?: boolean;
        };
        /** Monthly download-count floor. */
        downloads?: {
            allowlist?: string[];
            enabled?: boolean;
            /** Below this monthly count → error (default: 20). */
            errorThreshold?: number;
            /** Below this monthly count → warning (default: 1000). */
            warnThreshold?: number;
        };
        /** Maintainer-email-domain NS lookup. */
        expiredDomains?: {
            /** Domains exempted from the check (legacy / internal). */
            allowDomains?: string[];
            allowlist?: string[];
            /** DNS resolvers to query (default: system). */
            dnsServers?: string[];
            enabled?: boolean;
            /** Per-domain DNS timeout (default: 5000). */
            timeoutMs?: number;
        };
        /** README / license / repository presence checks. */
        metadata?: {
            allowlist?: string[];
            /** Subset of checks to run. Default: all three. */
            checks?: ("license" | "readme" | "repo")[];
            enabled?: boolean;
        };
        /** New CLI-bin script introduced in this version. */
        newBin?: {
            allowlist?: string[];
            enabled?: boolean;
        };
        /** Whole-package age heuristics (newly created / unmaintained). */
        packageAge?: {
            allowlist?: string[];
            enabled?: boolean;
            /** Package created fewer than this many days ago → error. Default 22. */
            newPackageDays?: number;
            /** No publish within this many days → warning. Default 365. */
            unmaintainedDays?: number;
        };
        /** Provenance regression check. */
        provenance?: {
            allowlist?: string[];
            enabled?: boolean;
        };

        /**
         * Composite "compromised-publish shape" detector — flags a single
         * version that simultaneously introduced/changed an install hook
         * AND dropped the provenance attestation a prior stable version
         * carried (the August 2025 s1ngularity / Nx fingerprint).
         */
        s1ngularity?: {
            allowlist?: string[];
            enabled?: boolean;
        };

        /**
         * ECDSA P-256 verification against npm's signing keys. Disabled
         * by default because npm coverage still has gaps that produce
         * noisy warnings on legitimate packages.
         */
        signatures?: {
            allowlist?: string[];
            /** Default: marshall is *off*. Set true to enable. */
            enabled?: boolean;
            /** Override the keys endpoint (default: npm registry). */
            keysUrl?: string;
            /** How to treat an expired-but-known key. Default: "warning". */
            treatExpiredAs?: "error" | "warning";
        };
    };

    /**
     * When true, `security.policies.installScripts.allow` keys are matched
     * as `name@version`. A version bump on an approved package drops it from
     * the allowlist until the new version is explicitly re-approved (port
     * of LavaMoat allow-scripts' version-aware policy matcher).
     *
     * After a version bump, run `vis approve-builds` or `vis security list`
     * — both surface a "Version drift" block with the suggested new key
     * (`old-key  →  new-key`) so you can update `vis.config.ts` by hand.
     * @default false
     */
    pinVersions?: boolean;

    /**
     * Supply-chain policy gates. Each sub-block enables one policy and
     * configures its behavior. When a sub-block is omitted the policy is
     * inactive. `acceptedRisks` (above) silences specific packages without
     * disabling a policy globally.
     *
     * The 8 policies are inspired by Socket.dev's classification:
     * - `malware`            — Socket-flagged malicious packages
     * - `firstSeen`         — packages published less than N minutes ago
     * - `unexpectedDeps`    — packages outside an allow-list / baseline
     * - `publisherChange`   — maintainer set changed between installs
     * - `installScripts`    — preinstall/install/postinstall scripts
     * - `score`              — Socket overall score below threshold
     * - `vulnerability`      — OSV vulnerability findings
     * - `license`            — SPDX allow / deny lists
     */
    policies?: {
        /**
         * Minimum number of minutes that must pass after a version is
         * published before vis will allow installation. Migrated from
         * the legacy `security.minimumReleaseAge` field. Equivalent to
         * pnpm's `minimumReleaseAge`.
         * @default 0
         * @example { minutes: 1440, exclude: ["@myorg/*"] } // 24 hours
         */
        firstSeen?: {
            /**
             * Package names/patterns excluded from the firstSeen check.
             * Equivalent to pnpm's `minimumReleaseAgeExclude`.
             * @example ["webpack", "react", "@myorg/*"]
             */
            exclude?: string[];
            /** Minutes after publish before install is allowed. */
            minutes?: number;
        };

        /**
         * Build-script (pre/install/postinstall/prepare) controls.
         * Migrated from the legacy `security.allowBuilds` /
         * `security.strictDepBuilds` fields.
         * @example { allow: { esbuild: true }, strict: true }
         */
        installScripts?: {
            /**
             * Map of package names/patterns to allow (true) or deny
             * (false) build scripts. Packages not listed are denied
             * by default. Equivalent to pnpm's `allowBuilds`.
             */
            allow?: Record<string, boolean>;

            /**
             * When true, installation will fail (exit non-zero) if any
             * dependencies have unreviewed build scripts. Equivalent to
             * pnpm's `strictDepBuilds`.
             * @default false
             */
            strict?: boolean;
        };

        /**
         * SPDX license allow / deny lists. Deny wins on any sub-license
         * match in SPDX expressions (`(MIT OR GPL-3.0)` against
         * `deny: ["GPL-3.0"]` is blocked). Packages with no declared
         * license are flagged when `allow` is set.
         * @example
         * ```
         * license: {
         *   allow: ["MIT", "Apache-2.0", "BSD-3-Clause"],
         *   deny: ["GPL-3.0", "AGPL-3.0"],
         * }
         * ```
         */
        license?: {
            /**
             * SPDX identifiers that are explicitly permitted. When set,
             * any package whose declared license is not on this list is
             * blocked.
             */
            allow?: string[];

            /**
             * SPDX identifiers that are explicitly forbidden. Always
             * wins over `allow` when both reference the same identifier.
             */
            deny?: string[];
        };

        /**
         * Behavior when the Socket.dev feed flags a package as malicious
         * (`alerts[].type === "Malware"`).
         *
         * The default is cross-field: `{ mode: "block" }` whenever
         * `security.socket.enabled !== false` (the engine cannot evaluate
         * malware without Socket data), and `"off"` otherwise. Consumers
         * resolve this default at evaluation time.
         */
        malware?: {
            /**
             * - `"block"` — emit a block decision.
             * - `"warn"`  — surface as a warning; do not gate exit code.
             * - `"off"`   — disable the policy entirely.
             */
            mode?: "block" | "off" | "warn";
        };

        /**
         * Trust-level checking for package publishing. Migrated from the
         * legacy `security.trustPolicy*` fields. Equivalent to pnpm's
         * `trustPolicy`.
         * @example { mode: "no-downgrade", ignoreAfter: 43200 } // 30 days
         */
        publisherChange?: {
            /**
             * Package selectors excluded from the check.
             * Equivalent to pnpm's `trustPolicyExclude`.
             * @example ["chokidar@4.0.3"]
             */
            exclude?: string[];

            /**
             * Ignore packages published more than N minutes ago. Useful
             * for older packages that pre-date provenance support.
             * Equivalent to pnpm's `trustPolicyIgnoreAfter`.
             */
            ignoreAfter?: number;

            /**
             * - `"off"`           — no trust checking (default).
             * - `"no-downgrade"`  — block when a package's trust level
             *   has decreased compared to previous releases (e.g., was
             *   published by trusted publisher, now only has provenance).
             */
            mode?: "no-downgrade" | "off";
        };

        /**
         * Socket.dev overall-score threshold. Packages scoring below
         * `minimum` trigger a block decision (or interactive prompt
         * during `vis add`). Migrated from the legacy
         * `security.socket.minimumScore` field.
         * @example { minimum: 0.4 }
         */
        score?: {
            /**
             * Minimum overall Socket.dev score (0–1). Set to 0 to
             * disable the gate while keeping Socket data fetched.
             *
             * Consulted by `vis add`, `audit`, `doctor`, `check`, and
             * `update`; resolved once in `buildSocketOptions`, then
             * threaded through every consumer. Falls back to
             * `DEFAULT_LOW_SCORE_THRESHOLD` (`0.4`) when unset.
             */
            minimum?: number;
        };

        /**
         * Net-new transitive dependency detection. Either provide a
         * static allow-list, a baseline lockfile path (recommended), or
         * both — the intersection is enforced.
         * @example { baselineLockfile: "./security/lockfile.baseline.yaml" }
         */
        unexpectedDeps?: {
            /**
             * Allow-list of dependency names that may appear in the
             * resolved package set. Glob patterns are supported.
             * @example ["lodash", "axios", "@myorg/*"]
             */
            allow?: string[];

            /**
             * Path (absolute or relative to the workspace root) to a
             * baseline lockfile snapshot. The policy diffs the current
             * lockfile against this baseline and flags any package that
             * didn't exist before.
             * @example "./security/lockfile.baseline.yaml"
             */
            baselineLockfile?: string;
        };

        /**
         * OSV vulnerability gating. Migrated from the legacy
         * `security.audit.failOn` + `security.audit.usage` fields.
         */
        vulnerability?: {
            /**
             * Severity threshold that makes `vis audit` exit non-zero.
             * Equivalent to the CLI `--fail-on` flag.
             * @example "high"
             */
            failOn?: "critical" | "high" | "low" | "medium";

            /**
             * Reachability filter — only report vulnerabilities in
             * packages the workspace statically imports.
             */
            usage?: {
                /**
                 * Packages to always treat as reachable even if no
                 * static import is found.
                 * @example ["esbuild", "webpack-cli"]
                 */
                alwaysAssumeUsed?: string[];

                /**
                 * Enable the reachability filter by default. Equivalent
                 * to `--usage` on the CLI; `--no-usage` disables.
                 * @default false
                 */
                enabled?: boolean;
            };
        };
    };

    /**
     * Which provider wins merge conflicts when multiple are enabled (e.g.
     * both Socket.dev and deps.dev return data for the same package). The
     * primary provider's `score` is kept; alerts from secondaries are
     * appended and deduped by `key`. Defaults to whichever provider is
     * enabled first in this order: socket → deps-dev → snyk.
     */
    primaryProvider?: "deps-dev" | "snyk" | "socket";

    /**
     * Snyk data-source configuration. Snyk only contributes vulnerability
     * data (no maintenance / quality / supply-chain / license signal);
     * those axes stay neutral. Requires both an org id and an API token —
     * if either is missing the provider is skipped.
     * @see https://docs.snyk.io/snyk-api/using-specific-snyk-apis/issues-list-issues-for-a-package
     */
    snyk?: {
        /**
         * Snyk API token. Set via VIS_SNYK_TOKEN environment variable or
         * here.
         */
        apiToken?: string;

        /**
         * Snyk REST API version date sent as the `version` query param.
         * @default "2024-10-15"
         */
        apiVersion?: string;

        /**
         * Cache TTL in milliseconds for Snyk issue lookups. 6 hours.
         * @default 21600000
         */
        cacheTtlMs?: number;

        /**
         * Enable Snyk security scanning on install/update/check/audit
         * commands.
         * @default false
         */
        enabled?: boolean;

        /**
         * Snyk organization id (the REST endpoint is org-scoped). Set via
         * VIS_SNYK_ORG environment variable or here.
         */
        orgId?: string;

        /**
         * Request timeout in milliseconds for the Snyk API. 15 seconds.
         * @default 15000
         */
        timeoutMs?: number;
    };

    /**
     * Socket.dev data-source configuration. Connection knobs only — score
     * thresholds and accepted-risk overrides moved to `policies.score` and
     * `security.acceptedRisks` respectively.
     * @see https://socket.dev
     */
    socket?: {
        /**
         * Custom Socket.dev API token. Falls back to the public API token.
         * Set via VIS_SOCKET_TOKEN environment variable or here.
         */
        apiToken?: string;

        /**
         * Cache TTL in milliseconds for Socket.dev reports. 1 hour.
         * @default 3600000
         */
        cacheTtlMs?: number;

        /**
         * Enable Socket.dev security scanning on install/update/check commands.
         * @default false
         */
        enabled?: boolean;

        /**
         * Request timeout in milliseconds for the Socket.dev API. 15 seconds.
         * @default 15000
         */
        timeoutMs?: number;
    };

    /**
     * Package names to skip during typosquat detection.
     * Use this for internal packages or known-safe names that happen to
     * look similar to popular packages.
     * @example ["my-internal-axois", "@myorg/recat"]
     */
    typosquatAllowlist?: string[];
}
