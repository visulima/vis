// Parse and update the pinned upstream `.ref` files (scripts/gitleaks.ref,
// scripts/kingfisher.ref). A ref file holds `key=value` lines and `#` comments:
//
//   major=8      optional: the sync job only takes releases from this major
//   ref=v8.30.1  release tag
//   sha=83d9...  commit the tag points to
//
// Shared by build-rules.mjs (reads the pin) and sync-upstream-refs.mjs (bumps it).

import { readFileSync } from "node:fs";

const LINE_SPLIT_PATTERN = /\r?\n/;
const MAJOR_PATTERN = /^\d+$/;

// Returns `{ major, ref, sha }`; `major` is undefined when the file has none.
// `source` (a path or label) only appears in error messages.
export const parseRefFile = (text, source = "ref file") => {
    const entries = {};

    for (const line of text.split(LINE_SPLIT_PATTERN)) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }

        const eq = trimmed.indexOf("=");

        if (eq === -1) {
            continue;
        }

        entries[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }

    if (!entries.ref || !entries.sha) {
        throw new Error(`invalid ref file (${source}): expected ref=... and sha=... lines`);
    }

    if (entries.major !== undefined && !MAJOR_PATTERN.test(entries.major)) {
        throw new Error(`invalid ref file (${source}): major=${entries.major} is not a non-negative integer`);
    }

    return {
        major: entries.major === undefined ? undefined : Number(entries.major),
        ref: entries.ref,
        sha: entries.sha,
    };
};

export const readRefFile = (path) => parseRefFile(readFileSync(path, "utf8"), path);

// Rewrites the `ref=` and `sha=` lines, keeping comments, `major`, line order
// and line endings as they are. Throws on a malformed file instead of writing one.
export const updateRefFile = (text, { ref, sha }) => {
    parseRefFile(text);

    const replacements = { ref, sha };

    return text
        .split("\n")
        .map((line) => {
            const trimmed = line.trim();
            const eq = trimmed.indexOf("=");

            if (eq === -1 || trimmed.startsWith("#")) {
                return line;
            }

            const key = trimmed.slice(0, eq).trim();

            if (!Object.hasOwn(replacements, key)) {
                return line;
            }

            const eol = line.endsWith("\r") ? "\r" : "";

            return `${key}=${replacements[key]}${eol}`;
        })
        .join("\n");
};
