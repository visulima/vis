// Owner-only writes for files that hold unredacted secrets (gitleaks #2299 /
// #2300, GHSA-7q9c-g7gj-c7c3): reports and baselines would otherwise inherit
// the umask, typically a world-readable 0644.
//
// NOTE: node:fs is used directly — `toolbox.fs` (CerebroFs) has neither a
// `mode` option on writeFile nor a chmod op.

import { closeSync, fchmodSync, mkdirSync, openSync, writeFileSync } from "node:fs";

import { dirname } from "@visulima/path";

const OWNER_ONLY = 0o600;

/**
 * Write `content` to `path`. With `sensitive`, the file is created 0600 and an
 * existing file is tightened to 0600 too (`open`'s mode only applies on
 * creation) before any content is written, so the secrets are never readable
 * under the old mode. Without it, the permissions are left alone. Parent
 * directories are created.
 */
export const writeReportFileSync = (path: string, content: string, sensitive: boolean): void => {
    mkdirSync(dirname(path), { recursive: true });

    if (!sensitive) {
        writeFileSync(path, content);

        return;
    }

    // Opening with "w" truncates, so the old content is gone before the chmod.
    const fd = openSync(path, "w", OWNER_ONLY);

    try {
        fchmodSync(fd, OWNER_ONLY);
        writeFileSync(fd, content);
    } finally {
        closeSync(fd);
    }
};
