// One-shot scan preparation — everything a scan entry point needs from the
// user's `ScanOptions`, computed once and threaded through the native binding,
// rule-meta map, and post-scan filters. Avoids re-doing the resolve/expand/gate
// dance three times per scan.

import { statSync } from "node:fs";

import type { Native } from "./binding";
import type { ChecksumSpec } from "./checksum";
import type { GitleaksConfig } from "./config-loader";
import { expandTagFilters, gateOptInRules, resolveConfig } from "./config-loader";
import type { ScanOptions } from "./types";

/**
 * Normalise `depends_on_rule` entries from Kingfisher YAML. Upstream uses
 * `rule_id` (snake_case); internally we expose camelCase `ruleId` to match
 * the rest of the public + internal surface. Accepts either spelling on input
 * so hand-authored rules that use either convention still work.
 */
type DepCandidate = { rule_id?: unknown; ruleId?: unknown; variable?: unknown } | undefined;

const asDepCandidate = (entry: unknown): DepCandidate => {
    if (typeof entry === "object" && entry !== null) {
        return entry;
    }

    return undefined;
};

/**
 * Per-rule metadata the post-scan pipeline consults — checksum filter, HTTP
 * validator, dependency resolver. Private to the scanner; not exported.
 */
export interface RuleMeta {
    checksum?: ChecksumSpec;
    dependsOnRule?: { ruleId: string; variable: string }[];
    pattern?: string;
    validation?: unknown;
}

/** The config-derived part of a prepared scan; memoised across calls. */
interface PreparedConfig {
    config: GitleaksConfig;
    excludeIds?: string[];
    includeIds?: string[];
    ruleMeta: Map<string, RuleMeta>;
}

export interface PreparedScan extends PreparedConfig {
    nativeOptions: Native.ScanOptions;
}

/**
 * Build the `ruleId → metadata` map that the post-scan pipeline (checksum
 * filter + HTTP validator + dependency resolver) reads. O(rules) pass —
 * runs once per scan.
 */
export const buildRuleMeta = (config: GitleaksConfig): Map<string, RuleMeta> => {
    const map = new Map<string, RuleMeta>();

    for (const rule of config.rules ?? []) {
        // eslint-disable-next-line sonarjs/different-types-comparison -- Defensive: `rule` is typed `GitleaksRule` but the underlying config holds `unknown` at runtime; guard against `null` slipping through.
        if (typeof rule !== "object" || rule === null) {
            continue;
        }

        const record = rule as {
            dependsOnRule?: unknown;
            id?: unknown;
            patternRequirements?: { checksum?: ChecksumSpec };
            regex?: unknown;
            validation?: unknown;
        };

        if (typeof record.id !== "string") {
            continue;
        }

        // `dependsOnRule` comes from the kingfisher converter as the raw YAML
        // array. Filter to the shape the validator expects so a malformed
        // custom rule can't crash the scan — broken entries become "no deps".
        // Accept either `rule_id` (snake_case, upstream YAML) or `ruleId`
        // (camelCase, matches our output types).
        let deps: { ruleId: string; variable: string }[] | undefined;

        if (Array.isArray(record.dependsOnRule)) {
            deps = record.dependsOnRule
                .map((entry) => asDepCandidate(entry))
                .flatMap((entry) => {
                    if (typeof entry?.variable !== "string") {
                        return [];
                    }

                    let ruleId: string | undefined;

                    if (typeof entry.ruleId === "string") {
                        ruleId = entry.ruleId;
                    } else if (typeof entry.rule_id === "string") {
                        ruleId = entry.rule_id;
                    }

                    return ruleId === undefined ? [] : [{ ruleId, variable: entry.variable }];
                });
        }

        map.set(record.id, {
            checksum: record.patternRequirements?.checksum,
            dependsOnRule: deps && deps.length > 0 ? deps : undefined,
            pattern: typeof record.regex === "string" ? record.regex : undefined,
            validation: record.validation,
        });
    }

    return map;
};

// Memoise the resolved config by the options that shape it. An editor
// integration calling `scanString` per save re-runs `resolveConfig` +
// `gateOptInRules` + `buildRuleMeta` over ~1,390 rules on every keystroke
// otherwise. Inline configs are *not* cached (their identity is the object
// reference, which we can't cheaply serialise and which callers often rebuild).
const preparedConfigCache = new Map<string, PreparedConfig>();
const PREPARED_CACHE_LIMIT = 32;

/** Test-only: drop the prepared-scan memo so config-fixture mutations don't leak across tests. */
export const resetPrepareScanCacheForTests = (): void => {
    preparedConfigCache.clear();
};

const preparedCacheKey = (options: ScanOptions | undefined): string | undefined => {
    if (options?.config?.inline !== undefined) {
        return undefined;
    }

    // Fold the config file's mtime+size into the key so editing the file at
    // `config.path` busts this memo too — otherwise a long-lived host keeps
    // serving a config built from the pre-edit ruleset even after
    // `resolveConfig`'s own cache has been invalidated.
    let configStat: { mtimeMs: number; size: number } | undefined;

    if (options?.config?.path !== undefined) {
        try {
            const stats = statSync(options.config.path);

            configStat = { mtimeMs: stats.mtimeMs, size: stats.size };
        } catch {
            configStat = undefined;
        }
    }

    return JSON.stringify({
        configMtimeMs: configStat?.mtimeMs,
        configSize: configStat?.size,
        extendBundled: options?.config?.extendBundled,
        path: options?.config?.path,
        rules: options?.rules,
    });
};

const buildPreparedConfig = (options: ScanOptions | undefined): PreparedConfig => {
    const base = resolveConfig({
        config: options?.config?.inline,
        configPath: options?.config?.path,
        extendBundled: options?.config?.extendBundled,
    });
    const allRules = base.rules ?? [];
    const enableIds = expandTagFilters(options?.rules?.enable, allRules, "rules.enable");
    const includeIds = expandTagFilters(options?.rules?.include, allRules, "rules.include");
    const excludeIds = expandTagFilters(options?.rules?.exclude, allRules, "rules.exclude");

    // `enable` and `include` both imply enablement: you can't filter to a rule
    // that's off. `exclude` is filter-only — it never turns anything on.
    const enabledSet = new Set<string>([...(enableIds ?? []), ...(includeIds ?? [])]);
    const config = gateOptInRules(base, enabledSet);

    return { config, excludeIds, includeIds, ruleMeta: buildRuleMeta(config) };
};

const preparedConfig = (options: ScanOptions | undefined): PreparedConfig => {
    const cacheKey = preparedCacheKey(options);

    if (cacheKey === undefined) {
        return buildPreparedConfig(options);
    }

    const cached = preparedConfigCache.get(cacheKey);

    if (cached !== undefined) {
        return cached;
    }

    const prepared = buildPreparedConfig(options);

    // Bounded LRU-ish: evict the oldest entry when over the limit so a
    // long-lived process scanning many distinct configs doesn't grow unbounded.
    if (preparedConfigCache.size >= PREPARED_CACHE_LIMIT) {
        const oldest = preparedConfigCache.keys().next().value;

        if (oldest !== undefined) {
            preparedConfigCache.delete(oldest);
        }
    }

    preparedConfigCache.set(cacheKey, prepared);

    return prepared;
};

/**
 * Flatten the user's grouped options into the shape the native binding
 * expects. `redact` is not passed on: the pipeline masks (see `mask.ts`).
 */
const toNativeOptions = (options: ScanOptions | undefined, config: GitleaksConfig): Native.ScanOptions => {
    return {
        concurrency: options?.concurrency,
        config,
        extraIgnores: options?.walk?.excludePatterns,
        ignoreFiles: options?.walk?.excludeFromFiles,
        includeHidden: options?.walk?.includeHidden,
        inlineAllow: options?.inlineAllow,
        maxArchiveDepth: options?.maxArchiveDepth,
        maxDecodeDepth: options?.maxDecodeDepth,
        maxFileSize: options?.walk?.maxFileSize,
        minConfidence: options?.config?.minConfidence,
        reportSuppressed: options?.reportSuppressed,
        respectGitignore: options?.walk?.gitignore,
    };
};

/**
 * Resolve the effective ruleset, expand `tag:` selectors in
 * `rules.enable`/`include`/`exclude` against the loaded rules (throws on
 * unknown tags — typos surface early), union enable + include into the
 * enablement set, gate `defaultEnabled: false` rules, and build the native
 * options.
 *
 * The resolved config is memoised by the options that shape it (inline
 * configs excepted) so repeated `scanString`/`scan` calls with the same config
 * skip the O(rules) resolve + rule-meta rebuild. Native options are built
 * fresh on every call.
 */
export const prepareScan = (options: ScanOptions | undefined): PreparedScan => {
    const prepared = preparedConfig(options);

    return { ...prepared, nativeOptions: toNativeOptions(options, prepared.config) };
};
