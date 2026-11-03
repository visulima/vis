// Bump scripts/gitleaks.ref and scripts/kingfisher.ref to the newest upstream
// release. Used by .github/workflows/secret-scanner-rules-sync.yml; runnable
// locally with an authenticated `gh` CLI.
//
// Usage: node scripts/sync-upstream-refs.mjs [summary.md]
//
// A ref file may carry `major=<n>`: releases from a newer major are then not
// taken, only reported, because they may change the rule format (Kingfisher 2.x
// replaced its own catalog). Prints `changed=true|false` for $GITHUB_OUTPUT and
// writes a Markdown summary to the optional path.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { parseRefFile, updateRefFile } from "./ref-file.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const UPSTREAMS = [
    { file: "gitleaks.ref", label: "gitleaks", repo: "gitleaks/gitleaks" },
    { file: "kingfisher.ref", label: "Kingfisher", repo: "mongodb/kingfisher" },
];

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));

const parseVersion = (tag) => {
    const match = VERSION_PATTERN.exec(tag);

    return match ? match.slice(1, 4).map(Number) : undefined;
};

const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// Newest stable release; with `major`, the newest stable release in that major.
const pickRelease = (repo, major) => {
    const latest = gh(`repos/${repo}/releases/latest`);
    const latestVersion = parseVersion(latest.tag_name);

    if (major === undefined || latestVersion?.[0] === major) {
        return { newerMajor: undefined, tag: latest.tag_name };
    }

    const inMajor = gh(`repos/${repo}/releases?per_page=100`)
        .filter((release) => !release.draft && !release.prerelease)
        .map((release) => {
            return { tag: release.tag_name, version: parseVersion(release.tag_name) };
        })
        .filter((release) => release.version?.[0] === major)
        .toSorted((a, b) => compareVersions(b.version, a.version));

    if (inMajor.length === 0) {
        throw new Error(`${repo}: no stable release in major ${String(major)}`);
    }

    return { newerMajor: latest.tag_name, tag: inMajor[0].tag };
};

const summary = [];
let changed = false;

for (const { file, label, repo } of UPSTREAMS) {
    const path = resolve(here, file);
    const text = readFileSync(path, "utf8");
    const entries = parseRefFile(text, path);
    const { major } = entries;
    const { newerMajor, tag } = pickRelease(repo, major);
    // `commits/<tag>` peels annotated tags to the commit; build-rules compares
    // against `git rev-parse HEAD`, which is the commit, not the tag object.
    const { sha } = gh(`repos/${repo}/commits/${tag}`);

    if (tag === entries.ref && sha === entries.sha) {
        summary.push(`- ${label}: \`${tag}\` (unchanged)`);
    } else {
        changed = true;
        writeFileSync(path, updateRefFile(text, { ref: tag, sha }));
        summary.push(`- ${label}: \`${entries.ref}\` -> [\`${tag}\`](https://github.com/${repo}/releases/tag/${tag})`);
    }

    if (newerMajor) {
        summary.push(
            `  - Newer major available: \`${newerMajor}\`. Not taken (\`major=${String(major)}\` in \`scripts/${file}\`); it needs a manual migration.`,
        );
    }
}

if (argv[2]) {
    writeFileSync(argv[2], `${summary.join("\n")}\n`);
}

stdout.write(`changed=${String(changed)}\n`);
