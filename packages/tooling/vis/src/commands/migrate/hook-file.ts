import { statSync } from "node:fs";

import { writeFileSync } from "@visulima/fs";

/**
 * Replace the content of an existing git hook while keeping its permission bits.
 * `writeFileSync` stages a temporary file and renames it over the target, and the
 * temporary file gets the default mode, so without an explicit mode an executable
 * hook would come out non-executable and git would skip it.
 * @param path Path of the hook that is being rewritten; it must already exist.
 * @param content The new content of the hook.
 */
export const rewriteHookFile = (path: string, content: string): void => {
    // eslint-disable-next-line no-bitwise
    writeFileSync(path, content, { mode: statSync(path).mode & 0o7777 });
};
