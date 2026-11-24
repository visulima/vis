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

## Natively routed commands

`run-commands.sh` times every command the launcher hands to the native binary (the routing table in `bin/route.mjs`: `NATIVE_COMMANDS`, `alwaysNative`, `NATIVE_SHAPE_GATES`) in a generated workspace, against the Node implementation and, where a real tool does the same job, against that tool. The scenarios are in `commands.cases.json`; the suite lists any routed command that has none, so a later port shows up as a warning until a scenario is added.

```sh
bash __bench__/cli/run-commands.sh                                    # every scenario, 1, 20 and 200 packages
bash __bench__/cli/run-commands.sh --only '^(version|list|run-)' --sizes 20 --runs 30
bash __bench__/cli/run-commands.sh --markdown /tmp/commands.md        # the table as Markdown too
bash __bench__/cli/run-commands.sh --check-budgets __bench__/cli/commands.budgets.json
bash __bench__/cli/run-commands.sh --write-budgets __bench__/cli/commands.budgets.json
bash __bench__/cli/run-commands.sh --list                             # scenarios and unlisted routes, no timing
```

Needs hyperfine 2 or newer (per-command environments, peak memory), node, python3 and git, and a built package: `pnpm run build:prod` (the development build fails once the `tui` package has a `dist`), the addons of vis, `task-runner` and `secret-scanner` (`pnpm run build:native` in each), and `pnpm run build:native:cli`, which puts `vis-native-cli` in the package root. `bun`, `pnpm` and `npm` are optional comparators. Building the addons rewrites some tracked `index.js`/`index.d.ts` files; do not commit those.

### Variants

| Column | What runs | What it means |
| --- | --- | --- |
| native binary | `vis-native-cli <args>` | the binary alone, as the installed `bin/vis` will be. `run` is the exception: the binary only answers it with the environment the launcher hands over (`VIS_HANDOFF`, `VIS_NODE_VERSION`, `VIS_HANDBACK_STATUS`), so that variant carries it and is labelled "binary + hand-off env" in the JSON. |
| launcher | `node bin/vis.mjs <args>` | what `npx vis` / the npm bin pays today: a Node start, the routing table, the binary. |
| Node | `node dist/bin.js <args>` | the Node implementation alone, what the command cost before it was ported. |
| comparators | `bun run`, `pnpm -r run`, `npm run`, `pnpm exec`, `bun x`, `bun <file>`, `pnpm why`, `bun outdated`, ... | real tools, in a separate copy of the fixture with the real `PATH`. They are only checked to exit 0, not for the same output. |
| stub pm (floor) | the stand-in `pnpm` run directly | for the commands that hand over to a package manager (`exec`, `pm`, `why`, `outdated`, `dlx`, `info`, `install`, `add`, `remove`, `dedupe`). vis runs against stand-in package managers that print one line (no network, no install), so the number is vis's own cost on top of the spawn the stand-in costs. A real package manager adds its own start-up on top; do not read a stubbed vis row against a real tool's row as a like-for-like comparison. |

`run build` has three scenarios: all tasks cache hits (the native binary answers it), the last task a miss (the binary keys and looks up every task, then hands the run back with exit 75 and the launcher runs Node: launcher minus Node is the cost of the failed native attempt), and a cold run (no task cache directory: the launcher does not start the binary at all). For the miss, the "binary" column is the attempt plus the hand-back.

### Validation before timing

Each variant is checked first, in the same environment it will be timed in, and a variant that fails is skipped with the reason printed (and kept in `results/commands-*/*.meta.json`):

- **Same answer as Node:** stdout, stderr and the exit code, with durations, clock times and run ids masked (and the lines sorted for `run`, where the order of the interleaved lines may differ). Node is run twice first; if its masked output is not stable, only the exit code and the delegation check apply.
- **Really native:** the native variants run with `VIS_FALLBACK_ENTRY_OVERRIDE` pointing at a stub entry that prints a marker. The binary delegates to that entry when it cannot answer, so a run that handed itself to Node is seen as a delegation and is not timed as a native number. A launcher run that ends in Node (the routing table says so, or the binary delegated) is still timed, because that is what the user pays, but it is marked `(Node)` in the table.
- **Routed:** a scenario the routing table sends to Node on this base (`sbom`, today) is reported and not run.
- **Still the same after timing:** the binary is run again after the timing, and a changed answer is a note. A base-family fixture that changed on disk is a note too.
- `exec` and `outdated` are the exception: their printed output differs from Node's (the cause is not isolated), so they are timed on the exit code only, the table says so in the command cell, and the difference is listed in the notes.
- **A real answer:** each scenario names a string the Node answer must contain (`expect` in `commands.cases.json`: a hash, a diff, listed runs, `Would remove`, ...). A fixture that makes the command print an error instead is reported as invalid, not timed.

### Why the fixture is built the way it is

The native binary answers only inside a narrow context, and outside it delegates to Node, so a fixture that misses it silently measures Node. `gen-workspace-fixture.sh` and the harness provide what the gate looks for:

- `CI=1` in an otherwise empty environment (`env -i`), stdout and stderr that are not a terminal (hyperfine `-N` sends them to `/dev/null`), no `FORCE_COLOR`/`NO_COLOR` conflict, no `DEBUG`, a plain `TERM`.
- A pnpm workspace whose root is the working directory, with a `pnpm-lock.yaml` next to `pnpm-workspace.yaml`. The native root search finds the root only next to a lockfile; without it every native command delegates.
- No `vis.config.*`, and no root marker, config or Deno file in any parent directory. The fixtures are therefore built under the system temp directory, not inside the repository (`VIS_BENCH_DIR` moves them; the script refuses a directory below a marker).
- For `run`: an install the lockfile check accepts (`node_modules/.modules.yaml`, `node_modules/.pnpm/lock.yaml`, written after the lockfile), a root `package.json` without `engines`/`packageManager`/`volta`, no toolchain pin file, no `.vis/runs`, and an existing task cache. A `bun.lock` or `package-lock.json` next to the lockfile makes it delegate too, which is why comparators run in their own copy.
- One copy of the workspace per scenario family (`base`, `warm` for a filled task cache, `runs` for recorded runs, and one each for the late-miss and cold runs): the states conflict. `replay` needs `.vis/runs`, which the native `run` refuses.

The harness checks all of this before it times anything; if the binary delegates anyway you get the reason in the table, not a fast number.

### Budgets

`commands.budgets.json` holds a maximum median per command and variant: the larger of twice the median and the median plus 10 ms, from a quiet run on the machine named in the file. `--write-budgets` writes it; an existing file is merged and the larger limit is kept, so limits only ever grow (delete the file to start again). `--check-budgets` compares a run with it. The budgets are **machine-relative** (the file names the machine they come from): re-derive them with `--write-budgets` on another machine. They are a local aid for spotting a gain or a regression, **not wired into CI**: timings on shared runners are too noisy for a fixed limit. A native variant that starts answering from Node fails its check.

The suite prints `uptime` and warns when the 1-minute load average is above the number of cores; numbers taken under load are not worth comparing.

### Where we stand

One machine's numbers, not a promise: Apple M4 (10 cores), macOS, Node 22.23.4, hyperfine 2.0.0, bun 1.4.4, pnpm 11.28.2, 2026-11-24, 20 runs after 3 warm-up runs, median wall time in ms, load average about 3 at the start and the end. The native binary is a release build of this branch; `dist/` is `build:prod`. Re-run on your own machine before comparing anything.

| Command (fixture packages) | native binary | launcher | Node | real tools |
| --- | --- | --- | --- | --- |
| `--version` | 1.7 | 27.9 | 121 | `node -e 0` 20.2, `bun --version` 2.7, `pnpm --version` 44.3 |
| `list` (20) | 6.2 | 31.9 | 191 | `bun pm ls` 3.9, `pnpm ls -r --depth -1` 48.7 |
| `list` (200) | 64.2 | 92.3 | 292 | `bun pm ls` 9.7, `pnpm ls -r --depth -1` 55.1 |
| `sort-package-json --check` (200) | 6.8 | 33.8 | 191 | |
| `cache list` / `cache hash` / `replay --list` (200) | 5.6 / 2.1 / 1.9 | 31.3 / 27.4 / 27.5 | 191 / 176 / 174 | |
| `clean --dry-run` / `ignore` | 2.7 / 1.8 | 28.6 / 27.8 | 178 / 174 | |
| `run build`, all hits (1) | 2.6 | 29.3 | 250 | `bun run --filter` 11.9, `pnpm -r run` 69.0, `npm run -ws` 79.2 |
| `run build`, all hits (20) | 8.3 | 36.0 | 288 | `bun run --filter` 43.6, `pnpm -r run` 145, `npm run -ws` 165 |
| `run build`, all hits (200) | 85.9 | 114 | 521 | `bun run --filter` 341, `pnpm -r run` 850, `npm run -ws` 944 |
| `run build`, last task a miss (20; 40 runs) | 8.5 (hand-back only) | 415 | 380 | |
| `run build`, last task a miss (200; 40 runs) | 99.6 (hand-back only) | 826 | 606 | |
| `run build`, cold (20 / 200) | n/a | 420 / 839 | 401 / 847 | |
| `exec noopbin` (stub pm; output differs, exit code compared) | 7.4 | 34.2 | 81.5 | stub pm 2.8; real: `pnpm exec` 49.8, `bun x` 12.6, `npm exec` 134 |
| `x hello.ts` | 34.4 | 60.9 | 46.2 | `bun hello.ts` 11.5, `node -e 0` 20.9 |
| `why left-pad`, `pm list`, `outdated`, `remove`, `dedupe` (stub pm) | 4.5 to 4.7 | about 30 | 177 to 180 | stub pm 2.8; real: `pnpm why` 54.1, `pnpm outdated` 50.4, `bun outdated` 3.8 |
| `install --frozen-lockfile` (stub pm) | 16.3 | 40.3 | 308 | stub pm 3.5 |
| `dlx --no-info cowsay` (stub pm) | 4.6 | 31.1 | 82.1 | stub pm 2.8 |
| `secrets --quiet` | delegates | 1527 (Node) | 1680 | |
| `complete -- vis ""` | not comparable (exit 0, Node exits 1) | | 171 | |
| `sbom` | not routed to the binary on this base | | | |

Peak memory of one run: native binary 2 to 5 MB, launcher about 42 MB (its Node), Node implementation 110 to 175 MB.

What this shows, on this machine:

- Every native command answers in 2 to 8 ms for a small workspace, 5 to 6 times faster than the launcher and 20 to 90 times faster than Node alone. The launcher adds about 25 ms: a Node start (`node -e 0` is 20 ms here) before it hands over. The shipped `bin/vis` is the binary itself and skips that.
- `list` is the one native command that grows with the workspace: 64 ms for 200 packages, against `bun pm ls` at 10 ms. `run` with all hits also grows (86 ms for 200 tasks) but stays far below the other tools.
- A run that is not all hits pays for the failed native attempt. With the last task a miss, the launcher took 35 ms more than Node alone for 20 packages and 190 to 220 ms more for 200 packages (two quiet runs each, 20 and 40 runs; a run under load differed by more than the 20-package difference, so treat that one as small). The hand-back alone takes 9 ms (20) to 100 ms (200); the rest of the difference is the launcher's second step into Node. A cold run is within noise of Node (about 20 ms either way): the launcher skips the binary when there is no task cache.
- `run` is answered natively only with the launcher's hand-off environment. A binary started without it (the installed `bin/vis` once it runs without the launcher) hands every `run` to Node.
- `x` is barely faster than Node (it starts Node with the preload), and `bun <file>` is three times faster.
- `secrets --quiet` delegates to Node in this fixture (the cause was not isolated), so it has no native number. `complete -- vis ""` is answered natively (`:0`, exit 0) but the Node implementation run directly exits 1 without output, so the two cannot be compared and it is skipped. `exec` and `outdated` print something other than Node does (with the stand-in package manager the binary prints its line and Node prints nothing or another text; the cause was not isolated), so those two are timed on the exit code only and carry that remark in the table.

## Fixtures

Install fixtures mirror nub's: `simple` (~435 pkgs), `monorepo` (~407 pkgs / 4 workspaces), `t3` (Next/tRPC/Drizzle — Bun's create-t3-app bench), `large` (~1168 pkgs). Generate lockfiles with `bash __bench__/cli/gen-fixtures.sh` after editing a fixture's `package.json`. Each tool installs from its own lockfile family (`pnpm-lock.yaml`, `bun.lock`, `package-lock.json`); foreign lockfiles are pruned per-tool so no tool reads a stale lock.
