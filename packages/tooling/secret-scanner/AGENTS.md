# Agent Instructions

This file provides guidance to AI coding agents when working with code in this directory.

## Overview

`@visulima/secret-scanner` is a Rust port of gitleaks-style secret detection, shipped as a NAPI module with a TypeScript orchestration layer. Bundles ~1,387 rules (222 gitleaks default + 1,095 MongoDB Kingfisher + 22 Visulima default rules + 48 opt-in Visulima presets) compiled into `data/ruleset.json` at build time. Public surface (see `src/index.ts`): `scan`, `scanFiles`, `scanString`, `inspectRuleset`, `listRules`, `listRequiredValidators`, `fingerprint`, plus heuristic helpers.

## Architecture

- Native Rust lives in `native/` (separate `Cargo.toml`). JS entry stays in `src/`. The TypeScript layer (`prepare-scan` -> native binding -> `pipeline.postProcess`) is intentionally thin — heavy lifting is in Rust.
- `pnpm build` runs `pnpm run build:rules` first (executes `scripts/build-rules.mjs`, which converts upstream gitleaks + Kingfisher TOML refs into `data/ruleset.json`) and then `packem build`. After any change under `scripts/presets/` or to the `.ref` files, rebuild rules before testing.
- Rule sources tracked via `scripts/gitleaks.ref` and `scripts/kingfisher.ref`. Don't bump those without running `scripts/analyze-overlap.mjs` and `test:parity`; `scripts/diff-rulesets.mjs <old> <new>` lists the rule ids added, removed or renamed. Kingfisher is pinned to 1.x (`major=1`): 2.x replaced its catalog with Betterleaks/Veles imports under new ids. `.github/workflows/secret-scanner-rules-sync.yml` opens the weekly bump PR.
- Upstream gitleaks fixes go in `ruleOverrides` in `data/gitleaks.patches.json` (field-level, with the upstream PR link). Default-on Visulima rules go in `scripts/visulima-rules.toml`; opt-in ones in `scripts/presets/`. Write regexes with ASCII classes: Unicode `\w` can exceed the native regex size limit and the rule is then silently skipped (`inspectRuleset()` shows it). TP/FP tests go in `__tests__/rule-coverage.test.ts`.
- Validators (live HTTP checks) and transports live under `src/validator/` and `src/transports/` respectively. Stop-word / entropy / heuristic filters are in `src/heuristics.ts` — keep deterministic behaviour stable so baselines remain valid.
- Optional peer deps (`@aws-sdk/client-sts`, `@azure/storage-blob`, `@grpc/grpc-js`, `google-auth-library`, `mongodb`, `mysql2`, `pg`) are validator transports — import them lazily so the package stays usable without them.
- Source-of-truth `Finding.source` values are `"gitleaks" | "kingfisher" | "visulima" | <user>` — preserve these when routing findings.

## Related

- Consumed by `@visulima/vis` (`packages/tooling/vis`) for `vis scan` / pre-commit hook integration.
