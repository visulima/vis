import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseTOML } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { analyzeOverlap } from "./analyze-overlap.mjs";
import { convertKingfisherRule } from "./kingfisher-converter.mjs";
import { readRefFile } from "./ref-file.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const dataDir = resolve(pkgDir, "data");
const cacheRoot = resolve(pkgDir, "node_modules", ".cache");

const readText = (path) => readFileSync(path, "utf8");
const readToml = (path) => parseTOML(readText(path));
const readJson = (path) => JSON.parse(readText(path));

// Canonicalise the allowlist form of a config onto the plural `allowlists` array.
// Gitleaks configs may carry either a singular `[allowlist]` table or a plural
// `[[allowlists]]` array; folding both here keeps every downstream consumer from
// having to special-case the singular form.
const collectAllowlists = (source) => {
    if (Array.isArray(source?.allowlists)) {
        return source.allowlists;
    }

    if (source?.allowlist) {
        return [source.allowlist];
    }

    return [];
};

// Merge `overlay` into `base`. Rules with matching `id` in the overlay replace the
// bundled definition; allowlists are appended (gitleaks supports multiple [[allowlists]]).
// Kept tiny on purpose — the runtime merger in `src/config-loader.ts` does the same
// thing for user-supplied configs.
// Canonicalisation runs even with no overlay. `patchUpstreamRegexes` below only
// sees the plural `allowlists`, and upstream ships the singular `[allowlist]`
// table — so early-returning `base` here left the regex fixes silently unapplied
// whenever `data/gitleaks.patches.json` was absent, which is every clean checkout.
const mergeOverlay = (base, overlay) => {
    const baseRules = Array.isArray(base.rules) ? base.rules : [];
    const overlayRules = Array.isArray(overlay?.rules) ? overlay.rules : [];
    const overlayIds = new Set(overlayRules.map((r) => r?.id).filter((id) => typeof id === "string"));

    const baseAllowlists = collectAllowlists(base);
    const overlayAllowlists = collectAllowlists(overlay);

    return {
        ...base,
        // Drop the top-level `[allowlist]` singular — we canonicalise onto `allowlists`.
        allowlist: undefined,
        allowlists: [...baseAllowlists, ...overlayAllowlists],
        rules: [...baseRules.filter((r) => !overlayIds.has(r?.id)), ...overlayRules],
    };
};

// Surgical rewrites of broken upstream regexes. The fetched `gitleaks.toml` is used
// verbatim; fixes we don't want to carry as fork-diffs live here and apply
// deterministically at build time. Keep the list small — each entry is a known gitleaks
// bug with a regression test.
const UPSTREAM_REGEX_FIXES = [
    {
        // Missing parens — the alternation binds loosely so anything containing `false`
        // or `null` mid-string gets allowlisted. The fix anchors to the whole string.
        // See: https://github.com/gitleaks/gitleaks/issues/1832 (and neighbours).
        from: "(?i)^true|false|null$",
        to: "(?i)^(?:true|false|null)$",
    },
];

const patchUpstreamRegexes = (config) => {
    if (!Array.isArray(config?.allowlists)) {
        return config;
    }

    const fixMap = new Map(UPSTREAM_REGEX_FIXES.map((fix) => [fix.from, fix.to]));

    return {
        ...config,
        allowlists: config.allowlists.map((allowlist) => {
            if (!Array.isArray(allowlist?.regexes)) {
                return allowlist;
            }

            return {
                ...allowlist,
                regexes: allowlist.regexes.map((regex) => fixMap.get(regex) ?? regex),
            };
        }),
    };
};

// Field-level fixes for individual upstream rules, from `ruleOverrides` in
// `data/gitleaks.patches.json`. Unlike a full rule in the overlay's `rules`, an
// override only names the fields it changes, so the rest of the rule keeps
// tracking upstream across ref bumps. Each entry carries an `upstream` link to
// the gitleaks PR it applies. An override for a rule that no longer exists
// fails the build; one that upstream has already applied prints a warning so
// it can be dropped. `allowlists` is appended to the rule's own allowlists
// (rule-level, so path-only entries work); every other field replaces.
const OVERRIDABLE_FIELDS = new Set(["allowlists", "description", "entropy", "keywords", "path", "priority", "regex", "secretGroup"]);
const OVERRIDE_META_FIELDS = new Set(["id", "upstream"]);

const applyRuleOverrides = (config, overrides) => {
    if (!Array.isArray(overrides) || overrides.length === 0) {
        return config;
    }

    const rules = [...config.rules];

    for (const override of overrides) {
        const index = rules.findIndex((rule) => rule?.id === override?.id);

        if (index === -1) {
            throw new Error(`gitleaks.patches.json: ruleOverrides entry for unknown rule "${override?.id}" — upstream removed or renamed it`);
        }

        const fields = Object.keys(override).filter((key) => !OVERRIDE_META_FIELDS.has(key));
        const unknown = fields.filter((key) => !OVERRIDABLE_FIELDS.has(key));

        if (unknown.length > 0) {
            throw new Error(`gitleaks.patches.json: ruleOverrides "${override.id}" sets unsupported field(s): ${unknown.join(", ")}`);
        }

        const current = rules[index];
        const replaced = fields.filter((key) => key !== "allowlists");

        if (replaced.length > 0 && replaced.every((key) => JSON.stringify(current[key]) === JSON.stringify(override[key]))) {
            // eslint-disable-next-line no-console -- build-time hint
            console.warn(`secret-scanner: ruleOverrides "${override.id}" matches upstream already (${override.upstream ?? "no link"}); drop it`);
        }

        rules[index] = {
            ...current,
            ...Object.fromEntries(replaced.map((key) => [key, override[key]])),
            ...(Array.isArray(override.allowlists) ? { allowlists: [...(current.allowlists ?? []), ...override.allowlists] } : {}),
        };
    }

    return { ...config, rules };
};

// `--minify` (or `SECRET_SCANNER_MINIFY=1`) is set by the prod/native release build
// scripts. It only applies to the shipped `ruleset.json`; the gitleaks/kingfisher
// intermediates stay pretty-printed so ref bumps produce reviewable diffs.
const minifyShipped = process.argv.includes("--minify") || process.env.SECRET_SCANNER_MINIFY === "1";

const writeJson = (jsonPath, data, { minify = false } = {}) => {
    const json = minify ? JSON.stringify(data) : JSON.stringify(data, undefined, 2);

    writeFileSync(jsonPath, `${json}\n`);

    const ruleCount = Array.isArray(data?.rules) ? data.rules.length : 0;
    const allowlistCount = Array.isArray(data?.allowlists) ? data.allowlists.length : 0;
    const summary = `${ruleCount} rules, ${allowlistCount} allowlists${minify ? ", minified" : ""}`;

    // eslint-disable-next-line no-console -- build-time progress output
    console.log(`secret-scanner: wrote ${jsonPath} (${summary})`);
};

// Tag every bundled gitleaks rule with its `source`. We do this at build time so the
// shipped `ruleset.json` (and the runtime `Finding.source` field) can attribute every
// hit without the native side having to care about provenance.
const tagRuleSource = (config, source) => {
    if (!Array.isArray(config?.rules)) {
        return config;
    }

    return {
        ...config,
        rules: config.rules.map((rule) => {
            return {
                source,
                ...rule,
            };
        }),
    };
};

// ---------------------------------------------------------------------------
// Shared: pinned upstream checkouts
// ---------------------------------------------------------------------------

const ensureCheckout = ({ cacheDir, expectedSha, label, ref, repo }) => {
    const headFile = resolve(cacheDir, ".git", "HEAD");

    if (existsSync(headFile)) {
        try {
            const actual = execFileSync("git", ["-C", cacheDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

            if (actual === expectedSha) {
                return;
            }
        } catch {
            // Fall through to re-clone.
        }

        rmSync(cacheDir, { force: true, recursive: true });
    }

    mkdirSync(dirname(cacheDir), { recursive: true });

    execFileSync("git", ["clone", "--depth", "1", "--branch", ref, repo, cacheDir], { stdio: "inherit" });

    const actual = execFileSync("git", ["-C", cacheDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    if (actual !== expectedSha) {
        rmSync(cacheDir, { force: true, recursive: true });
        throw new Error(`${label} checkout SHA mismatch: expected ${expectedSha}, got ${actual}`);
    }
};

// ---------------------------------------------------------------------------
// Upstream license copy
// ---------------------------------------------------------------------------
//
// We copy the upstream LICENSE (and NOTICE, when present) from every pinned
// checkout into `data/` so the shipped license text always matches the ref
// we built against. Avoids the stale-copy footgun where someone bumps a
// ref but forgets to update LICENSE-*.

const copyLicenseArtifacts = ({ cacheDir, outputs }) => {
    for (const { optional = false, source, target } of outputs) {
        const src = resolve(cacheDir, source);

        if (!existsSync(src)) {
            if (optional) {
                continue;
            }

            throw new Error(`missing upstream license artifact: ${src}`);
        }

        copyFileSync(src, resolve(dataDir, target));
    }
};

// ---------------------------------------------------------------------------
// Gitleaks importer
// ---------------------------------------------------------------------------
//
// The gitleaks project (MIT) publishes its canonical rule config at
// `config/gitleaks.toml`. We fetch it at build time from a pinned commit (see
// `scripts/gitleaks.ref`), merge it with `data/gitleaks.patches.json` (our additive
// overlay for FP fixes plus per-rule `ruleOverrides` backporting open upstream PRs),
// apply surgical upstream-regex fixes, tag every rule with
// `source: "gitleaks"`, and emit `data/gitleaks.json`. The checkout lands in
// `node_modules/.cache/gitleaks-<sha>/` and is reused across builds.
// Set `SECRET_SCANNER_SKIP_GITLEAKS_FETCH=1` to reuse the previously generated
// `data/gitleaks.json` (CI caches, offline installs).

const GITLEAKS_REPO = "https://github.com/gitleaks/gitleaks";

// Returns the gitleaks-core config (upstream + patches + regex fixes + source tag),
// without preset rules. The top-level pipeline appends presets and writes once.
const buildGitleaks = (patchesOverlay) => {
    const refPath = resolve(here, "gitleaks.ref");

    if (!existsSync(refPath)) {
        throw new Error("scripts/gitleaks.ref missing — cannot build gitleaks ruleset");
    }

    const gitleaksJson = resolve(dataDir, "gitleaks.json");
    const skip = process.env.SECRET_SCANNER_SKIP_GITLEAKS_FETCH === "1";

    if (skip) {
        if (!existsSync(gitleaksJson)) {
            throw new Error("SECRET_SCANNER_SKIP_GITLEAKS_FETCH=1 but data/gitleaks.json does not exist");
        }

        // eslint-disable-next-line no-console
        console.log("secret-scanner: gitleaks fetch skipped (env), reusing existing data/gitleaks.json");

        return JSON.parse(readText(gitleaksJson));
    }

    const { ref, sha } = readRefFile(refPath);
    const cacheDir = resolve(cacheRoot, `gitleaks-${sha}`);

    ensureCheckout({ cacheDir, expectedSha: sha, label: "gitleaks", ref, repo: GITLEAKS_REPO });

    const upstreamToml = resolve(cacheDir, "config", "gitleaks.toml");

    if (!existsSync(upstreamToml)) {
        throw new Error(`expected gitleaks config at ${upstreamToml}`);
    }

    copyLicenseArtifacts({
        cacheDir,
        outputs: [{ source: "LICENSE", target: "LICENSE-GITLEAKS" }],
    });

    const provenance = {
        copyright: "Copyright (c) 2019 Zachary Rice",
        license: "MIT",
        licenseFile: "LICENSE-GITLEAKS",
        source: "gitleaks",
        upstreamRef: ref,
        upstreamRepo: GITLEAKS_REPO,
        upstreamSha: sha,
    };
    // Drop gitleaks-specific top-level fields (`title`, `minVersion`). They're
    // noise at runtime and `provenance` already carries ref + sha.
    const upstreamRaw = readToml(upstreamToml);
    const upstreamRest = { ...upstreamRaw };

    delete upstreamRest.minVersion;
    delete upstreamRest.title;

    const upstream = { ...upstreamRest, provenance };

    return tagRuleSource(applyRuleOverrides(patchUpstreamRegexes(mergeOverlay(upstream, patchesOverlay)), patchesOverlay?.ruleOverrides), "gitleaks");
};

// ---------------------------------------------------------------------------
// Kingfisher importer
// ---------------------------------------------------------------------------
//
// The MongoDB Kingfisher project (Apache-2.0) publishes ~825 curated detection
// rules in YAML. We fetch them at build time from a pinned commit (see
// `scripts/kingfisher.ref`), translate each into our rule schema, and emit
// `data/kingfisher.json`. Rules that use upstream-only features — HTTP
// validation, rule-to-rule dependencies, checksum verification — are skipped
// (phase 1 doesn't implement them). Skipped rules are logged to
// `data/kingfisher.skipped.log` for audit.
//
// Set `SECRET_SCANNER_SKIP_KINGFISHER_FETCH=1` to reuse an already-generated
// `data/kingfisher.json` (CI caches, offline installs).

const KINGFISHER_REPO = "https://github.com/mongodb/kingfisher";

const loadKingfisherRules = (rulesDir) => {
    const entries = readdirSync(rulesDir).filter((e) => e.endsWith(".yml") || e.endsWith(".yaml"));
    const rules = [];
    const skipped = [];

    for (const entry of entries) {
        const raw = readText(resolve(rulesDir, entry));
        let doc;

        try {
            doc = parseYaml(raw);
        } catch (error) {
            skipped.push(`${entry} — yaml parse error: ${error instanceof Error ? error.message : String(error)}`);

            continue;
        }

        const blocks = Array.isArray(doc?.rules) ? doc.rules : [];

        for (const block of blocks) {
            const result = convertKingfisherRule(block, entry);

            if (result.skipped) {
                skipped.push(result.reason);
            } else {
                rules.push(result.rule);
            }
        }
    }

    return { rules, skipped };
};

const buildKingfisher = () => {
    const refPath = resolve(here, "kingfisher.ref");

    if (!existsSync(refPath)) {
        // eslint-disable-next-line no-console
        console.warn("secret-scanner: scripts/kingfisher.ref missing — skipping kingfisher ruleset build");

        return undefined;
    }

    const kingfisherJson = resolve(dataDir, "kingfisher.json");
    const skip = process.env.SECRET_SCANNER_SKIP_KINGFISHER_FETCH === "1";

    if (skip) {
        if (!existsSync(kingfisherJson)) {
            throw new Error("SECRET_SCANNER_SKIP_KINGFISHER_FETCH=1 but data/kingfisher.json does not exist");
        }

        // eslint-disable-next-line no-console
        console.log("secret-scanner: kingfisher fetch skipped (env), reusing existing data/kingfisher.json");

        return JSON.parse(readText(kingfisherJson));
    }

    const { ref, sha } = readRefFile(refPath);
    const cacheDir = resolve(cacheRoot, `kingfisher-${sha}`);

    ensureCheckout({ cacheDir, expectedSha: sha, label: "kingfisher", ref, repo: KINGFISHER_REPO });

    const rulesDir = resolve(cacheDir, "crates", "kingfisher-rules", "data", "rules");

    if (!existsSync(rulesDir)) {
        throw new Error(`expected kingfisher rules directory at ${rulesDir}`);
    }

    copyLicenseArtifacts({
        cacheDir,
        outputs: [
            { source: "LICENSE", target: "LICENSE-KINGFISHER" },
            { optional: true, source: "NOTICE", target: "NOTICE-KINGFISHER" },
        ],
    });

    const { rules, skipped } = loadKingfisherRules(rulesDir);
    const provenance = {
        copyright: "Copyright 2025 MongoDB, Inc.",
        license: "Apache-2.0",
        licenseFile: "LICENSE-KINGFISHER",
        noticeFile: "NOTICE-KINGFISHER",
        source: "kingfisher",
        upstreamRef: ref,
        upstreamRepo: KINGFISHER_REPO,
        upstreamSha: sha,
    };
    const config = { provenance, rules };

    const skippedLogPath = resolve(dataDir, "kingfisher.skipped.log");
    const header = [
        `# Kingfisher rules skipped during import from ${ref} (${sha}).`,
        "# Only rules that cannot detect their secret from the pattern alone land here;",
        "# validation/depends_on_rule hints are preserved as opaque metadata on every",
        "# other rule so PR #4 (HTTP validators) can consume them.",
        "#",
        "# Skip reasons:",
        "#   * pattern_requirements.checksum: — pattern is loose by design; detection needs crc validation",
        "",
    ].join("\n");

    writeFileSync(skippedLogPath, `${header}${skipped.join("\n")}\n`);

    // eslint-disable-next-line no-console
    console.log(`secret-scanner: wrote ${skippedLogPath} (${skipped.length} entries)`);

    return config;
};

// ---------------------------------------------------------------------------
// Build pipeline
// ---------------------------------------------------------------------------

if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

// 1. Load opt-in preset rules from scripts/presets/*.toml. Each rule is tagged
//    `preset:<name>` and stamped `defaultEnabled: false`; users enable them at
//    scan time via `rules.enable: ["tag:preset:<name>"]`. We append these to every
//    emitted ruleset so the enable path works regardless of `ruleset` choice.
const presetsSourceDir = resolve(here, "presets");
const presetRules = [];

for (const entry of readdirSync(presetsSourceDir)) {
    if (!entry.endsWith(".toml")) {
        continue;
    }

    const name = entry.replace(/\.toml$/, "");
    const tag = `preset:${name}`;
    const parsed = readToml(resolve(presetsSourceDir, entry));
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];

    for (const rule of rules) {
        const existingTags = Array.isArray(rule.tags) ? rule.tags.filter((t) => typeof t === "string") : [];

        presetRules.push({
            ...rule,
            defaultEnabled: false,
            source: rule.source ?? "visulima",
            tags: existingTags.includes(tag) ? existingTags : [...existingTags, tag],
        });
    }
}

// 1b. Visulima default rules from scripts/visulima-rules.toml: providers and
//     credential shapes neither upstream covers. Unlike presets they keep
//     `defaultEnabled` (on unless a rule says otherwise) and carry no preset tag.
//     They only go into the shipped ruleset, never the upstream intermediates.
const visulimaRulesPath = resolve(here, "visulima-rules.toml");
const visulimaRuleSource = existsSync(visulimaRulesPath) ? (readToml(visulimaRulesPath).rules ?? []) : [];
const visulimaRules = visulimaRuleSource.map((rule) => {
    return { ...rule, source: rule.source ?? "visulima" };
});

// Strip preset rules from cached intermediates. When `SECRET_SCANNER_SKIP_*_FETCH=1`
// reuses a previous build's `gitleaks.json` / `kingfisher.json`, those files already
// have presets baked in — re-appending below would duplicate them on every rebuild.
// Filtering by `preset:*` tag is correct because preset rules are stamped with that
// tag in step 1 and upstream sources never carry it.
const stripPresetRules = (rules) =>
    (rules ?? []).filter((rule) => !Array.isArray(rule?.tags) || !rule.tags.some((tag) => typeof tag === "string" && tag.startsWith("preset:")));

// 2. Gitleaks ruleset — upstream + patches + regex fixes. Local review artefact
//    only (checked into git so ref bumps produce reviewable diffs), never shipped.
const patchesJson = resolve(dataDir, "gitleaks.patches.json");
const patchesOverlay = existsSync(patchesJson) ? readJson(patchesJson) : undefined;
const gitleaksCore = buildGitleaks(patchesOverlay);
const gitleaksCoreRules = stripPresetRules(gitleaksCore.rules);

writeJson(resolve(dataDir, "gitleaks.json"), {
    ...gitleaksCore,
    rules: [...gitleaksCoreRules, ...presetRules],
});

// 3. Kingfisher ruleset (fetched + converted). Same deal — diff-review artefact.
const kingfisherCore = buildKingfisher();
const kingfisherCoreRules = kingfisherCore ? stripPresetRules(kingfisherCore.rules) : [];

if (kingfisherCore) {
    writeJson(resolve(dataDir, "kingfisher.json"), {
        ...kingfisherCore,
        rules: [...kingfisherCoreRules, ...presetRules],
    });
}

// 4. The one ruleset we actually ship to consumers. Union of gitleaks + kingfisher
//    + Visulima default rules + opt-in presets, gitleaks allowlists preserved. Hit dedup between sources
//    happens at scan time via span+priority, not here.
if (kingfisherCore) {
    const ruleset = {
        allowlists: collectAllowlists(gitleaksCore),
        extend: gitleaksCore.extend,
        provenance: {
            sources: [gitleaksCore.provenance, kingfisherCore.provenance].filter(Boolean),
        },
        rules: [...gitleaksCoreRules, ...kingfisherCoreRules, ...visulimaRules, ...presetRules],
    };

    writeJson(resolve(dataDir, "ruleset.json"), ruleset, { minify: minifyShipped });

    // 5. Static overlap report — groups rules by inferred provider slug so humans can
    //    audit where the two sources overlap. Regenerated deterministically on every
    //    build; check `data/overlap.md` into git so ref bumps surface the delta.
    const overlapMd = analyzeOverlap(ruleset);

    writeFileSync(resolve(dataDir, "overlap.md"), overlapMd);

    // eslint-disable-next-line no-console
    console.log(`secret-scanner: wrote ${resolve(dataDir, "overlap.md")}`);
}
