// Regenerates `semver-corpus.json`: random (versions, range) pairs and what node-semver's
// `maxSatisfying(versions, range, { includePrerelease: true })` answers for each, which the Rust unit test
// `sbom::semver::tests::agrees_with_node_semver` replays. Run from `packages/tooling/vis`:
//   node native/cli/tests/fixtures/sbom/generate-semver-corpus.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

let seed = Number(process.env.SEED ?? 0x2f6e2b1);
const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

    return seed / 2 ** 32;
};
const pick = (list) => list[Math.floor(random() * list.length)];

const numbers = ["0", "0", "1", "1", "1", "2", "2", "3", "10", "01"];
const wild = ["x", "X", "*"];
const pres = ["alpha", "beta.1", "rc.2", "0", "1", "alpha.1.2", "x", "01"];
const part = () => (random() < 0.12 ? pick(wild) : pick(numbers));
const partial = () => {
    const length = 1 + Math.floor(random() * 3);
    let text = Array.from({ length }, part).join(".");

    if (length === 3 && random() < 0.2) {
        text += `-${pick(pres)}`;
    }

    return text;
};
const operators = ["", "", "", "^", "~", ">=", ">", "<=", "<", "=", "~>", ">= ", "v", "^ "];
const token = () => `${pick(operators)}${partial()}`;
const set = () => {
    const roll = random();

    if (roll < 0.04) {
        return pick(["*", "", "x", "latest", "next", "workspace:*", "link:../x", "npm:foo@^1", "catalog:", ">=0.0.0", "<0.0.0", "1.2.3+build"]);
    }

    if (roll < 0.14) {
        return `${partial()} - ${partial()}`;
    }

    return Array.from({ length: 1 + Math.floor(random() * 2) }, token).join(random() < 0.1 ? "  " : " ");
};
const range = () => Array.from({ length: random() < 0.2 ? 2 : 1 }, set).join(random() < 0.5 ? " || " : "||");

const versionPool = [];

for (const major of [0, 1, 2, 3, 10]) {
    for (const minor of [0, 1, 2]) {
        for (const patch of [0, 1, 5]) {
            versionPool.push(`${major}.${minor}.${patch}`);
        }
    }
}

versionPool.push("1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta.2", "1.0.0-rc.1", "2.0.0-0", "2.0.0-beta.1", "0.0.1-0", "1.2.3+build", "1.2.3+other", "1.0.0-x", "1.0.0-1", "1.0.0-10", "1.0.0-9", "https://example.test/a.tgz", "1.0.0_peer@2.0.0", "01.0.0", "1.0", "1.2.3.4");

const versions = () => Array.from({ length: 2 + Math.floor(random() * 6) }, () => pick(versionPool));

const cases = [];

for (let index = 0; index < Number(process.env.COUNT ?? 1500); index += 1) {
    const list = versions();
    const text = range();

    cases.push({ expected: semver.maxSatisfying(list, text, { includePrerelease: true }), range: text, versions: list });
}

const here = dirname(fileURLToPath(import.meta.url));

writeFileSync(process.env.OUT ?? join(here, "semver-corpus.json"), `${JSON.stringify({ semver: semver.SEMVER_SPEC_VERSION, cases })}\n`);
// eslint-disable-next-line no-console
console.log(`${cases.length} cases, ${cases.filter((entry) => entry.expected === null).length} without a match`);
