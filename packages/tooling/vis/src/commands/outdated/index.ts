import type { InferOptions } from "@visulima/cerebro";
import { defineCommand } from "@visulima/cerebro";

import { negatable } from "../../util/negatable-option";

const outdatedOptionDefinitions = {
    ai: {
        defaultValue: false,
        description: "Run AI analysis on outdated packages",
        type: Boolean,
    },
    "ai-type": {
        description: "AI analysis type: impact, security, compatibility, or recommend",
        type: String,
    },
    dev: {
        alias: "D",
        conflicts: "prod",
        description: "Check only devDependencies (npm/yarn mode)",
        type: Boolean,
    },
    exclude: {
        description: "Glob pattern to exclude packages (repeatable)",
        lazyMultiple: true,
        type: String,
    },
    "exit-code": {
        defaultValue: false,
        description: "Exit with code 1 if outdated dependencies found (for CI)",
        type: Boolean,
    },
    format: {
        description: "Output format: table, json, or minimal (default: table)",
        type: String,
    },
    include: {
        description: "Glob pattern to include packages (repeatable)",
        lazyMultiple: true,
        type: String,
    },
    "include-internal": {
        defaultValue: false,
        description: "Also check workspace-owned package names against the registry",
        type: Boolean,
    },
    ...negatable({
        // No `defaultValue`: the handler falls back to config when neither
        // flag is passed, so collapsing it to a boolean here would erase that.
        description: "Scan for known security vulnerabilities (default: true; --no-security to skip)",
        name: "security",
        type: Boolean,
    }),
    peer: {
        defaultValue: false,
        description: "Include peerDependencies in outdated checks",
        type: Boolean,
    },
    prerelease: {
        defaultValue: false,
        description: "Include prerelease versions",
        type: Boolean,
    },
    prod: {
        alias: "P",
        conflicts: "dev",
        description: "Check only dependencies (npm/yarn mode)",
        type: Boolean,
    },
    "security-config": {
        defaultValue: false,
        description: "Audit supply chain security settings",
        type: Boolean,
    },
    sync: {
        defaultValue: false,
        description: "Sync security settings to pnpm-workspace.yaml (pnpm only, requires --security-config)",
        type: Boolean,
    },
    target: {
        alias: "t",
        description: "Update target: latest, minor, or patch (default: latest)",
        type: String,
    },
} as const;

const outdated = defineCommand({
    argument: {
        description: "Specific packages to check (checks all if omitted)",
        name: "packages",
        type: String,
    },
    description: "Check for outdated dependencies, security vulnerabilities, and supply chain settings",
    examples: [
        ["vis outdated", "Check all catalog dependencies"],
        ["vis outdated react", "Check specific packages"],
        ["vis outdated --target minor", "Only show minor/patch updates"],
        ["vis outdated --exclude '@types/*'", "Exclude packages by pattern"],
        ["vis outdated --no-security", "Skip vulnerability scanning"],
        ["vis outdated --security-config", "Audit supply chain security settings"],
        ["vis outdated --security-config --sync", "Sync security config to pnpm-workspace.yaml"],
    ],
    group: "Security & Health",
    loader: () => import("./handler"),
    name: "outdated",
    options: outdatedOptionDefinitions,
});

export default outdated;

export type OutdatedOptions = InferOptions<typeof outdatedOptionDefinitions>;
