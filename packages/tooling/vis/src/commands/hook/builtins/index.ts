/**
 * Registry of vis-bundled `pre-commit-hooks`-equivalent built-ins.
 *
 * `vis hook run` has a native fast path (native/cli/src/hook/builtins.rs) that
 * reimplements trailing-whitespace, end-of-file-fixer, mixed-line-ending and
 * check-merge-conflict. Changing one of those here means changing it there too;
 * `__tests__/native/hook-run-parity.test.ts` fails when they drift. A new builtin
 * that is not ported simply makes the native path hand the run to this runner.
 *
 * Adding a new builtin: drop a module beside this file that exports
 * `(files, args, logger) => number`, then add an entry below. The map
 * key is the public hook id (matches the upstream pre-commit id where
 * one exists) and is referenced from `HookEntry.builtin` in
 * `.vis/hooks/config.json` as well as from
 * `prek.ts:REMOTE_HOOK_BUILTIN_MAP`.
 */

import { runCheckJson } from "./check-json";
import { runCheckMergeConflict } from "./check-merge-conflict";
import { runEndOfFileFixer } from "./end-of-file-fixer";
import { runMixedLineEnding } from "./mixed-line-ending";
import { runTrailingWhitespace } from "./trailing-whitespace";
import type { BuiltinFunction } from "./types";

const BUILTIN_REGISTRY: Readonly<Record<string, BuiltinFunction>> = {
    "check-json": runCheckJson,
    "check-merge-conflict": runCheckMergeConflict,
    "end-of-file-fixer": runEndOfFileFixer,
    "mixed-line-ending": runMixedLineEnding,
    "trailing-whitespace": runTrailingWhitespace,
};

const BUILTIN_HOOK_IDS: ReadonlyArray<string> = Object.keys(BUILTIN_REGISTRY).sort();

/** Whether `id` is a registered builtin hook. */
/** Returns the builtin hook function for `id`, or `undefined` if none. */
const getBuiltin = (id: string): BuiltinFunction | undefined => BUILTIN_REGISTRY[id];

export { BUILTIN_HOOK_IDS, BUILTIN_REGISTRY, getBuiltin };

export { type BuiltinContext, type BuiltinFunction, type BuiltinLogger } from "./types";
