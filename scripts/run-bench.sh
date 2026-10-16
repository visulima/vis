#!/usr/bin/env bash
# Runs one package's benchmarks. Packages with a separate __bench__ package run that
# package's bench script; the others run their own test:bench script.
set -euo pipefail

dir="$1"

if [ -f "$dir/__bench__/package.json" ]; then
    exec pnpm --dir "$dir/__bench__" run bench
fi

exec pnpm --dir "$dir" run test:bench
