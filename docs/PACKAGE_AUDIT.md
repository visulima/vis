# Package audit notes

Findings recorded for the packages in this repository. They were kept in the monorepo audit log until these packages moved here.

## @visulima/tui — `packages/terminal/tui`

> @visulima/tui is a React-based, Ink-compatible terminal UI framework with a native Rust diff engine, ~90 subpath-exported components, and broad test coverage (195 test files) — a polished, performance-conscious package whose few real issues are a side-effectful usePersistentState updater, over-broad sideEffects, and some export-map/ergonomics drift.

#### DX improvements

- ✅ **[FIXED]** **Mouse hooks have no `./hooks/*` subpaths.** Every other hook is exposed as `@visulima/tui/hooks/use-*`, but `useMouse`, `useOnMouseClick`, `useMousePosition`, `useElementPosition`, etc. are only re-exported from the bare entry (`packages/terminal/tui/src/ink/index.ts:92-97`). Combined with `dist/ink/**` being marked side-effectful, importing one mouse hook drags in the whole ink barrel. Add matching `./hooks/use-mouse*` subpath exports for consistency with the README's "hooks live at subpaths" story.
- ✅ **[FIXED]** **Dead component barrel with stale guidance.** `packages/terminal/tui/src/components/index.ts` is imported by nothing and exposed by no subpath, and its doc comment says "Consumers should import from `@visulima/tui` (the ink barrel)" — which is no longer true (the ink entry explicitly states components moved to subpaths). Delete the barrel or fix the comment; today it actively misleads contributors.
- ✅ **[FIXED]** **560-line hand-maintained exports map with validation switched off.** `packem.config.ts:21-24` sets `validation.packageJson.exports: false`, so nothing checks that `package.json` exports stay in sync with `src/components/` (~90 entries today). A wildcard `"./components/*"` export or a small generation/validation script would remove an entire class of "forgot to add the subpath" release bugs.
- ✅ **[FIXED]** **README has no component catalog.** The package ships ~90 components and a rich `docs/` set (`docs/components.mdx`, `docs/hooks.mdx`, `docs/ink-compat.mdx`), but `README.md` shows only a handful of hooks and components and never links the docs pages. A one-line component index (or a link to the published docs) is the cheapest discoverability win for a library this large.

#### Optimizations

- ✅ **[FIXED]** **`usePersistentState` runs sync file I/O inside the setState updater.** `packages/terminal/tui/src/ink/hooks/use-persistent-state.ts:155-167` calls `storage.write(...)` from within the `setValue((previous) => ...)` updater. Updaters must be pure: under StrictMode they are double-invoked (double disk writes) and under the concurrent mode this package advertises they can run and be discarded, persisting state that never commits. Each write is also a full synchronous read-modify-write of the whole namespace file (`readFileSync` + `writeFileSync` + `renameSync`, lines 90-117), re-parsing the file from disk on every update. Move persistence into an effect (or post-set callback), keep the parsed object in memory, and consider debouncing writes.
- ✅ **[FIXED]** **`sideEffects` is far broader than the side effect it protects.** `package.json:37-42` marks all of `./dist/components/**`, `./dist/ink/**`, and `./dist/react/**` as side-effectful, but per the package's own docs the only thing that must survive tree-shaking is the native binding loader (`index.js`, loaded via `src/core/native-binding.ts:8`). Components and the ink barrel are pure modules; the current setting prevents bundling consumers (esbuild/rollup-built CLIs) from shaking unused re-exports out of the large `dist/ink` entry. Narrow the list to `index.js` (and any genuinely side-effectful core module).

#### Feature gaps

- **No terminal image support.** There is no sixel, kitty graphics (`_Gf=`), or iTerm2 inline-image (`1337;File`) code anywhere in `src/` (Canvas at `src/components/canvas.tsx` is cell-based drawing only). Ink users reach for `ink-image`, and ratatui ships `ratatui-image`; an `<Image>` component (lazy optional peer, like the existing shiki/marked pattern) would cover "show the logo / render a chart PNG / preview a screenshot in my CLI."
- **No theming system.** With ~90 components, styling is per-prop plus a fixed `VARIANT_CONFIG` (`src/components/variant-config.ts` consumed by `alert.tsx:16-17`, `status-message.tsx`, etc.); there is no `ThemeProvider`/`useTheme` anywhere in `src/`. `@inkjs/ui` ships exactly this. User story: "set my brand colors / a light-vs-dark palette once and have Alert, Badge, Button, Spinner all follow it" — currently impossible without wrapping every component.

#### Security

- No concrete security issues found. Regexes in the input path are anchored and linear (`src/ink/parse-keypress.ts:7-136`, `src/ink/sanitize-ansi.ts:3`), OSC 52 clipboard writes validate targets and base64-encode payloads (`src/ink/clipboard.ts:70-80`), and the React DevTools websocket connects to localhost only, opt-in behind `DEV=true` plus an installed optional peer (`src/ink/reconciler.ts:35-44`, `src/ink/devtools.ts:11`). One robustness nit, not a vulnerability: `createFileStorage` interpolates the developer-supplied `namespace` into a path under `~/.cache` without sanitization (`src/ink/hooks/use-persistent-state.ts:60`) — worth rejecting path separators defensively.

---

# Tooling

## @visulima/secret-scanner — `packages/tooling/secret-scanner`

> Rust/NAPI secret scanner with 1,058 bundled gitleaks+Kingfisher rules and a thin, well-tested TypeScript orchestration layer — overall in excellent health, with gaps mainly in cancellation, repeated-scan caching, and gitleaks feature parity (git history, SARIF).

#### DX improvements

- ✅ **[FIXED]** **No cancellation surface on public scan APIs.** `validateFinding` already accepts an `AbortSignal` (`src/validator/index.ts:37-43`), but the pipeline hardcodes `undefined` (`src/pipeline.ts:156`) and `ScanOptions` (`src/types.ts:35`) has no `signal` field. With `config.validate: true` a scan can fire hundreds of HTTP requests (plus DB-driver connections) with no way for a CLI/editor host to abort mid-flight. Threading one option through `postProcess` would finish plumbing that already exists.
- ✅ **[FIXED]** **Baseline is file-path-only.** `ScanOptions.baseline` (`src/types.ts:37`) only accepts a path; `loadBaselineSet` (`src/baseline.ts:32`) reads from disk. Editor/library consumers using `scanString` must round-trip suppressions through a file. Accepting an inline `Finding[]` or pre-computed fingerprint set — and shipping a `createBaseline(findings)` writer to pair with the exported `fingerprint` — would close the loop.
- ✅ **[FIXED]** **No programmatic tag/preset discovery.** `tag:` selectors throw with a known-tags hint only on a miss (`src/config-loader.ts:138-141`); there is no `listTags()` so consumers must call `listRules()` and aggregate `tags[]` themselves to build a `--list-presets` UX.

#### Optimizations

- ✅ **[FIXED]** **Repeated scans redo all JS-side preparation.** Every `scan`/`scanFiles`/`scanString` call re-runs `resolveConfig` + `gateOptInRules` + `buildRuleMeta` over ~1,058 rules (`src/prepare-scan.ts:117-148`) and re-reads + re-hashes the baseline file (`src/pipeline.ts:252`, `src/baseline.ts:32`). The Rust side caches compiled rulesets, but an editor integration calling `scanString` per save pays the full O(rules) + baseline-IO cost each time. Memoize `PreparedScan` by config identity and the baseline `Set` by path+mtime.
- ✅ **[FIXED]** **Validation pool copies every finding even when validation is impossible.** With `validate: true`, findings whose rule has no validation block still flow through the worker pool and get `{ ...finding, validation: "skipped" }` spreads (`src/pipeline.ts:137-139, 197-213`). Pre-partitioning by `ruleMeta.has(ruleId)` would skip the pool and the per-finding clone for the common no-validator majority.

#### Feature gaps

- **No git history scanning (gitleaks `git` mode).** Public surface is `scan`/`scanFiles`/`scanString` only (`src/index.ts`); nothing reads git revisions. The flagship gitleaks/trufflehog use case — "audit the full history before open-sourcing" or "scan this commit range in CI" with commit/author attribution on findings — requires consumers to hand-roll `git diff --name-only` plumbing (as `vis` does) and loses deleted-but-still-in-history secrets entirely.
- **No report-format helpers.** Findings come back as `Finding[]` with no serializers; gitleaks ships SARIF/JUnit/CSV. A pure `toSarif(findings)` helper would let CI users feed GitHub code scanning directly — `Finding` already carries everything SARIF needs (`src/types.ts:152-180`).
- **No async text scan.** `scanString` runs detection synchronously on the calling thread by design (`src/index.ts:93-102` documents the ~11 ms/550 KB cost and tells users to chunk or use a worker). An async `scanText` on the Rust thread pool — which `scan`/`scanFiles` already use — would make the documented workaround unnecessary for editor/server hosts.

#### Security

- ✅ **[FIXED]** **Validation can hang on hostile or misbehaving endpoints (low).** The 5 s timeout is cleared as soon as the fetch resolves (`src/validator/http.ts:259`), but the body read happens after that with no bound (`src/validator/http.ts:268-282`) — a slow-loris server trickling a body stalls a worker indefinitely. Separately, `observeRateLimit` trusts `Retry-After` with no cap (`src/validator/http.ts:100`), and `PerHostLimiter.acquire` sleeps until that deadline (`src/validator/per-host-limiter.ts:84-98`) — a single `429` with `Retry-After: 86400` pauses all validation for that host for a day. Cap the pause (e.g. 5 min) and keep the abort timer alive through the body read.
- ✅ **[FIXED]** **Opt-in validation sends secrets to URLs defined by rule configs (low).** `runHttpValidation` fetches whatever URL the rule's template renders (`src/validator/http.ts:194-246`). The bundled ruleset is trusted, but a shared/third-party config loaded via `config.path` can add a rule whose `validation.url` points at an attacker host, exfiltrating every matching secret when `validate: true`. The `ScanOptions.validate` JSDoc warns about sending secrets to providers (`src/types.ts:100-104`), but a host allowlist or a "validate bundled rules only" mode would close the untrusted-config channel.

---

## @visulima/task-runner — `packages/tooling/task-runner`

> @visulima/task-runner is a Rust-accelerated monorepo task runner (caching, scheduling, affected detection, Turbo/REAPI remote caches) with unusually thorough tests and defensive code; overall health is strong, with the main gaps in remote-cache verification defaults, archive memory behavior, and a silently-broken Windows shell-detection path.

#### DX improvements

- ✅ **[FIXED]** **`detectScriptShell` silently never works on Windows** — `src/detect-shell.ts:37` calls `execFileSync("npm", ...)` without `shell: true` or a `.cmd` fallback; since Node's CVE-2024-27980 hardening, spawning `npm` (a `.cmd` shim) this way throws ENOENT, which the `catch` swallows. The README explicitly advertises "Honors `npm config set script-shell` (Git Bash, etc.)" — the Git Bash use case is Windows-only, so the advertised feature degrades to platform default exactly where it matters. Use `npm.cmd` + `shell: true` on win32, or read `.npmrc` directly.
- ✅ **[FIXED]** **README API section is thin relative to a 100+ export surface** — `README.md:250-307` documents `defaultTaskRunner` in one sentence and lists exports as bare names. Security-relevant `RemoteCacheOptions` (`signing`, `attestation`, `compression`, `mode`) defined in `src/backends/types.ts` are absent from the README entirely, and the REAPI backend's optional-peer requirement (`@grpc/grpc-js`) is only discoverable via install errors. The `docs/` folder exists but isn't linked from the README.
- ✅ **[FIXED]** **No subpath exports** — `package.json:38-44` exposes only the barrel. Consumers wanting just the lightweight concurrent runner (`runConcurrently`, a concurrently/vite-task replacement) load the full ~850 KB chunked dist including cache, CAS, graph, and backend code in Node (no tree-shaking at require time). Subpaths like `./concurrent`, `./cache`, `./graph` would match how the README itself segments the feature set.

#### Optimizations

- 🟡 **[DEFERRED]** **Archive create/extract buffers entire trees in memory** — `src/archive.ts:43-85` (`collectEntries`) `readFile`s every output file into `TarFileInput[]`, then `nanoCreateTar` materializes the full tar buffer on top (entries + tar bytes live simultaneously, contradicting the comment at lines 219-223). Extract side (`decompressBuffer`, lines 174-185) likewise accumulates the whole decompressed tar. A 1 GB `dist/` cache entry costs ≥2 GB RSS. Streaming tar (or chunked entry feeding) would cap memory for large artifacts that the HTTP backend already streams "for multi-hundred-MB tarballs".
- ✅ **[FIXED]** **`HttpRemoteCache.retrieveAction` reads the downloaded tarball up to 4 times** — `src/backends/http.ts:265-324`: pipeline to disk, `stat`, full HMAC stream (`computeArtifactSignatureStream`), full sha256 stream (`digestFile`), then `putBlobFromFile` copies it again. Folding sha256 + HMAC into the download `pipeline` via PassThrough taps would make hydration single-pass.
- ✅ **[FIXED]** **`TerminalBuffer.#putChar` is O(line²)** — `src/terminal-buffer.ts:185-225` re-walks the line from index 0 (skipping ANSI runs) for every printable character, and `write` calls it per char. PTY-heavy output with long lines (progress bars, webpack stats) goes quadratic. Batch consecutive printable runs and track the last string-index/column pair between calls.

#### Feature gaps

- **No watch mode / daemon** — competitors ship `turbo watch` and the Nx daemon + `nx watch`; `src/incremental-hasher.ts` is even documented as "mtime-based, daemon-compatible", but nothing watches. User story: "save a file, affected tasks re-run automatically" — the affected detection (`src/affected.ts`) and incremental hasher are 80% of the machinery already.
- **Smart lockfile hashing skips Bun and modern pnpm/yarn protocols** — `src/lockfile-hasher.ts` parses npm/pnpm/yarn only; `bun.lock` (JSONC, text format since Bun 1.2) is unsupported, so Bun workspaces silently lose per-package invalidation. The regex parsers also have no handling for `catalog:`, `workspace:`, or `patch:` specifiers (no matches in the file), which this very monorepo uses — catalog-pinned deps can resolve to wrong/missing versions in the hash.

#### Security

- ✅ **[FIXED]** **Signature verification can be bypassed by omitting the header (medium)** — `src/backends/http.ts:157` defaults `verifyOnDownload` to `false`, and lines 257-263 + 292-298 only verify when the server _sends_ `X-Artifact-Signature`. With signing configured (the user's clear intent to authenticate artifacts), a compromised cache server or MITM simply strips the header and unsigned artifacts are extracted into the workspace and replayed as build outputs — remote-cache poisoning is arbitrary code execution in consumers' builds. Turborepo's equivalent (`signature: true`) always verifies. Default `verifyOnDownload` to `true` when `signing.secret` is present.

---

## @visulima/task-runner-client — `packages/tooling/task-runner-client`

> Zero-dependency, 137-line NDJSON hint emitter that lets tools give @visulima/task-runner cache-correctness hints (ignore inputs/outputs, disable caching, track env vars); the package is healthy, well-documented, and tested for both runner/no-runner modes, with only ergonomic and protocol-completeness gaps.

#### DX improvements

- ✅ **[FIXED]** **Export `HINTS_ENV` and an `isManaged()` predicate.** The env-var name is a private literal in `packages/tooling/task-runner-client/src/index.ts:13`. Tools that want to branch ("only compute expensive hint paths when actually under the runner") or write integration tests must hardcode `"TASK_RUNNER_HINTS"` — the package's own test does exactly that (`__tests__/index.test.ts:9`). A one-line `export const isManaged = (): boolean => Boolean(process.env.TASK_RUNNER_HINTS)` plus the constant closes this.
- ✅ **[FIXED]** **Export a named options type.** `getEnv`/`getEnvs` take an inline `{ tracked?: boolean }` (`src/index.ts:113,130`); wrapper authors can't reference it. Export `interface TrackOptions { tracked?: boolean }`.
- ✅ **[FIXED]** **Test gaps for the glob engine and pollution defense.** `__tests__/index.test.ts` covers both modes well, but `matchEnv`'s regex escaping (`src/index.ts:39-53`) has no test that `A.B*` doesn't match `AXB...`, and the deliberate `__proto__` defense (`src/index.ts:57-69`) has no regression test pinning it.

#### Optimizations

- ✅ **[FIXED]** **Dedupe repeated hints before writing.** `emit` runs `appendFileSync` — an open/write/close syscall trio — per call (`src/index.ts:29`), and ops are idempotent: a tool calling `getEnv("CI")` inside a per-file loop appends thousands of identical `trackEnv` lines the runner just aggregates (`packages/tooling/task-runner/src/cache-hints.ts:133-136`). A module-level `Set<string>` keyed on the serialized hint (reset when `TASK_RUNNER_HINTS` changes) makes repeat calls free without sacrificing the crash-durability of the first write.

#### Feature gaps

- **Resolve relative paths client-side.** `ignoreInput`/`ignoreOutput` ship the raw string (`src/index.ts:79-91`), and the runner resolves it against the child's _initial_ cwd (`packages/tooling/task-runner/src/cache-hints.ts:95-128`). A tool that calls `process.chdir()` before hinting gets silently wrong ignore roots, contradicting the README's "resolved against the task's working directory" promise (`README.md:69`). Resolving with `node:path.resolve()` at emit time keeps zero deps and removes the ambiguity.
- **Client never reads the protocol-version handshake.** The runner exports `TASK_RUNNER_PROTOCOL` / version `"1"` explicitly so clients can degrade across breaking wire changes (`packages/tooling/task-runner/src/cache-hints.ts:13-22`), but the client never consults it (`src/index.ts` has no reference). Reading it now — even just to gate future v2 ops — is what makes the escape hatch actually usable later.
- **No positive hints: `trackInput(path)` / `trackOutput(path)`.** The API can only _subtract_ from inferred inputs/outputs. Tools often know inputs the tracer can't see — files read by an untracked grandchild process or network-derived state (known tracer gaps on macOS/Windows child propagation). vite-task-style hint APIs gain a lot from the additive direction; the runner's `Hint` union (`cache-hints.ts:32-37`) skips unknown ops, so this is forward-compatible to add.
- **`disableCache()` carries no reason.** The runner reports only `disabled-by-task` in the run summary (`packages/tooling/task-runner/src/run-summary.ts:25`). `disableCache(reason?: string)` would make "why did my cache stop hitting?" debugging tractable, and an extra JSON field is ignored by current runners, so it's wire-safe.
- **No custom cache-key input.** A `trackValue(key, value)` op (Gradle/Bazel-style custom inputs) would cover non-file, non-env determinism inputs — DB schema revision, remote API version, tool flags computed at runtime — that today force a blunt `disableCache()`.

#### Security

No findings. The two obvious risk spots are already handled correctly: `matchEnv` escapes every regex metacharacter except `*` before compiling (`src/index.ts:53`), and the `__proto__`/`constructor` prototype-pollution vector is explicitly neutralized via the Map + `Object.fromEntries` materialization (`src/index.ts:57-69`). The append target comes from the runner-controlled environment, and all write failures are swallowed by design.

---

## @visulima/vis — `packages/tooling/vis`

> @visulima/vis is a sprawling but unusually mature monorepo dev-toolkit CLI (task running, caching, audit/SBOM, secrets, AI integrations) with ~350 test files, lazy-loaded command handlers, and careful supply-chain hygiene — overall healthy, with a handful of Windows-specific spawn hardening issues as the only real security exposure.

#### DX improvements

- ✅ **[FIXED]** **`readJsonFile` errors lose the file path** — `packages/tooling/vis/src/util/toolbox-fs.ts:12-13` does a bare `JSON.parse(await fs.readFile(path))`; a malformed JSON file surfaces as `Unexpected token …` with no indication of _which_ file. Since this is the pilot helper for the toolbox.fs handler migration, wrap the parse and rethrow with the path — every migrated command inherits the fix.
- ✅ **[FIXED]** **README under-documents the programmatic surface** — the `./config` subpath export (`packages/tooling/vis/src/config/index.ts`) ships 15+ symbols (`definePlugin`, `otelPlugin`, `SECURITY_DEFAULTS`, `loadVisConfig`, `defineTaskConfig`, …) and `./generate` exists too, but `README.md` only shows `defineConfig` once in passing (line ~175, installer-backend example). A short "Configuration API" section linking `docs/configuration.mdx` / `docs/guides/plugins.mdx` would make the plugin system discoverable from npm.
- ✅ **[FIXED]** **Greedy `v` bin name** — `package.json:63` claims the global `v` binary, which collides with the V language compiler and a very common shell alias. Worth a README note (or demoting to docs-recommended alias like the existing `docs/guides/shell-alias.mdx`). Related nit: `EXCLUDED_COMMANDS` in `src/util/upgrade-check.ts:36` lists `self-update`, which is not a registered command under `src/commands/`.

#### Optimizations

- ✅ **[FIXED]** **Head-of-line blocking in registry version fetches** — `packages/tooling/vis/src/util/catalog.ts:1486-1503` processes packages in fixed chunks of `concurrency` via `await Promise.allSettled(batch)` per iteration: one slow registry response (timeout is 15 s, `catalog.ts:1068`) stalls the entire next batch. A sliding worker pool (N in flight, refill on settle) would meaningfully cut `vis check` wall time on large catalogs with a flaky private registry.
- ✅ **[FIXED]** **`spawnTee` cap counts UTF-16 code units, not bytes** — `packages/tooling/vis/src/util/spawn-tee.ts:77-88` documents a 256 KiB byte cap but measures `output.length + text.length` on decoded strings, and rebuilds `output + text` before slicing once over the cap. Harmless functionally, but tracking byte length (or slicing the incoming chunk first) avoids the repeated full-buffer concat per chunk on chatty installs.

#### Feature gaps

- **No `vis release`** — Nx (`nx release`) and moon both ship version-bump + changelog + publish orchestration; vis covers everything around it (affected detection, attest, audit, hooks) but has no release command under `src/commands/`. The prior attempt (PR #620) never landed in installable form, so this remains the most-asked-for capability gap vs. Nx for teams not already on semantic-release.
- **Shell-history integration skips Windows entirely** — `packages/tooling/vis/src/util/shell-history.ts:26-28` returns early on win32, but PowerShell's PSReadLine history is a plain append-only text file (`ConsoleHost_history.txt`), so the interactive-picker → up-arrow replay story (a nice differentiator) could work for the large Windows audience with ~10 lines.

#### Security

- ✅ **[FIXED]** **[medium] `shell: true` on Windows joins repo-derived args unquoted** — `packages/tooling/vis/src/util/spawn-tee.ts:67` and `packages/tooling/vis/src/util/hadolint/index.ts:248` set `shell: process.platform === "win32"`, so Node concatenates the args array into a cmd.exe line without quoting. For hadolint the args are Dockerfile paths discovered in the repo (`runHadolint`, `hadolint/index.ts:244`); a directory legally named `app & calc` in a cloned untrusted repo executes on `vis docker lint` under Windows. The hadolint binary is a real `.exe` (not a `.cmd` shim), so the shell flag is unnecessary there; for the PM shim case in `spawnTee`, quote args or resolve the shim path explicitly.
- ✅ **[FIXED]** **[low] hadolint download verifies a same-origin checksum** — `packages/tooling/vis/src/util/hadolint/index.ts:114-127` fetches the `.sha256` sidecar from the same GitHub release as the binary, so a compromised release (or successful MITM of one origin) defeats verification. The version is already pinned (`HADOLINT_VERSION`, line 32); pin the per-asset digests in source too, making the check attacker-independent.
- ✅ **[FIXED]** **[low] zsh/bash history writers don't escape newlines** — `packages/tooling/vis/src/util/shell-history.ts:62,70` append the picked command line verbatim; only the fish writer (line 76) escapes `\n`. A task name containing a newline (repo-controlled via vis config) injects an arbitrary extra entry into `~/.zsh_history` / `~/.bash_history` that the user may later re-execute via up-arrow or Ctrl-R. Strip/escape control characters like the fish path does.

---

## @visulima/vis-mcp — `packages/tooling/vis-mcp`

> @visulima/vis-mcp is a thin, well-tested MCP stdio server that exposes 12 read-only vis CLI tools to AI agents; the code is clean and disciplined (single exec boundary, canonical response shape, ~90 tests), but the README is stale and the newer tools skip the argv-injection guards the older ones pioneered.

#### DX improvements

- ✅ **[FIXED]** **README documents 8 tools but the server registers 12** — `README.md` (tool table, ~lines 95–107) omits `audit`, `advisory_status`, `lint`, and `fmt`, and still says "All eight tools are read-only." The empty `## Related` section (line ~109) renders as a dangling heading. The package CLAUDE.md public-surface list is similarly stale (omits `registerLint`/`registerFmt`/`registerAudit`/`registerAdvisoryStatus`/template registrars). For an agent-facing package whose README is how humans decide what to expose, this is the highest-value doc fix.
- ✅ **[FIXED]** **No `structuredContent`/`outputSchema` on tool results** — `src/response.ts:17-26` serializes every payload to a JSON string in a `text` block. The MCP SDK supports `outputSchema` + `structuredContent`, which lets clients (Claude, Cursor) validate and render typed results instead of re-parsing strings — and the zod schemas already exist in `src/tools/lint.ts:32`, `src/tools/audit.ts:27`, `src/tools/advisory-status.ts:18`; they're just not registered.
- ✅ **[FIXED]** **No version-compatibility check on the resolved vis CLI** — `src/server.ts:38-80` resolves whatever `@visulima/vis` is installed, but the peer dep is pinned exact (`package.json:105`). An older vis without `--format json` on `lint`/`fmt` produces opaque "no JSON output" errors (`src/tools/lint.ts:96`) instead of "vis X.Y is too old, vis-mcp requires Z".

#### Optimizations

- ✅ **[FIXED]** **`describe_project` and `list_targets` respawn the full `vis list` subprocess per call and filter in JS** — `src/tools/describe-project.ts:25` runs `vis list --json` (full workspace graph, fresh Node boot each time) just to `.find()` one project; `src/tools/list-targets.ts:27-28` does the same with `.filter()`. Either forward a `--query name=<x>` filter to the CLI, or add a short-TTL memo of the list payload keyed on workspaceRoot — agents commonly call `list_projects` then `describe_project` back-to-back, paying double subprocess cost (typically hundreds of ms each).
- ✅ **[FIXED]** **Unbounded stdout accumulation in the exec layer** — `src/exec.ts:50-73` concatenates child stdout/stderr with no size cap (no `maxBuffer` equivalent). A misbehaving vis subcommand streaming gigabytes would balloon the MCP server's memory before the 120s timeout fires. A simple byte ceiling that kills the child and errors would bound it.

#### Feature gaps

- **No run-discovery tool** — `get_run_logs` (`src/tools/get-run-logs.ts:25`) accepts a `runId` but there is no `list_runs` tool, so an agent can only ever read "latest" or guess IDs. A tool that lists `.task-runner/runs/*.json` with timestamps/status would unlock "compare this run to the one before lunch" workflows (nx-console's MCP exposes run history for exactly this).
- **No `affected` tool** — agents scoping work want "which projects changed since `main`" before deciding what to lint/build. `lint`/`fmt` already forward `--since` (`src/tools/lint.ts:77`), so the CLI plumbing exists; a read-only `list_affected(since)` tool is the natural companion and a staple of comparable monorepo MCP servers.
- **Tools only — no MCP resources or prompts** — run summaries and project metadata are natural MCP _resources_ (URI-addressable, client-cacheable, subscribable) rather than tool calls; `src/server.ts:108-121` registers only tools. Exposing `vis://runs/{runId}` and `vis://projects/{name}` resources would let clients embed workspace state in context without burning tool-call round-trips.

#### Security

- ✅ **[FIXED]** **Argv flag injection bypasses the read-only contract (medium)** — `src/validation.ts:18-20` documents the exact threat ("a leading `-` would be parsed as a CLI flag by the vis CLI") and gates `taskId`/`runId` accordingly, but the newer tools skip the guard: `src/tools/describe-template.ts:41` passes `name` as a bare positional to `vis generate <name> --describe`, and `src/tools/lint.ts:81` / `src/tools/fmt.ts:75` splat user-supplied `files` entries directly into argv. An LLM-supplied `files: ["--fix"]` turns the lint tool — annotated `readOnlyHint: true` and described as "never applies fixes" — into a write operation; a `name: "--force"`-style value reaches `vis generate`'s flag parser. Spawn is argv-form (no shell), so this is flag injection rather than command injection, but it breaks the security annotation clients rely on for auto-approval. Fix: reject leading-`-` values (reuse the `isValidRunId`-style guard) or insert a `--` separator before positionals.

---

# Shared

## @shared/xxh3 — `shared/xxh3`

> Private shared pure-BigInt xxh3-128 implementation (vendored from xxh3-ts) used as the JS fallback for task-runner's native Rust hasher; small and well-structured, but it has a verified parity bug for 1-3 byte inputs and its tests check only output format, not correctness.

#### Correctness (verified bug)

- ✅ **[FIXED]** **Hash diverges from the native Rust addon for 1–3 byte inputs with a high middle byte** — `shared/xxh3/xxh3.ts:204`: `BigInt(data.readUInt8(len >> 1) << 24)` overflows JS int32 when the byte is >= 0x80 (e.g. `0xbf << 24` is negative), producing a negative BigInt that corrupts the low-64 lane of `combined`. Verified empirically against `task-runner-native.linux-x64-gnu.node`: `[0x80]` → JS `…66abb704c2b94dbe` vs native `…6b148c0872500941`; `[0x01,0xbf]` also mismatches, while `[0x01,0x7f,0x02]` and every other length class (4–8, 9–16, 17–128, 129–240, >240 bytes) match exactly. This breaks the module's stated guarantee ("identical hash output regardless of execution mode") and means task-runner cache keys differ between native and JS fallback modes for tiny non-ASCII inputs (e.g. hashing `"é"`). Fix: `(BigInt(data.readUInt8(len >> 1)) << 24n)`.

#### DX improvements

- ✅ **[FIXED]** **Tests never assert correctness, only shape** — every assertion in `shared/xxh3/__tests__/xxh3.test.ts` is either `/^[\da-f]{32}$/` or self-consistency; the line-204 bug passes all 15 tests. Add known-answer vectors per length class (empty input is `99aa06d3014798d86001c324468d497f`, confirmed against the Rust addon) including bytes >= 0x80, and a parity test against the native binding when it is present locally.
- ✅ **[FIXED]** **No README** — the directory has no README documenting the parity contract with the Rust addon, the vendoring provenance (xxh3-ts v2.0.1), or how to regenerate/verify test vectors. For a module whose whole purpose is bit-exact parity, that contract should be written down (`shared/xxh3/`).
- ✅ **[FIXED]** **`xxh3Hash` accepts only `Buffer` while `Xxh3Hasher.update` accepts `string | Buffer`** — `shared/xxh3/xxh3.ts:366` vs `:378`. Consumers like `packages/tooling/task-runner/src/utils.ts` mirror the native `hashString(string)`; accepting `string | Buffer` in `xxh3Hash` would remove `Buffer.from()` boilerplate at every call site.

#### Optimizations

- ✅ **[FIXED]** **Per-stripe Buffer view allocations on the long-hash hot path** — `getView` (`shared/xxh3/xxh3.ts:42`) allocates a fresh `Buffer` object per call; `accumulate` (`:111-117`) creates two views per 64-byte stripe, so hashing a 1 MB file allocates ~32k throwaway Buffers. Threading an integer offset through `accumulate512`/`accumulate`/`scrambleAcc` instead would eliminate nearly all GC pressure in the path task-runner uses for file hashing.
- ✅ **[FIXED]** **`bswap64` allocates a scratch Buffer per call** — `shared/xxh3/xxh3.ts:44-50` uses `Buffer.allocUnsafe(8)` + write/read; a pure BigInt shift/mask swap (like `bswap32` at `:52-59`) is allocation-free.
- ✅ **[FIXED]** **`mergeAccs` allocates four `BigUint64Array` copies per merge** — `shared/xxh3/xxh3.ts:141-144` (`acc.slice(0/2/4/6)`), and `hashLong128b` calls it twice per hash; `mix2Accs` could take a start index instead.

#### Feature gaps

- **Seed is implemented but not exposed** — `xxh3_128` accepts a `seed` parameter (`shared/xxh3/xxh3.ts:329`) yet the public `xxh3Hash`/`createXxh3Hasher` hardcode seed 0. If exposed, note that `hashLong128b` (`:344`) ignores the seed entirely (reference XXH3 derives a custom secret for seeded long inputs), so seeded hashes > 240 bytes would silently be wrong today — either wire it through correctly or remove the dead parameter.
- **`Xxh3Hasher` has no `reset()` and `digest()` is not terminal** — `shared/xxh3/xxh3.ts:375-391`: chunks keep accumulating after `digest()`, unlike `node:crypto` hashers which throw. Either document the reusable semantics or add `reset()` and a post-digest guard to prevent silent misuse.

---
