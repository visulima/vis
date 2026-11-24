#!/usr/bin/env bash
# Natively routed commands: native binary vs launcher vs Node, with real tools as comparators.
#
# For every scenario of commands.cases.json (the commands of the routing table in bin/route.mjs) in a generated
# workspace that sits INSIDE the native gate, up to four variants are timed with `hyperfine -N`:
#
#   binary    `vis-native-cli <args>`    the native binary started directly (the shipped `bin/vis` once installed)
#   launcher  `node bin/vis.mjs <args>`  the normal npm start: Node boots, the routing table decides, the binary answers
#   node      `node dist/bin.js <args>`  the Node implementation alone, what every command cost before it was ported
#   other     real tools (`bun run`, `pnpm exec`, ...) in a separate copy of the fixture, or for package-manager
#             commands the stand-in package manager run directly (the spawn cost the command cannot go below)
#
# Validation comes before timing, per variant. The output (stdout, stderr, exit code, masked for durations and ids) must
# match Node's; and the native variants run with a stub Node entry that prints a marker, so a run that handed itself to
# Node is seen as a delegation and never timed as a native number. A variant that disagrees is skipped, with the
# reason printed. A command the routing table does not send to the binary on this base is reported, not timed.
#
# Fixtures (gen-workspace-fixture.sh) are pnpm workspaces with a lockfile, no vis.config, and `CI=1` in a scrubbed
# environment with stdout and stderr not a terminal: the shape the native gate answers. A fixture outside the gate
# measures Node (see README.md).
#
# Requires: hyperfine >= 2 (per-command environments and memory metrics), node, python3, git; a built package
# (`pnpm run build:prod`, the vis and task-runner addons, `pnpm run build:native:cli`). Optional: bun, pnpm, npm.
#
#   bash __bench__/cli/run-commands.sh                                   # every scenario, sizes 1, 20, 200
#   bash __bench__/cli/run-commands.sh --only '^(version|list|run-)' --sizes 20 --runs 30
#   bash __bench__/cli/run-commands.sh --markdown /tmp/commands.md --check-budgets __bench__/cli/commands.budgets.json
#   bash __bench__/cli/run-commands.sh --write-budgets __bench__/cli/commands.budgets.json
#   bash __bench__/cli/run-commands.sh --list
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$BENCH_DIR/../.." && pwd)"
LIB=(python3 -I "$BENCH_DIR/run-commands-lib.py")
CASES="$BENCH_DIR/commands.cases.json"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

WARMUP=3
RUNS=20
CMP_RUNS=10
SIZES="1,20,200"
DEFAULT_SIZE=20
ONLY=""
MARKDOWN=""
CHECK_BUDGETS=""
WRITE_BUDGETS=""
NO_COMPARATORS=0
LIST_ONLY=0
KEEP=0
RESULTS_DIR="$BENCH_DIR/results/commands-$TIMESTAMP"

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --warmup)        WARMUP="$2"; shift 2 ;;
    --runs)          RUNS="$2"; shift 2 ;;
    --sizes)         SIZES="$2"; shift 2 ;;
    --only)          ONLY="$2"; shift 2 ;;
    --markdown)      MARKDOWN="$2"; shift 2 ;;
    --check-budgets) CHECK_BUDGETS="$2"; shift 2 ;;
    --write-budgets) WRITE_BUDGETS="$2"; shift 2 ;;
    --results-dir)   RESULTS_DIR="$2"; shift 2 ;;
    --no-comparators) NO_COMPARATORS=1; shift ;;
    --list)          LIST_ONLY=1; shift ;;
    --keep)          KEEP=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "Unknown arg: $1 (see --help)" >&2; exit 1 ;;
  esac
done
[[ $RUNS -lt $CMP_RUNS ]] && CMP_RUNS="$RUNS"

have() { command -v "$1" &>/dev/null; }
die() { echo "ERROR: $*" >&2; exit 1; }

have hyperfine || die "hyperfine not found (brew install hyperfine)."
have node || die "node not found."
have python3 || die "python3 not found."
have git || die "git not found."
HF="$(command -v hyperfine)"
NODE="$(command -v node)"
NODE_DIR="$(dirname "$NODE")"
HF_VERSION="$("$HF" --version | awk '{print $2}')"
[[ "${HF_VERSION%%.*}" -ge 2 ]] || die "hyperfine $HF_VERSION is too old: this suite needs 2.x (per-command --env and --metrics memory_peak_resident)."

BIN="${VIS_NATIVE_BIN:-$PKG_ROOT/vis-native-cli}"
LAUNCHER="$PKG_ROOT/bin/vis.mjs"
DIST="$PKG_ROOT/dist/bin.js"
[[ -x "$BIN" ]] || die "no native binary at $BIN (pnpm run build:native:cli)."
[[ -f "$DIST" ]] || die "vis is not built ($DIST missing): pnpm run build:prod, plus the task-runner addon."
[[ -f "$LAUNCHER" ]] || die "$LAUNCHER missing."
NODE_VERSION="$("$NODE" -p process.version)"

# ---- machine ----------------------------------------------------------------------------------------------------

CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)"
LOAD="$(uptime | sed -E 's/.*load averages?: *//' | awk '{gsub(",", ".", $1); print $1}')"
CPU="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || awk -F: '/model name/ {gsub(/^ +/, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null || uname -m)"
ENVIRONMENT="$CPU, $CORES cores, $(uname -sm), Node $NODE_VERSION, hyperfine $HF_VERSION, bun $(have bun && bun --version || echo none), pnpm $(have pnpm && pnpm --version 2>/dev/null || echo none), $(date +%Y-%m-%d)"

echo "================================================================"
echo "  vis command benchmark (natively routed commands)"
echo "  machine:   $ENVIRONMENT"
echo "  load:      $(uptime | sed -E 's/^.*(load averages?)/\1/')"
if awk -v load="$LOAD" -v cores="$CORES" 'BEGIN { exit !(load > cores) }'; then
  echo "  WARNING:   the 1-minute load average ($LOAD) is above the core count ($CORES): the numbers will be noisy. Close other work and re-run."
fi
echo "  binary:    $BIN"
echo "  launcher:  $LAUNCHER"
echo "  node impl: $DIST"
echo "  runs: $RUNS (warmup $WARMUP), sizes: $SIZES"
echo "================================================================"

# ---- routing table discovery ------------------------------------------------------------------------------------

ROUTES=("$NODE" "$BENCH_DIR/run-commands-routes.mjs" "$PKG_ROOT")
TABLE_NAMES="$("${ROUTES[@]}" names)"
COVERED="$("${LIB[@]}" covered "$CASES")"
UNCOVERED="$(comm -23 <(printf '%s\n' "$TABLE_NAMES" | sort) <(printf '%s\n' "$COVERED" | sort) | paste -sd, -)"
if [[ -n "$UNCOVERED" ]]; then
  echo "  NOTE: routed commands without a scenario (add one to commands.cases.json): ${UNCOVERED//,/, }"
fi
if [[ $LIST_ONLY -eq 1 ]]; then
  echo ""
  "${LIB[@]}" cases "$CASES" | awk -F'\t' '{ printf "  %-26s family=%-5s scales=%s stubs=%s mode=%s  vis %s\n", $1, $2, $3, $4, $6, $9 }'
  exit 0
fi

# ---- workspace and stubs ----------------------------------------------------------------------------------------

mkdir -p "$RESULTS_DIR/cap" "$RESULTS_DIR/log"
RESULTS_DIR="$(cd "$RESULTS_DIR" && pwd)"
if [[ -n "${VIS_BENCH_DIR:-}" ]]; then
  mkdir -p "$VIS_BENCH_DIR"
  WORK="$(cd "$VIS_BENCH_DIR" && pwd -P)"
else
  WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/vis-commands-bench-XXXXXX")" && pwd -P)"
fi
if [[ $KEEP -eq 0 && -z "${VIS_BENCH_DIR:-}" ]]; then trap 'rm -rf "$WORK"' EXIT; else echo "  fixtures kept in $WORK"; fi

# A parent directory with a root marker or a config would move the native root search or silence the gate.
for marker in lerna.json turbo.json pnpm-workspace.yaml package.json pnpm-lock.yaml package-lock.json npm-shrinkwrap.json yarn.lock bun.lock bun.lockb deno.json deno.jsonc deno.lock vis.config.ts vis.config.js vis.config.mjs vis.config.json; do
  d="$(dirname "$WORK")"
  while :; do
    [[ -e "$d/$marker" ]] && die "$d/$marker sits above the fixture directory $WORK: the native root search would stop there and every native command would delegate. Set VIS_BENCH_DIR to a directory outside any project."
    [[ "$d" == "/" ]] && break
    d="$(dirname "$d")"
  done
done

# A stand-in package manager (no network, no install), and a Node entry that only prints the delegation marker. The stub
# package keeps a `dist/runtime` link so `vis x` finds its preload next to the entry it is told to use.
STUBS="$WORK/stubs"
mkdir -p "$STUBS" "$WORK/stubpkg/dist"
for manager in pnpm npm yarn bun; do
  printf '#!/bin/sh\necho "stub-pm %s $*"\nexit 0\n' "$manager" > "$STUBS/$manager"
  chmod +x "$STUBS/$manager"
done
printf 'console.log("__VIS_BENCH_DELEGATED__");\nprocess.exitCode = 99;\n' > "$WORK/stubpkg/dist/bin.js"
ln -s "$PKG_ROOT/dist/runtime" "$WORK/stubpkg/dist/runtime"
STUB_ENTRY="$WORK/stubpkg/dist/bin.js"

REAL_PATH="$PATH"
TMP_FOR_ENV="${TMPDIR:-/tmp}"

# The environment every variant runs in: nothing inherited, so a stray DEBUG, GITHUB_ACTIONS, FORCE_COLOR or TERM
# cannot flip a gate. `CI=1` and a plain `COLUMNS` are what the gate wants.
base_env() { # <with stubs: 0|1>
  local path="$NODE_DIR:/usr/bin:/bin"
  [[ "$1" == 1 ]] && path="$STUBS:$path"
  printf '%s\n' "PATH=$path" "HOME=$HOME" "TMPDIR=$TMP_FOR_ENV" "CI=1" "COLUMNS=80"
}

HANDOFF_ENV=("VIS_HANDOFF=launcher" "VIS_NODE_VERSION=$NODE_VERSION" "VIS_HANDBACK_STATUS=75" "VIS_NODE=$NODE")

# ---- fixtures ---------------------------------------------------------------------------------------------------

make_base() { # <size>
  local dir="$WORK/base-$1"
  [[ -d "$dir" ]] && return
  bash "$BENCH_DIR/gen-workspace-fixture.sh" "$dir" "$1" >/dev/null
}

node_run() { # <dir> <args...>: a run of the Node implementation in the gate's environment
  local dir="$1"; shift
  local envs=()
  while IFS= read -r line; do envs+=("--env" "$line"); done < <(base_env 0)
  "${LIB[@]}" run --cwd "$dir" --out "$WORK/setup" "${envs[@]}" -- "$NODE" "$DIST" "$@"
  [[ "$(cat "$WORK/setup.code")" == 0 ]] || die "setting up $dir failed: node dist/bin.js $* exited $(cat "$WORK/setup.code"): $(head -c 400 "$WORK/setup.err")"
}

# fixture <family> <size>: prints the directory. Each family is its own copy, because their states conflict:
# `replay` needs .vis/runs, which the native `run` refuses; the late-miss and cold runs change the cache.
fixture() {
  local family="$1" size="$2" dir="$WORK/$1-$2"
  if [[ ! -d "$dir" ]]; then
    make_base "$size"
    case "$family" in
      base) ;;
      warm|late)
        cp -R "$WORK/base-$size" "$dir"
        node_run "$dir" run build
        [[ ! -e "$dir/.vis/runs" ]] || die "the warm fixture grew .vis/runs: the native run gate would delegate."
        ;;
      runs)
        # Two recorded runs of `build`, the second after a change to one package: `cache why` diffs the two.
        cp -R "$WORK/base-$size" "$dir"
        node_run "$dir" run build --summarize
        sleep 1
        printf 'export const value001 = 2;\n' > "$dir/packages/pkg-001/src/index.ts"
        node_run "$dir" run build --summarize
        ;;
      plain)
        # A project that is not a workspace: `npm exec` and `bun x` look up a bin in a workspace root differently.
        mkdir -p "$dir/node_modules/.bin"
        printf '{\n  "name": "bench-plain",\n  "version": "1.0.0"\n}\n' > "$dir/package.json"
        printf '#!/bin/sh\nexit 0\n' > "$dir/node_modules/.bin/noopbin"
        chmod +x "$dir/node_modules/.bin/noopbin"
        ;;
      cold|cmp) cp -R "$WORK/base-$size" "$dir" ;;
      *) die "unknown fixture family $family" ;;
    esac
  fi
  printf '%s\n' "$dir"
}

# hyperfine takes one `--env` per command or none for all, and rejects an empty one: every command gets this harmless
# marker, the binary variant adds the launcher's hand-off variables to it.
# ---- one scenario -----------------------------------------------------------------------------------------------

quoted() { [[ $# -gt 0 ]] && printf '%q ' "$@" | sed 's/ $//'; return 0; }

# Variants are recorded as rows of variants.tsv: variant, status (ok|skipped), label, node (reason it ran in Node, or empty), reason.
# Empty fields are written as `-` (a tab-separated `read` would merge adjacent empty fields).
record() { printf '%s\t%s\t%s\t%s\t%s\n' "$2" "$3" "${4:--}" "${5:--}" "${6:--}" >> "$1/variants.tsv"; }

env_args() { # <env lines>: the lines as separate words, for `env -i`
  ENV_WORDS=()
  local line
  while IFS= read -r line; do [[ -n "$line" ]] && ENV_WORDS+=("$line"); done <<< "$1"
  return 0
}

capture() { # <cap prefix> <cwd> <env lines (newline separated)> -- cmd...
  local out="$1" cwd="$2" envtext="$3"; shift 4
  local envs=() line
  while IFS= read -r line; do [[ -n "$line" ]] && envs+=("--env" "$line"); done <<< "$envtext"
  "${LIB[@]}" run --cwd "$cwd" --out "$out" "${envs[@]}" -- "$@"
}

bench_scenario() {
  local id="$1" family="$2" stubs="$3" handoff="$4" mode="$5" compare="$6" argtext="$7" floortext="$8" size="$9" scenario_label="${10}" cmpfix="${11}" cmpreason="${12}" order="${13}"
  local key="$id" label_size=""
  [[ -n "$size" ]] && { key="$id@$size"; label_size="$size"; }
  local cap="$RESULTS_DIR/cap/$key"
  rm -rf "$cap"; mkdir -p "$cap"
  : > "$cap/variants.tsv"; : > "$cap/comparators.tsv"; : > "$cap/notes.txt"

  local args=()
  eval "args=($argtext)"
  local fam_dir="$family"
  [[ "$mode" == late ]] && fam_dir=late
  [[ "$mode" == cold ]] && fam_dir=cold
  local envtext; envtext="$(base_env "$stubs")"

  # A command the routing table does not hand to the binary has no native variant to time (and may write into the
  # workspace, like `sbom`): it is reported, not run.
  local dir; dir="$(fixture "$fam_dir" "${size:-$DEFAULT_SIZE}")"
  env_args "$envtext"
  local routed
  routed="$("${ROUTES[@]}" route "$("${LIB[@]}" routepayload "$dir" "$argtext" "${ENV_WORDS[@]}")" | tr -d '[] \n')"
  if [[ "$routed" != true && "$mode" != cold ]]; then
    record "$cap" binary skipped - - "not routed to the native binary on this base: the routing table sends it to Node (nothing to compare)"
    record "$cap" launcher skipped - - "same"
    record "$cap" node skipped - - "not run: no native variant to compare with"
    "${LIB[@]}" meta "$cap" "$RESULTS_DIR/$key.meta.json" "$id" "$label_size" "$argtext" "$scenario_label" "$order"
    printf '  %-34s not routed natively on this base (skipped)\n' "$key"
    return 0
  fi
  local sorted_flag=()
  [[ "$compare" == sorted ]] && sorted_flag=(--sorted)

  # The late-miss and cold runs reset the state before every run (timed runs too, through hyperfine --prepare).
  local prepare=""
  if [[ "$mode" == late ]]; then
    prepare="$WORK/prepare-$key.sh"
    local last; last="$(printf '%03d' "${size:-$DEFAULT_SIZE}")"
    # shellcheck disable=SC2016 # the generated script expands these, not this one
    printf '#!/bin/sh\nn=$(cat "%s" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "%s"\nprintf "export const value = %%s;\\n" "$n" > "%s/packages/pkg-%s/src/index.ts"\n' "$WORK/counter-$key" "$WORK/counter-$key" "$dir" "$last" > "$prepare"
    chmod +x "$prepare"
  elif [[ "$mode" == cold ]]; then
    prepare="$WORK/prepare-$key.sh"
    printf '#!/bin/sh\nrm -rf "%s/node_modules/.cache/vis" "%s/.vis"\n' "$dir" "$dir" > "$prepare"
    chmod +x "$prepare"
  fi
  prep() { [[ -n "$prepare" ]] && "$prepare" || true; }

  local before; before="$("${LIB[@]}" signature "$dir")"

  # --- reference: the Node implementation, twice (is its masked output stable?) ---
  prep; capture "$cap/ref" "$dir" "$envtext" -- "$NODE" "$DIST" "${args[@]}"
  prep; capture "$cap/ref2" "$dir" "$envtext" -- "$NODE" "$DIST" "${args[@]}"
  local ref_code; ref_code="$(cat "$cap/ref.code")"
  local stable=1
  if [[ -n "$("${LIB[@]}" compare "$cap/ref" "$cap/ref2" "${sorted_flag[@]+"${sorted_flag[@]}"}")" ]]; then
    stable=0
    echo "node output is not stable between two runs after masking: only exit code and delegation are checked" >> "$cap/notes.txt"
  fi
  if [[ "$ref_code" != 0 ]]; then
    echo "the Node implementation exits $ref_code here: $(head -c 160 "$cap/ref.err" | tr '\n\t' '  ')" >> "$cap/notes.txt"
  fi
  if [[ "$ref_code" == 124 || "$ref_code" == 127 ]]; then
    record "$cap" node skipped "" "" "Node reference failed to run (exit $ref_code)"
    record "$cap" binary skipped "" "" "no Node reference"
    record "$cap" launcher skipped "" "" "no Node reference"
    return 0
  fi

  check_output() { # <got prefix>: prints a reason when the run disagrees with Node
    if [[ "$compare" == exit ]]; then
      local different; different="$("${LIB[@]}" compare "$cap/ref" "$1")"
      [[ -n "$different" ]] && echo "$id: output differs from Node by design ($cmpreason): $different" >> "$cap/notes.txt"
      [[ "$(cat "$cap/ref.code")" == "$(cat "$1.code")" ]] || echo "exit code $(cat "$1.code"), Node exits $(cat "$cap/ref.code")"
    elif [[ $stable -eq 1 ]]; then
      "${LIB[@]}" compare "$cap/ref" "$1" "${sorted_flag[@]+"${sorted_flag[@]}"}"
    elif [[ "$(cat "$cap/ref.code")" != "$(cat "$1.code")" ]]; then
      echo "exit code $(cat "$1.code"), Node exits $(cat "$cap/ref.code")"
    fi
  }


  # --- native binary ---
  local binary_env="$envtext"$'\n'"VIS_FALLBACK_ENTRY_OVERRIDE=$STUB_ENTRY"
  local extra_bin_env=()
  local binary_label="binary" bin_ok=0 bin_reason=""
  if [[ "$handoff" == 1 ]]; then
    local h; for h in "${HANDOFF_ENV[@]}"; do binary_env+=$'\n'"$h"; extra_bin_env+=("$h"); done
    binary_label="binary + hand-off env"
  fi
  if [[ "$mode" == cold ]]; then
    bin_reason="the launcher never starts the binary without a task cache (no process to compare); the bare binary hands the run back to Node"
  elif [[ "$routed" != true ]]; then
    bin_reason="the routing table sends this invocation to Node on this base (route.mjs)"
  else
    prep; capture "$cap/bin" "$dir" "$binary_env" -- "$BIN" "${args[@]}"
    if [[ "$mode" == late ]]; then
      if [[ "$(cat "$cap/bin.code")" == 75 && ! -s "$cap/bin.out" && ! -s "$cap/bin.err" ]]; then
        bin_ok=1; binary_label="binary (native attempt, hand-back only)"
      else
        bin_reason="expected a silent hand-back (exit 75), got exit $(cat "$cap/bin.code")"
      fi
    elif "${LIB[@]}" delegated "$cap/bin"; then
      bin_reason="the binary delegates this invocation to Node (a silent delegation: it would time as Node)"
    else
      bin_reason="$(check_output "$cap/bin")"
      [[ -z "$bin_reason" ]] && bin_ok=1
    fi
  fi
  if [[ $bin_ok -eq 1 ]]; then
    record "$cap" binary ok "$binary_label" "" ""
  else
    record "$cap" binary skipped "" "" "$bin_reason"
  fi

  # A bare binary hands `run` to Node unless the launcher's hand-off is in the environment.
  if [[ "$handoff" == 1 && -z "$mode" ]]; then
    capture "$cap/bare" "$dir" "$envtext"$'\n'"VIS_FALLBACK_ENTRY_OVERRIDE=$STUB_ENTRY" -- "$BIN" "${args[@]}"
    if "${LIB[@]}" delegated "$cap/bare"; then
      echo "the binary started without the launcher's hand-off hands this to Node: only a run through bin/vis.mjs answers it natively" >> "$cap/notes.txt"
    else
      echo "the binary also answers this without the launcher's hand-off" >> "$cap/notes.txt"
    fi
  fi

  # --- launcher ---
  local launcher_ok=0 launcher_node="" launcher_reason=""
  if [[ -n "$mode" ]]; then
    # A miss goes: native attempt, hand-back, Node. Validate against the real entry; the stub would only show the hand-back.
    prep; capture "$cap/launcher" "$dir" "$envtext" -- "$NODE" "$LAUNCHER" "${args[@]}"
    launcher_reason="$(check_output "$cap/launcher")"
    [[ -z "$launcher_reason" ]] && launcher_ok=1
    [[ "$mode" == cold ]] && echo "cold run: no task cache directory, so the launcher skips the binary and the run is Node's from the start" >> "$cap/notes.txt"
    [[ "$mode" == late ]] && echo "late miss: the binary keys and looks up every task, the last one misses, the run goes to Node: launcher minus node is the cost of the failed native attempt" >> "$cap/notes.txt"
  else
    prep; capture "$cap/launcher" "$dir" "$envtext"$'\n'"VIS_FALLBACK_ENTRY_OVERRIDE=$STUB_ENTRY" -- "$NODE" "$LAUNCHER" "${args[@]}"
    if "${LIB[@]}" delegated "$cap/launcher"; then
      if [[ "$routed" != true ]]; then launcher_node="the routing table sends it to Node"; else launcher_node="the binary delegates it to Node"; fi
      launcher_ok=1
    else
      launcher_reason="$(check_output "$cap/launcher")"
      [[ -z "$launcher_reason" ]] && launcher_ok=1
    fi
  fi
  if [[ $launcher_ok -eq 1 ]]; then record "$cap" launcher ok launcher "${launcher_node:--}" ""; else record "$cap" launcher skipped "" "" "$launcher_reason"; fi
  record "$cap" node ok node "" ""

  # --- stand-in package manager, run directly: the floor of a passthrough command ---
  local floor_cmd=()
  if [[ "$floortext" != "-" ]]; then
    eval "floor_cmd=($floortext)"
    floor_cmd[0]="$STUBS/${floor_cmd[0]}"
    capture "$cap/floor" "$dir" "$envtext" -- "${floor_cmd[@]}"
    if [[ "$(cat "$cap/floor.code")" == 0 ]]; then record "$cap" floor ok "stub package manager" "" ""; else record "$cap" floor skipped "" "" "stub exits $(cat "$cap/floor.code")"; fi
  fi

  # --- timing ---
  local ok_count; ok_count="$(grep -c $'\tok\t' "$cap/variants.tsv" || true)"
  local hf=("$HF" -N --warmup "$WARMUP" --runs "$RUNS" --style basic --metrics "time_wall_clock,memory_peak_resident" --export-json "$RESULTS_DIR/$key.json")
  [[ -n "$prepare" ]] && hf+=(--prepare "$prepare")
  [[ "$ref_code" != 0 || "$mode" == late ]] && hf+=(-i)
  local variant status label
  while IFS=$'\t' read -r variant status label _; do
    [[ "$status" == ok ]] || continue
    case "$variant" in
      binary)   hf+=(--env "VIS_BENCH_RUN=1 $(quoted "${extra_bin_env[@]+"${extra_bin_env[@]}"}")" --command-name "$label" "$(quoted "$BIN" "${args[@]}")") ;;
      launcher) hf+=(--env VIS_BENCH_RUN=1 --command-name "$label" "$(quoted "$NODE" "$LAUNCHER" "${args[@]}")") ;;
      node)     hf+=(--env VIS_BENCH_RUN=1 --command-name "$label" "$(quoted "$NODE" "$DIST" "${args[@]}")") ;;
      floor)    hf+=(--env VIS_BENCH_RUN=1 --command-name "$label" "$(quoted "${floor_cmd[@]}")") ;;
    esac
  done < "$cap/variants.tsv"
  if [[ "$ok_count" -gt 0 ]]; then
    env_args "$envtext"
    if ! (cd "$dir" && env -i "${ENV_WORDS[@]}" "${hf[@]}") > "$RESULTS_DIR/log/$key.log" 2>&1; then
      tail -20 "$RESULTS_DIR/log/$key.log" >&2
      die "hyperfine failed for $key"
    fi
  fi

  # --- validate again after timing: state that drifted while timing would make the numbers meaningless ---
  if [[ -z "$mode" ]]; then
    if [[ $bin_ok -eq 1 ]]; then
      capture "$cap/bin-after" "$dir" "$binary_env" -- "$BIN" "${args[@]}"
      if "${LIB[@]}" delegated "$cap/bin-after" || [[ -n "$(check_output "$cap/bin-after")" ]]; then
        echo "the binary answered differently (or delegated) after the timing: the state changed while timing" >> "$cap/notes.txt"
      fi
    fi
    local after; after="$("${LIB[@]}" signature "$dir")"
    # `run` and the cache commands write their own summary files; anywhere else a change is worth a note.
    [[ "$family" != base || "$before" == "$after" ]] || echo "the command changes files in the fixture (state is not identical before and after)" >> "$cap/notes.txt"
  fi

  # --- comparators: real tools, own copy of the fixture, real PATH ---
  if [[ $NO_COMPARATORS -eq 0 ]]; then
    run_comparators "$id" "$key" "$cap" "${size:-$DEFAULT_SIZE}" "$cmpfix"
  fi

  "${LIB[@]}" meta "$cap" "$RESULTS_DIR/$key.meta.json" "$id" "$label_size" "$argtext" "$scenario_label" "$order"
  printf '  %-34s ' "$key"
  awk -F'\t' '{ printf "%s=%s ", $1, ($2 == "ok" ? (($4 != "-") ? "ok(Node)" : "ok") : "skipped") }' "$cap/variants.tsv"
  echo
}

run_comparators() { # <id> <key> <cap> <size> <comparator fixture>
  local id="$1" key="$2" cap="$3" size="$4" cmpfix="$5"
  local rows; rows="$("${LIB[@]}" comparators "$CASES" "$id")"
  [[ -z "$rows" ]] && return 0
  local dir
  if [[ "$cmpfix" == plain ]]; then dir="$(fixture plain 1)"; else dir="$(fixture cmp "$size")"; fi
  local real_env; real_env="$(printf '%s\n' "PATH=$REAL_PATH" "HOME=$HOME" "TMPDIR=$TMP_FOR_ENV" "CI=1" "COLUMNS=80")"
  local hf=("$HF" -N --warmup "$WARMUP" --runs "$CMP_RUNS" --style basic --metrics "time_wall_clock,memory_peak_resident" --export-json "$RESULTS_DIR/$key.cmp.json")
  local name argtext argv tool resolved index=0 count=0
  while IFS=$'\t' read -r name argtext; do
    [[ -z "$name" ]] && continue
    eval "argv=($argtext)"
    tool="${argv[0]}"
    if [[ "$tool" == node ]]; then
      resolved="$NODE"
    else
      resolved="$(PATH="$REAL_PATH" command -v "$tool" || true)"
    fi
    if [[ -z "$resolved" ]]; then
      printf '%s\tskipped\t\t%s\n' "$name" "$tool is not installed" >> "$cap/comparators.tsv"
      continue
    fi
    argv[0]="$resolved"
    index=$((index + 1))
    capture "$cap/cmp-$index" "$dir" "$real_env" -- "${argv[@]}"
    if [[ "$(cat "$cap/cmp-$index.code")" != 0 ]]; then
      printf '%s\tskipped\t\t%s\n' "$name" "exits $(cat "$cap/cmp-$index.code"): $(head -c 120 "$cap/cmp-$index.err" | tr '\n\t' '  ')" >> "$cap/comparators.tsv"
      continue
    fi
    printf '%s\tok\t%s\t\n' "$name" "$name" >> "$cap/comparators.tsv"
    hf+=(--command-name "$name" "$(quoted "${argv[@]}")")
    count=$((count + 1))
  done <<< "$rows"
  if [[ $count -gt 0 ]]; then
    env_args "$real_env"
    if ! (cd "$dir" && env -i "${ENV_WORDS[@]}" "${hf[@]}") > "$RESULTS_DIR/log/$key.cmp.log" 2>&1; then
      tail -20 "$RESULTS_DIR/log/$key.cmp.log" >&2
      die "hyperfine failed for the comparators of $key"
    fi
  fi
}

# ---- run every scenario -----------------------------------------------------------------------------------------

echo ""
echo "  validated and timed (binary / launcher / node; Node = answered by Node):"
ran=0
order=0
while IFS=$'\t' read -r id family scales stubs handoff mode compare _ argtext floortext label cmpfix cmpreason; do
  order=$((order + 1))
  [[ -n "$ONLY" ]] && ! [[ "$id" =~ $ONLY ]] && continue
  [[ "$mode" == "-" ]] && mode=""
  if [[ "$scales" == 1 ]]; then
    IFS=, read -r -a size_list <<< "$SIZES"
  else
    size_list=("")
  fi
  for size in "${size_list[@]}"; do
    if [[ "$mode" == late && "${size:-0}" -lt 2 ]]; then
      echo "  $id@$size: skipped (one package: its only task is the miss)"
      continue
    fi
    bench_scenario "$id" "$family" "$stubs" "$handoff" "$mode" "$compare" "$argtext" "$floortext" "$size" "$label" "$cmpfix" "$cmpreason" "$order"
    ran=$((ran + 1))
  done
done < <("${LIB[@]}" cases "$CASES")
[[ $ran -gt 0 ]] || die "no scenario matched --only '$ONLY'."

LOAD_END="$(uptime | sed -E 's/.*load averages?: *//' | awk '{gsub(",", ".", $1); print $1}')"
if awk -v load="$LOAD_END" -v cores="$CORES" 'BEGIN { exit !(load > cores) }'; then
  echo "  WARNING: the 1-minute load average is $LOAD_END at the end of the run (above the $CORES cores): other work ran while timing, treat these numbers and any budget check with care."
fi
"${LIB[@]}" runinfo "$RESULTS_DIR/run.json" "environment=$ENVIRONMENT" "load=$LOAD" "cores=$CORES" "uncovered=$UNCOVERED"
echo "  [results saved → $RESULTS_DIR]"

SUMMARY_ARGS=("$RESULTS_DIR")
[[ -n "$MARKDOWN" ]] && SUMMARY_ARGS+=(--markdown "$MARKDOWN")
"${LIB[@]}" summary "${SUMMARY_ARGS[@]}"

[[ -n "$WRITE_BUDGETS" ]] && "${LIB[@]}" budgets "$RESULTS_DIR" --write "$WRITE_BUDGETS"
if [[ -n "$CHECK_BUDGETS" ]]; then
  "${LIB[@]}" budgets "$RESULTS_DIR" --check "$CHECK_BUDGETS"
fi
