import type { InferOptions } from "@visulima/cerebro";
import { defineCommand } from "@visulima/cerebro";

import { negatable } from "../../../../util/negatable-option";

const ciReleaseOptionDefinitions = {
    "allow-full-history": {
        description: "With --generate: walk the whole history when no release tag matches (first release only)",
        type: Boolean,
    },
    "auto-publish": {
        description: "Skip version-PR; version + publish inline",
        type: Boolean,
    },
    branch: {
        description: "Override version-PR branch (default: vis-release/version-packages)",
        type: String,
    },
    channel: {
        description: "Override channel (defaults to current branch lookup)",
        type: String,
    },
    "first-release": {
        description:
            "Bootstrap mode for greenfield monorepos: force currentVersionResolver=disk and skip remote tag-collision checks. Use on the very first release before any git tags exist.",
        type: Boolean,
    },
    generate: {
        description: "Derive the change files from commits first (commit-driven repos). Defaults to the range since the last release tag",
        type: Boolean,
    },
    "generate-from": {
        description: "Start ref for --generate (e.g. github.event.before). Overrides the since-last-release default",
        type: String,
    },
    ...negatable({
        defaultValue: true,
        description:
            "First publish every version a release commit set but no wave finished (a partly failed publish), tagging it on that commit (use --no-publish-missing to disable)",
        name: "publish-missing",
        type: Boolean,
    }),
    "print-config": {
        description: "Print the resolved release config and exit (--print-config=debug for runtime-resolved fields)",
        type: String,
    },
} as const;

const ciRelease = defineCommand({
    commandPath: ["release", "ci"],
    description: "CI: maintain a rolling version-PR (default) or version+publish inline (--auto-publish)",
    examples: [
        ["vis release ci release", "On push to main: open/update Versioned release PR; on PR merge: publish"],
        ["vis release ci release --auto-publish", "Skip version-PR; version + publish inline (alpha/beta workflow)"],
        ["vis release ci release --auto-publish --generate", "Commit-driven: derive the change files from commits, then version + publish"],
    ],
    group: "Release",
    loader: () => import("./handler"),
    name: "release",
    options: ciReleaseOptionDefinitions,
});

export default ciRelease;

export type ReleaseCiReleaseOptions = InferOptions<typeof ciReleaseOptionDefinitions>;
