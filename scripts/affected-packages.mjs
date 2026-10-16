// Lists the published workspace packages that changed between two commits.
// Usage: node scripts/affected-packages.mjs [base] [head] [--bench]
//
// A change maps to the package at packages/<group>/<name>, so changes inside a
// package's native/, npm/ or dashboard/ folders count for that package. A change under
// shared/ can affect any package, so it selects all of them.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageDirs = () => {
    const found = [];

    for (const group of readdirSync("packages", { withFileTypes: true })) {
        if (!group.isDirectory()) continue;

        for (const name of readdirSync(join("packages", group.name), { withFileTypes: true })) {
            const dir = join("packages", group.name, name.name);

            if (name.isDirectory() && existsSync(join(dir, "package.json"))) found.push(dir);
        }
    }

    return found;
};

export const affectedPackages = ({ base, head = "HEAD", bench = false }) => {
    const changed = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    const all = packageDirs();
    const selected = new Set();

    for (const file of changed) {
        if (file.startsWith("shared/") || file === "package.json" || file.startsWith("pnpm-")) {
            all.forEach((dir) => selected.add(dir));
            continue;
        }

        const [root, group, name] = file.split("/");

        if (root === "packages" && group && name) selected.add(join("packages", group, name));
    }

    return [...selected]
        .filter((dir) => all.includes(dir))
        .filter((dir) => {
            const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

            if (pkg.private === true) return false;
            if (!bench) return true;

            return existsSync(join(dir, "__bench__", "package.json")) || Boolean(pkg.scripts?.bench || pkg.scripts?.["test:bench"]);
        })
        .sort();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const [base = "origin/main", head = "HEAD"] = args.filter((arg) => !arg.startsWith("--"));

    console.log(JSON.stringify(affectedPackages({ base, head, bench: args.includes("--bench") })));
}
