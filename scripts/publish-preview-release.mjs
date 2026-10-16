// Publishes the packages a pull request changes to the pkg-pr-new registry.
// The base commit comes from BASE_SHA, which the preview workflow sets to the PR base.

import { execFileSync } from "node:child_process";

import { affectedPackages } from "./affected-packages.mjs";

const packages = affectedPackages({ base: process.env.BASE_SHA || "origin/main" });

if (packages.length > 0) {
    execFileSync("pnpm", ["exec", "pkg-pr-new", "publish", "--comment=update", "--pnpm", ...packages], { stdio: "inherit" });
} else {
    console.log("No packages to publish");
}
