#!/usr/bin/env bash
# Generate the workspace fixture that run-commands.sh times the natively routed commands in.
#
#   bash __bench__/cli/gen-workspace-fixture.sh <dir> <packages>
#
# The fixture is built to sit INSIDE the native gate, because a fixture outside it silently measures Node:
#   * a pnpm workspace whose root is the directory itself, with a `pnpm-lock.yaml` next to `pnpm-workspace.yaml`
#     (the native root search finds the root only next to a lockfile marker);
#   * no `vis.config.*`, and no marker, config or Deno file in any parent directory (so <dir> must not be inside a
#     repository that has one: the default under the system temp directory is fine);
#   * an install the lockfile check accepts: `node_modules/.modules.yaml` and `node_modules/.pnpm/lock.yaml`
#     (a copy of the lockfile), written after the lockfile so the install is not stale;
#   * a root `package.json` without `engines`, `packageManager` or `volta`, and no toolchain pin file.
# The bench itself adds the rest of the gate: `CI=1` in the environment and stdout/stderr that are not a terminal.
#
# Contents: <packages> packages in a dependency chain (pkg-001 <- pkg-002 <- ...), each with `build` and `test`
# scripts that are pure shell (`true`), a pure-shell bin in `node_modules/.bin`, a TypeScript file for `vis x`, a
# git repository with one commit. Deterministic: the same arguments give the same tree.
set -euo pipefail

if [[ $# -ne 2 ]] || ! [[ "$2" =~ ^[0-9]+$ ]] || [[ "$2" -lt 1 ]]; then
  echo "usage: $0 <dir> <packages>" >&2
  exit 1
fi

DIR="$1"
COUNT="$2"

rm -rf "$DIR"
mkdir -p "$DIR/packages" "$DIR/node_modules/.bin" "$DIR/node_modules/.pnpm"
cd "$DIR"

# `workspaces` is for npm and bun, which ignore pnpm-workspace.yaml; vis and pnpm read the YAML file.
cat > package.json <<'EOF'
{
  "name": "bench-root",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "noop": "true"
  }
}
EOF
printf 'packages:\n  - "packages/*"\n' > pnpm-workspace.yaml
printf 'node_modules\n.vis\n' > .gitignore

# The lockfile lists every importer, so `pnpm`/`bun` comparators see the same workspace.
{
  printf "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"
  for ((n = 1; n <= COUNT; n += 1)); do
    id="$(printf '%03d' "$n")"
    printf '\n  packages/pkg-%s:\n' "$id"
    if [[ "$n" -gt 1 ]]; then
      prev="$(printf '%03d' $((n - 1)))"
      printf '    dependencies:\n      "@bench/pkg-%s":\n        specifier: workspace:*\n        version: link:../pkg-%s\n' "$prev" "$prev"
    else
      printf '    {}\n'
    fi
  done
  printf '\npackages: {}\n\nsnapshots: {}\n'
} > pnpm-lock.yaml

for ((n = 1; n <= COUNT; n += 1)); do
  id="$(printf '%03d' "$n")"
  mkdir -p "packages/pkg-$id/src"
  {
    printf '{\n  "name": "@bench/pkg-%s",\n  "version": "1.0.0",\n  "private": true,\n' "$id"
    printf '  "scripts": {\n    "build": "true",\n    "test": "true"\n  }'
    if [[ "$n" -gt 1 ]]; then
      printf ',\n  "dependencies": {\n    "@bench/pkg-%s": "workspace:*"\n  }' "$(printf '%03d' $((n - 1)))"
    fi
    printf '\n}\n'
  } > "packages/pkg-$id/package.json"
  printf 'export const value%s = %s;\n' "$id" "$n" > "packages/pkg-$id/src/index.ts"
done

# A pure-shell bin: dispatch cost without a Node start inside the measured command.
printf '#!/bin/sh\nexit 0\n' > node_modules/.bin/noopbin
chmod +x node_modules/.bin/noopbin

printf 'const message: string = "hello";\nconsole.log(message);\n' > hello.ts

# An install that matches the lockfile (what the run gate's freshness check looks for).
cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml
printf 'hoistPattern: []\nlayoutVersion: 5\nnodeLinker: isolated\npackageManager: pnpm@9.0.0\n' > node_modules/.modules.yaml

git init -q
git add .
git -c user.name=bench -c user.email=bench@example.invalid -c commit.gpgsign=false commit -q -m "fixture"
