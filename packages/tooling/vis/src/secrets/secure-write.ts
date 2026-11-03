// Owner-only writes for files that hold unredacted secrets (gitleaks #2299 /
// #2300, GHSA-7q9c-g7gj-c7c3): reports and baselines would otherwise inherit
// the umask, typically a world-readable 0644.
//
// NOTE: node:fs is used directly — `toolbox.fs` (CerebroFs) has neither a
// `mode` option on writeFile nor a chmod op.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

import { dirname } from "@visulima/path";

const OWNER_ONLY = 0o600;

/**
 * Write `content` to `path`. With `sensitive`, the file is created 0600 and an
 * existing file is tightened to 0600 too, since `open`'s mode only applies on
 * creation. Without it, the permissions are left alone. Parent directories
 * are created.
 */
export const writeReportFileSync = (path: string, content: string, sensitive: boolean): void => {
    mkdirSync(dirname(path), { recursive: true });

    if (!sensitive) {
        writeFileSync(path, content);

        return;
    }

    writeFileSync(path, content, { mode: OWNER_ONLY });
    chmodSync(path, OWNER_ONLY);
};
