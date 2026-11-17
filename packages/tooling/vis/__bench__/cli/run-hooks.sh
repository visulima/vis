#!/usr/bin/env bash
# Git-hook benchmark — vis vs hk / prek / lefthook / pre-commit.
#
# Every scenario stages the same 60 clean files and times one `pre-commit` run.
# Two modes are measured:
#
#   run        the tool's own command (`hk run pre-commit`, `prek run`, …)
#   installed  `git hook run pre-commit` after each tool's own `install`, i.e.
#              the whole chain a real `git commit` pays (git → hook shim →
#              tool). This is the number users actually feel.
#
# Scenarios:
#   A  one hook over all 60 files                      (orchestration overhead)
#   B  four hooks filtered by extension (ts/json/md/yaml)
#   C  four built-in text-hygiene hooks                 (lefthook has none: skipped)
#
# A, B use a no-op payload script so the numbers isolate orchestration, not the
# linter. Before timing, every tool is validated: exit 0, the payload received
# all 60 files (A, B), and (C) a staged trailing-whitespace file makes it fail.
# A tool that silently matches zero files would otherwise look "fastest".
#
# Requires: hyperfine, git >= 2.36, node, the tools to compare (missing ones are
# skipped). Build vis first: `pnpm run build && pnpm run build:native:cli`.
#
#   bash __bench__/cli/run-hooks.sh                       # everything
#   bash __bench__/cli/run-hooks.sh --scenarios A,B --modes installed --runs 30
#   VIS_PKG=/path/to/@visulima/vis bash __bench__/cli/run-hooks.sh
#   bash __bench__/cli/run-hooks.sh --expect-native       # fail unless vis took the native path
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VIS_PKG="${VIS_PKG:-$PKG_ROOT}"
RESULTS_DIR="$PKG_ROOT/__bench__/cli/results"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

WARMUP=5
RUNS=40
SCENARIOS="A,B,C"
MODES="run,installed"
EXPECT_NATIVE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --warmup)        WARMUP="$2"; shift 2 ;;
    --runs)          RUNS="$2"; shift 2 ;;
    --scenarios)     SCENARIOS="$2"; shift 2 ;;
    --modes)         MODES="$2"; shift 2 ;;
    --expect-native) EXPECT_NATIVE=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

have() { command -v "$1" &>/dev/null; }
have hyperfine || { echo "ERROR: hyperfine not found (brew install hyperfine)." >&2; exit 1; }
have git || { echo "ERROR: git not found." >&2; exit 1; }
[[ -f "$VIS_PKG/bin/vis.mjs" && -f "$VIS_PKG/dist/bin.js" ]] || { echo "ERROR: vis not built at $VIS_PKG (need bin/vis.mjs and dist/bin.js)." >&2; exit 1; }

TOOLS=(vis)
for t in hk prek lefthook pre-commit; do have "$t" && TOOLS+=("$t") || echo "note: $t not installed, skipping" >&2; done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vis-hooks-bench-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$RESULTS_DIR"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
write_payload() {
  cat > payload.sh <<'P'
#!/bin/sh
[ -n "$HB_LOG" ] && echo "$#" >> "$HB_LOG"
exit 0
P
  chmod +x payload.sh
}

# base_repo <dir>: 60 modified + staged, clean files (no trailing whitespace, final newline).
base_repo() {
  local d="$1"; mkdir -p "$d"; (
    cd "$d"
    git init -q . && git config user.email bench@example.com && git config user.name bench && git config commit.gpgsign false
    mkdir -p src docs cfg data
    for i in $(seq 1 30); do printf 'export const v%s = %s;\n' "$i" "$i" > "src/m$i.ts"; done
    for i in $(seq 1 10); do printf '{ "id": %s }\n' "$i" > "data/d$i.json"; done
    for i in $(seq 1 10); do printf '# Doc %s\n\nBody.\n' "$i" > "docs/n$i.md"; done
    for i in $(seq 1 10); do printf 'key: %s\n' "$i" > "cfg/c$i.yaml"; done
    write_payload
    git add -A && git commit -q -m base --no-verify
    for i in $(seq 1 30); do printf 'export const v%s = %s;\nexport const w%s = 1;\n' "$i" "$i" "$i" > "src/m$i.ts"; done
    for i in $(seq 1 10); do printf '{ "id": %s, "x": 1 }\n' "$i" > "data/d$i.json"; done
    for i in $(seq 1 10); do printf '# Doc %s\n\nBody two.\n' "$i" > "docs/n$i.md"; done
    for i in $(seq 1 10); do printf 'key: %s\nx: 1\n' "$i" > "cfg/c$i.yaml"; done
    git add -A
    [[ "$(git diff --cached --name-only | wc -l | tr -d ' ')" == 60 ]]
  )
}

# write_config <scenario> <dir>: every tool's config for the scenario, side by side.
write_config() {
  local s="$1" d="$2"; (
    cd "$d"
    mkdir -p .vis/hooks
    printf '#!/usr/bin/env sh\nexec vis hook run pre-commit "$@"\n' > .vis/hooks/pre-commit; chmod +x .vis/hooks/pre-commit
    case "$s" in
      A)
        echo '{"version":1,"stages":{"pre-commit":[{"id":"noop","entry":"./payload.sh"}]}}' > .vis/hooks/config.json
        cat > .pre-commit-config.yaml <<'Y'
repos:
  - repo: local
    hooks:
      - {id: noop, name: noop, entry: ./payload.sh, language: system}
Y
        cat > lefthook.yml <<'Y'
pre-commit:
  commands:
    noop:
      run: ./payload.sh {staged_files}
Y
        cat > hk.pkl <<'Y'
amends "package://github.com/jdx/hk/releases/download/v2.12.0/hk@2.12.0#/Config.pkl"
hooks { ["pre-commit"] { steps { ["noop"] { glob = "**/*"  check = "./payload.sh {{ files }}" } } } }
Y
        ;;
      B)
        cat > .vis/hooks/config.json <<'J'
{"version":1,"stages":{"pre-commit":[
 {"id":"ts","entry":"./payload.sh","files":"\\.ts$"},
 {"id":"json","entry":"./payload.sh","files":"\\.json$"},
 {"id":"md","entry":"./payload.sh","files":"\\.md$"},
 {"id":"yaml","entry":"./payload.sh","files":"\\.yaml$"}]}}
J
        cat > .pre-commit-config.yaml <<'Y'
repos:
  - repo: local
    hooks:
      - {id: ts,   name: ts,   entry: ./payload.sh, language: system, files: '\.ts$'}
      - {id: json, name: json, entry: ./payload.sh, language: system, files: '\.json$'}
      - {id: md,   name: md,   entry: ./payload.sh, language: system, files: '\.md$'}
      - {id: yaml, name: yaml, entry: ./payload.sh, language: system, files: '\.yaml$'}
Y
        cat > lefthook.yml <<'Y'
pre-commit:
  commands:
    ts:
      glob: "*.ts"
      run: ./payload.sh {staged_files}
    json:
      glob: "*.json"
      run: ./payload.sh {staged_files}
    md:
      glob: "*.md"
      run: ./payload.sh {staged_files}
    yaml:
      glob: "*.yaml"
      run: ./payload.sh {staged_files}
Y
        cat > hk.pkl <<'Y'
amends "package://github.com/jdx/hk/releases/download/v2.12.0/hk@2.12.0#/Config.pkl"
hooks { ["pre-commit"] { steps {
  ["ts"]   { glob = "**/*.ts"   check = "./payload.sh {{ files }}" }
  ["json"] { glob = "**/*.json" check = "./payload.sh {{ files }}" }
  ["md"]   { glob = "**/*.md"   check = "./payload.sh {{ files }}" }
  ["yaml"] { glob = "**/*.yaml" check = "./payload.sh {{ files }}" }
} } }
Y
        ;;
      C)
        cat > .vis/hooks/config.json <<'J'
{"version":1,"stages":{"pre-commit":[
 {"id":"trailing-whitespace","builtin":"trailing-whitespace"},
 {"id":"end-of-file-fixer","builtin":"end-of-file-fixer"},
 {"id":"check-merge-conflict","builtin":"check-merge-conflict"},
 {"id":"mixed-line-ending","builtin":"mixed-line-ending"}]}}
J
        cat > prek-builtin.yaml <<'Y'
repos:
  - repo: builtin
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-merge-conflict
      - id: mixed-line-ending
Y
        cat > precommit-hooks.yaml <<'Y'
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v6.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-merge-conflict
      - id: mixed-line-ending
Y
        cat > hk.pkl <<'Y'
amends "package://github.com/jdx/hk/releases/download/v2.12.0/hk@2.12.0#/Config.pkl"
import "package://github.com/jdx/hk/releases/download/v2.12.0/hk@2.12.0#/Builtins.pkl"
hooks { ["pre-commit"] { steps {
  ["trailing_whitespace"] = Builtins.trailing_whitespace
  ["newlines"] = Builtins.newlines
  ["check_merge_conflict"] = Builtins.check_merge_conflict
  ["mixed_line_ending"] = Builtins.mixed_line_ending
} } }
Y
        ;;
    esac
  )
}

# Per-tool config file flags (scenario C keeps prek / pre-commit configs apart).
cfg_flag() { # tool scenario
  case "$1:$2" in
    prek:C) echo "-c prek-builtin.yaml" ;;
    pre-commit:C) echo "-c precommit-hooks.yaml" ;;
  esac
}

# The vis dev package, laid out the way a project installs it, so the generated
# dispatcher resolves `vis` (and the native binary) exactly as in a real repo.
link_vis() { # dir
  mkdir -p "$1/node_modules/.bin" "$1/node_modules/@visulima"
  ln -sfn "$VIS_PKG" "$1/node_modules/@visulima/vis"
  ln -sfn ../@visulima/vis/bin/vis.mjs "$1/node_modules/.bin/vis"
  grep -q node_modules "$1/.git/info/exclude" 2>/dev/null || echo node_modules >> "$1/.git/info/exclude"
}

# install_tool <tool> <scenario> <dir>: the tool's own `install`, run inside dir.
install_tool() {
  local tool="$1" s="$2" d="$3" flag; flag="$(cfg_flag "$tool" "$s")"
  (
    cd "$d"
    case "$tool" in
      vis)        # a leftover pre-commit config makes `vis hook install` offer a migration prompt
                  rm -f .pre-commit-config.yaml prek.toml; link_vis "$d"; PATH="$d/node_modules/.bin:$PATH" node "$VIS_PKG/bin/vis.mjs" hook install </dev/null >/dev/null ;;
      hk)         hk install >/dev/null 2>&1 ;;
      prek)       prek install $flag >/dev/null 2>&1 ;;
      lefthook)   lefthook install >/dev/null 2>&1 ;;
      pre-commit) pre-commit install $flag >/dev/null 2>&1 ;;
    esac
  )
}

# ---------------------------------------------------------------------------
# Validation — a fast tool that matched nothing is not fast.
# ---------------------------------------------------------------------------
FAILED=0
fail() { echo "  INVALID: $*" >&2; FAILED=1; }

# validate <label> <scenario> <dir> <cmd...>
validate() {
  local label="$1" s="$2" d="$3"; shift 3
  local log="$WORK/hb.log" err="$WORK/hb.err" rc=0
  rm -f "$log"
  (cd "$d" && HB_LOG="$log" VIS_HOOK_TRACE=1 "$@" </dev/null >/dev/null 2>"$err") || rc=$?
  if [[ $rc -ne 0 ]]; then fail "$label exited $rc (stderr: $(head -c 300 "$err"))"; return; fi
  if [[ "$s" != C ]]; then
    local total; total=$(awk '{ n += $1 } END { print n + 0 }' "$log" 2>/dev/null || echo 0)
    [[ "$total" == 60 ]] || fail "$label: payload saw $total files, expected 60"
  fi
  if [[ "$label" == vis* && $EXPECT_NATIVE -eq 1 ]]; then
    grep -q 'vis\[native\]' "$err" || fail "$label: did not take the native path (--expect-native)"
  fi
  if [[ "$s" == C ]]; then
    # negative control: a staged trailing-whitespace file must make the tool fail
    local neg="$WORK/neg"; rm -rf "$neg"; cp -R "$d" "$neg"
    (cd "$neg" && printf 'export const bad = 1;   \n' > src/m7.ts && git add src/m7.ts)
    if (cd "$neg" && "${@//$d/$neg}" >/dev/null 2>&1); then fail "$label: passed a file with trailing whitespace"; fi
    rm -rf "$neg"
  fi
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
VIS_NATIVE=""; [[ -x "$VIS_PKG/vis-native-cli" ]] && VIS_NATIVE="$VIS_PKG/vis-native-cli"

run_hyperfine() { # out cmd-args...
  local out="$1"; shift
  hyperfine -N --warmup "$WARMUP" --runs "$RUNS" --export-json "$out" --export-markdown "${out%.json}.md" "$@" 2>&1 | grep -E "^Benchmark|Wall Time|Time \(mean" | paste - - | sed -E 's/ +/ /g'
}

IFS=, read -r -a SCEN <<< "$SCENARIOS"
for s in "${SCEN[@]}"; do
  base="$WORK/base-$s"; base_repo "$base"; write_config "$s" "$base"

  if [[ ",$MODES," == *,run,* ]]; then
    echo "== scenario $s · run"
    d="$WORK/run-$s"; cp -R "$base" "$d"; link_vis "$d"
    args=(); names=()
    add() { names+=("$1"); args+=(-n "$1" "$2"); }
    for t in "${TOOLS[@]}"; do
      [[ "$s" == C && "$t" == lefthook ]] && continue
      flag="$(cfg_flag "$t" "$s")"
      case "$t" in
        vis)
          add "vis (launcher)" "node $VIS_PKG/bin/vis.mjs hook run pre-commit"
          [[ -n "$VIS_NATIVE" ]] && add "vis (native)" "env VIS_FALLBACK_ENTRY=$VIS_PKG/dist/bin.js $VIS_NATIVE hook run pre-commit" ;;
        hk)         add hk "hk run pre-commit" ;;
        prek)       add prek "prek run $flag" ;;
        lefthook)   add lefthook "lefthook run pre-commit" ;;
        pre-commit) add pre-commit "pre-commit run $flag" ;;
      esac
    done
    # validate each command once, in the fixture, before timing
    i=0; while [[ $i -lt ${#args[@]} ]]; do
      label="${args[$i+1]}"; cmd="${args[$i+2]}"; i=$((i+3))
      # shellcheck disable=SC2086
      validate "$label" "$s" "$d" $cmd
    done
    (( FAILED )) && { echo "validation failed — not timing scenario $s/run" >&2; exit 1; }
    ( cd "$d" && run_hyperfine "$RESULTS_DIR/hooks-$TIMESTAMP-$s-run.json" "${args[@]}" )
  fi

  if [[ ",$MODES," == *,installed,* ]]; then
    echo "== scenario $s · installed (git hook run pre-commit)"
    args=()
    for t in "${TOOLS[@]}"; do
      [[ "$s" == C && "$t" == lefthook ]] && continue
      d="$WORK/inst-$s-$t"; cp -R "$base" "$d"; install_tool "$t" "$s" "$d"
      validate "$t (installed)" "$s" "$d" git -C "$d" hook run pre-commit
      args+=(-n "$t" "git -C $d hook run pre-commit")
    done
    (( FAILED )) && { echo "validation failed — not timing scenario $s/installed" >&2; exit 1; }
    run_hyperfine "$RESULTS_DIR/hooks-$TIMESTAMP-$s-installed.json" "${args[@]}"
  fi
done

echo
echo "Results (hyperfine JSON + Markdown tables): $RESULTS_DIR/hooks-$TIMESTAMP-*.{json,md}"
