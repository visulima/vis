# vis CLI benchmark harness

Wall-clock benchmarks for vis's hot paths — **script dispatch** (`vis run`), **bin dispatch** (`vis exec` / `visx`), and **install** (`vis install`) — measured against pnpm / npm / bun with [`hyperfine`](https://github.com/sharkdp/hyperfine).

The methodology is **ported from [`nubjs/nub`](https://github.com/nubjs/nub)'s `tests/bench/` suite** (MIT). The two load-bearing ideas we keep verbatim:

1. **Pure-shell `noop` payloads.** Dispatch benchmarks run a script/bin that is pure shell (`true` / `exit 0`), **never** `node -e …`. Node's ~40 ms cold startup would swamp the few-ms runner overhead and dilute the exact thing being measured.
2. **Rename-aside teardown, excluded from timing.** Install benchmarks wipe `node_modules` between runs via hyperfine `--prepare` (untimed) using an atomic `mv` to a trash dir + detached `rm`, so a tool's deletion cost (1–12 s for materialized stores) never leaks into the install number.

## Why this exists

vis is a **Node** CLI (`dist/bin.js`); nub is a single Rust binary. vis therefore _starts behind_ on raw dispatch — cerebro boot + jiti config load are real costs that `pnpm run` doesn't pay. **That gap is the point.** This harness establishes the baseline before the cross-runtime multi-tool work (see `rfc/design-runtime-multitool.md`), so the Phase 4 native hot-path work (local-first bin resolution, native script dispatch) can be measured against a number instead of a vibe.

## Prerequisites

```sh
brew install hyperfine          # macOS; see hyperfine README for Linux
pnpm --filter @visulima/vis run build   # produces dist/bin.js + dist/binx.js
```

`pnpm` and `npm` are required; `bun` is optional (added to the comparison when present).

## Running

```sh
# from packages/tooling/vis/
bash __bench__/cli/run-script-runner.sh      # vis run vs pnpm/npm/bun run
bash __bench__/cli/run-bin-runner.sh         # vis exec / visx vs pnpm/npm exec, bun x
bash __bench__/cli/run-install.sh            # vis install vs pnpm/bun/npm (warm + cold)
bash __bench__/cli/run-install.sh --warm-only --fixture simple
```

Each writes a hyperfine JSON export to `__bench__/cli/results/`. Override the binary under test with `VIS=/path/to/bin.js` (defaults to `./dist/bin.js`).

## Scenario → vis command map

| nub scenario           | nub command                     | vis equivalent                  | what it isolates                       |
| ---------------------- | ------------------------------- | ------------------------------- | -------------------------------------- |
| Script-runner dispatch | `nub run noop`                  | `vis run noop`                  | cerebro boot + script lookup + spawn   |
| Bin-runner dispatch    | `nub exec` / `nubx`             | `vis exec` / `visx`             | `node_modules/.bin` resolution + spawn |
| Install (warm)         | `nub install --frozen-lockfile` | `vis install --frozen-lockfile` | wrapper overhead over the delegated PM |
| Install (cold)         | empty stores                    | empty stores                    | full resolve + fetch + link            |

## nub's published targets (Apple M1 Max, Node v24.14.0)

These are the numbers to chase. vis will not match Rust dispatch today — record where we land and track it down.

**Script dispatch (`run noop`, pure-shell):**

| Command         | Mean       | vs nub |
| --------------- | ---------- | ------ |
| `nub run noop`  | **9.2 ms** | 1.0×   |
| `npm run noop`  | 104.0 ms   | 11.4×  |
| `pnpm run noop` | 160.9 ms   | 17.6×  |

**Bin dispatch (`exec esbuild --version`):**

| Command     | Mean        | vs nub |
| ----------- | ----------- | ------ |
| `nub exec`  | **11.2 ms** | 1.0×   |
| `pnpm exec` | 190.6 ms    | 17.0×  |
| `npx`       | 225.5 ms    | 20.1×  |

**TS file execution (informs the future `vis x`):** `bun hello.ts` 11.2 ms · `node hello.js` 25.8 ms · `nub hello.ts` 44.4 ms · `tsx hello.ts` 127.8 ms.

**PM shim overhead:** nub adds **+4.9 ms** over `node pnpm.cjs -v`; corepack adds +14.0 ms. This is the bar for `vis install`'s wrapper overhead — vis delegates to the PM, so its overhead-over-raw-PM is the comparable metric.

## Native micro-benchmarks (`cargo bench`)

The hyperfine harness here measures **process wall-clock** and the vitest harness
measures **in-process JS**; neither can isolate the Rust hot paths inside the
native addons — the Node-boot floor swamps them (see `BASELINE.md` §findings).
[`nubjs/nub#17`](https://github.com/nubjs/nub/pull/17) solved the same problem
with a [criterion](https://github.com/bheisler/criterion.rs) harness (`cargo bench
-p nub-core`); we mirror it:

```sh
pnpm --filter @visulima/task-runner run bench:native   # graph + file-hasher
pnpm --filter @visulima/vis          run bench:native   # oxc transpile
```

- `task-runner/native/benches/graph.rs` — `topological_sort`, `find_all_cycles`,
  `get_transitive_deps` on a synthetic layered DAG (200 / 600 nodes), the
  counterpart to nub's `workspace/topological_chunks`.
- `task-runner/native/benches/file_hasher.rs` — xxh3-128 throughput, the
  counterpart to nub's `cache-hash` bench.
- `vis/native/benches/transform.rs` — oxc TS→JS transpile, closing the
  "transpile benchmark gap" nub documented.

Also migrated from that PR: `graph.rs` now hashes its adjacency/in-degree maps
with `rustc-hash`'s `FxHashMap` (nub's `workspace/filter.rs` change) — trusted
in-process IDs don't need SipHash's DoS resistance.

## Git hooks

`run-hooks.sh` times one `pre-commit` run over 60 staged files for vis, hk, prek, lefthook and pre-commit (missing tools are skipped), in two modes: the tool's own `run` command, and `git hook run pre-commit` after each tool's own `install` — the whole chain a real commit pays. Scenarios: **A** one hook over all files, **B** four hooks filtered by extension, **C** four built-in text-hygiene hooks. Timing is plain `hyperfine` (JSON + Markdown tables land in `results/`); before timing, every tool is validated to exit 0 and to have received all 60 files, so a tool that silently matches nothing cannot look fast.

```sh
bash __bench__/cli/run-hooks.sh                                   # all scenarios, both modes
bash __bench__/cli/run-hooks.sh --scenarios A,B --modes installed --runs 30
bash __bench__/cli/run-hooks.sh --expect-native                   # fail unless vis took the native path
```

Needs `pnpm run build && pnpm run build:native:cli` first. `vis (native)` and the installed-hook row use `vis-native-cli`; `vis (launcher)` is `node bin/vis.mjs`, i.e. what typing `vis hook run` pays.

## Formatter

`run-fmt.sh` times `vis fmt --check` against the oxfmt it bundles (run directly) and `bun fmt --check`, on a generated tree with one shared `.oxfmtrc.json`:

```sh
bash __bench__/cli/run-fmt.sh                       # 1, 60 and 600 files; a clean and a dirty tree each
bash __bench__/cli/run-fmt.sh --sizes 600 --runs 30
```

- `clean` trees are already formatted (every tool must exit 0); on `dirty` trees every 10th file has leading blank lines (every tool must exit 1 and report exactly those files). A tool that fails this check is skipped for that tree, with the reason printed.
- The `oxfmt` row is the floor `vis fmt` adds to: the same engine without vis's launcher, config resolution and child process.
- Check mode only, so runs are repeatable.

Reference run (Apple M4, Node 22.23.4, Bun 1.4.4, hyperfine 2.0, 15 runs, mean wall time):

| Files | Tree  | `vis fmt` | `oxfmt` | `bun fmt` |
| ----- | ----- | --------- | ------- | --------- |
| 1     | clean | 286 ms    | 86 ms   | 14 ms     |
| 60    | clean | 307 ms    | 87 ms   | 16 ms     |
| 600   | clean | 299 ms    | 90 ms   | 22 ms     |
| 600   | dirty | 303 ms    | 89 ms   | 22 ms     |

The `vis fmt` and `oxfmt` times barely move between 1 and 600 files, so most of the time is process start-up and not formatting; `vis fmt` spends about 200 ms more than the bundled oxfmt alone.

## Fixtures

Install fixtures mirror nub's: `simple` (~435 pkgs), `monorepo` (~407 pkgs / 4 workspaces), `t3` (Next/tRPC/Drizzle — Bun's create-t3-app bench), `large` (~1168 pkgs). Generate lockfiles with `bash __bench__/cli/gen-fixtures.sh` after editing a fixture's `package.json`. Each tool installs from its own lockfile family (`pnpm-lock.yaml`, `bun.lock`, `package-lock.json`); foreign lockfiles are pruned per-tool so no tool reads a stale lock.
