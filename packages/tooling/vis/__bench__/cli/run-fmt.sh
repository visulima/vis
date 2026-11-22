#!/usr/bin/env bash
# Formatter benchmark: `vis fmt` vs the oxfmt it bundles vs `bun fmt`.
#
# Every tool formats the same generated tree with the same `.oxfmtrc.json`, in check mode (nothing is
# written, so runs are repeatable). Two trees per size: `clean` (already formatted, exit 0) and
# `dirty` (every 10th file has leading blank lines, exit 1).
#
#   vis     `vis fmt --check`          the Node CLI: launcher, config resolution, then a child oxfmt
#   oxfmt   `oxfmt --check`            the bundled oxfmt run directly, i.e. the floor `vis fmt` adds to
#   bun     `bun fmt --check`          Bun's built-in formatter (skipped when bun is not installed)
#
# Before timing, each tool is validated on each tree: exit 0 on `clean`, exit 1 on `dirty`, and on
# `dirty` it must report exactly the files that were made dirty. A tool that disagrees is skipped for
# that tree with the reason printed, so a tool that quietly formats nothing cannot look fastest.
#
# Requires: hyperfine, node, python3, a built vis (`pnpm run build`). Optional: bun.
#
#   bash __bench__/cli/run-fmt.sh                         # sizes 1, 60 and 600 files
#   bash __bench__/cli/run-fmt.sh --sizes 600 --runs 30
#   VIS_PKG=/path/to/@visulima/vis bash __bench__/cli/run-fmt.sh
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VIS_PKG="${VIS_PKG:-$PKG_ROOT}"
RESULTS_DIR="$PKG_ROOT/__bench__/cli/results"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

WARMUP=3
RUNS=20
SIZES="1,60,600"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --warmup) WARMUP="$2"; shift 2 ;;
    --runs)   RUNS="$2"; shift 2 ;;
    --sizes)  SIZES="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

have() { command -v "$1" &>/dev/null; }
have hyperfine || { echo "ERROR: hyperfine not found (brew install hyperfine)." >&2; exit 1; }
have node || { echo "ERROR: node not found." >&2; exit 1; }
have python3 || { echo "ERROR: python3 not found." >&2; exit 1; }
[[ -f "$VIS_PKG/bin/vis.mjs" && -f "$VIS_PKG/dist/bin.js" ]] || { echo "ERROR: vis not built at $VIS_PKG (need bin/vis.mjs and dist/bin.js)." >&2; exit 1; }

OXFMT_BIN="$(cd "$VIS_PKG" && node -e 'const p=require.resolve("oxfmt/package.json");const {bin}=require(p);console.log(require("path").join(require("path").dirname(p),typeof bin==="string"?bin:bin.oxfmt))')"
[[ -f "$OXFMT_BIN" ]] || { echo "ERROR: the bundled oxfmt was not found from $VIS_PKG." >&2; exit 1; }

TOOLS=(vis oxfmt)
if have bun; then TOOLS+=(bun); else echo "note: bun not installed, skipping" >&2; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vis-fmt-bench-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$RESULTS_DIR"

# tool_command <tool>: the check command, run from the tree's root.
tool_command() {
  case "$1" in
    vis)   echo "node $VIS_PKG/bin/vis.mjs fmt --check" ;;
    oxfmt) echo "node $OXFMT_BIN --list-different --no-error-on-unmatched-pattern ." ;;
    bun)   echo "bun fmt --check --no-script ." ;;
  esac
}

# make_tree <dir> <files> <dirty: 0|1>: a project of <files> source files in six languages. With dirty=1 every
# 10th file gets leading blank lines (reformatting removes them) and its path is listed in <dir>/.dirty.
make_tree() {
  python3 -I - "$1" "$2" "$3" <<'PY'
import os, sys

root, count, dirty = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1"

TS = """import { readFile } from "node:fs/promises";

export interface Item{n}Options {
    name: string;
    retries?: number;
}

export class Item{n} {
    #options: Item{n}Options;

    constructor(options: Item{n}Options) {
        this.#options = options;
    }

    async load(path: string): Promise<string> {
        for (let attempt = 0; attempt < (this.#options.retries ?? 3); attempt += 1) {
            try {
                return await readFile(path, "utf8");
            } catch (error) {
                if (attempt === 2) {
                    throw error;
                }
            }
        }

        return "";
    }
}

export const make{n} = (name: string): Item{n} => new Item{n}({ name, retries: {n} });
"""
CSS = """.card-{n} {
    display: grid;
    gap: 8px;
    padding: 16px;
}

.card-{n} > .title {
    font-size: 1.25rem;
    line-height: 1.4;
}

@media (min-width: 640px) {
    .card-{n} {
        grid-template-columns: repeat(2, 1fr);
    }
}
"""
MD = """# Document {n}

A paragraph with `code`, a [link](https://example.com/{n}) and some more text to make the file a realistic size.

- first item
- second item
- third item

```ts
export const value{n} = {n};
```
"""
JSON_ = """{
    "id": {n},
    "name": "item-{n}",
    "tags": ["a", "b", "c"],
    "nested": {
        "enabled": true,
        "limit": {n}
    }
}
"""
YAML = """name: item-{n}
enabled: true
steps:
    - run: build
    - run: test
env:
    LEVEL: {n}
"""
TSX = """export const Button{n} = ({ label }: { label: string }) => {
    return (
        <button className="btn btn-{n}" type="button">
            {label}
        </button>
    );
};
"""
KINDS = [("src", "ts", TS), ("styles", "css", CSS), ("docs", "md", MD), ("data", "json", JSON_), ("cfg", "yaml", YAML), ("ui", "tsx", TSX)]

os.makedirs(root, exist_ok=True)
dirty_files = []

for i in range(count):
    directory, extension, template = KINDS[i % len(KINDS)]
    folder = os.path.join(root, directory, f"g{i // 60}")
    os.makedirs(folder, exist_ok=True)
    relative = os.path.join(directory, f"g{i // 60}", f"f{i}.{extension}")
    body = template.replace("{n}", str(i))
    if dirty and i % 10 == 0:
        body = "\n\n" + body
        dirty_files.append(relative)
    with open(os.path.join(root, relative), "w") as handle:
        handle.write(body)

with open(os.path.join(root, ".dirty"), "w") as handle:
    handle.write("\n".join(sorted(dirty_files)) + ("\n" if dirty_files else ""))
PY
  printf '{ "name": "fmt-bench", "private": true }\n' > "$1/package.json"
  printf '{\n    "printWidth": 100,\n    "tabWidth": 4\n}\n' > "$1/.oxfmtrc.json"
}

# Canonical form for the clean tree: let the bundled oxfmt write it, then require a clean check.
canonicalise() {
  (cd "$1" && node "$OXFMT_BIN" --write --no-error-on-unmatched-pattern . >/dev/null 2>&1 || true)
}

# validate <tool> <tree> <expect: clean|dirty>: echoes nothing when the tool behaves, else the reason.
validate() {
  local tool="$1" tree="$2" expect="$3" out status
  set +e
  out="$(cd "$tree" && eval "$(tool_command "$tool")" 2>&1)"
  status=$?
  set -e
  if [[ "$expect" == clean ]]; then
    [[ $status -eq 0 ]] || { echo "exit $status on the clean tree (expected 0)"; return; }
  else
    [[ $status -eq 1 ]] || { echo "exit $status on the dirty tree (expected 1)"; return; }
    local expected found
    expected="$(grep -c . "$tree/.dirty" || true)"
    found=0
    while IFS= read -r file; do
      [[ -n "$file" ]] && grep -qF "$file" <<<"$out" && found=$((found + 1))
    done < "$tree/.dirty"
    [[ "$found" -eq "$expected" ]] || { echo "reported $found of $expected dirty files"; return; }
  fi
}

SUMMARY="$WORK/summary.tsv"
: > "$SUMMARY"

for size in ${SIZES//,/ }; do
  for state in clean dirty; do
    tree="$WORK/tree-$size-$state"
    make_tree "$tree" "$size" "$([[ $state == dirty ]] && echo 1 || echo 0)"
    # The dirty tree is the canonical tree with some files made dirty, so canonicalise a clean copy first.
    if [[ $state == dirty ]]; then
      clean_copy="$WORK/canon-$size"
      make_tree "$clean_copy" "$size" 0
      canonicalise "$clean_copy"
      # Re-apply the dirtying on top of the canonical content.
      python3 -I - "$tree" "$clean_copy" <<'PY'
import os, shutil, sys

tree, canon = sys.argv[1], sys.argv[2]
dirty = [line for line in open(os.path.join(tree, ".dirty")).read().splitlines() if line]
for name in os.listdir(tree):
    if name != ".dirty":
        target = os.path.join(tree, name)
        shutil.rmtree(target) if os.path.isdir(target) else os.remove(target)
for name in os.listdir(canon):
    if name != ".dirty":
        source, target = os.path.join(canon, name), os.path.join(tree, name)
        shutil.copytree(source, target) if os.path.isdir(source) else shutil.copy(source, target)
for relative in dirty:
    path = os.path.join(tree, relative)
    content = open(path).read()
    open(path, "w").write("\n\n" + content)
PY
    else
      canonicalise "$tree"
    fi

    commands=()
    names=()
    for tool in "${TOOLS[@]}"; do
      reason="$(validate "$tool" "$tree" "$state")"
      if [[ -n "$reason" ]]; then
        echo "skip: $tool on $size files, $state: $reason" >&2
        continue
      fi
      names+=("$tool")
      commands+=("$(tool_command "$tool")")
    done

    [[ ${#names[@]} -gt 0 ]] || continue
    echo
    echo "=== $size files, $state tree ==="

    json="$RESULTS_DIR/fmt-$TIMESTAMP-$size-$state.json"
    args=(--warmup "$WARMUP" --runs "$RUNS" --ignore-failure --export-json "$json" --shell=none)
    for i in "${!names[@]}"; do
      args+=(--command-name "${names[$i]}" "${commands[$i]}")
    done
    # --shell=none needs the working directory to be the tree.
    (cd "$tree" && hyperfine "${args[@]}")
    printf '%s\t%s\t%s\n' "$size" "$state" "$json" >> "$SUMMARY"
  done
done

echo
echo "=== summary (mean ms; ratio against the fastest) ==="
python3 -I - "$SUMMARY" <<'PY'
import json, sys

def mean_seconds(result):
    # hyperfine 1.x puts `mean` on the result; 2.x moves it under `summary.time_wall_clock`.
    return result["mean"] if "mean" in result else result["summary"]["time_wall_clock"]["mean"]

rows = [line.split("\t") for line in open(sys.argv[1]).read().splitlines() if line]
for size, state, path in rows:
    results = json.load(open(path.strip()))["results"]
    fastest = min(mean_seconds(result) for result in results)
    cells = ", ".join(f'{result["name"] if "name" in result else result["command"]} {mean_seconds(result) * 1000:.1f} ({mean_seconds(result) / fastest:.2f}x)' for result in results)
    print(f"{size:>4} files {state:<5}  {cells}")
PY
echo
echo "Results: $RESULTS_DIR/fmt-$TIMESTAMP-*.json"
