/**
 * Action versions the generated GitHub workflows use (`vis sync ci-workflow`,
 * `vis sync codeowners --write-guard`, `vis release init --workflows`), kept
 * in one place so the generators move together.
 */
export const GITHUB_ACTIONS = {
    cache: "actions/cache@v5",
    checkout: "actions/checkout@v7",
    setupBun: "oven-sh/setup-bun@v2",
    setupNode: "actions/setup-node@v7",
    setupPnpm: "pnpm/action-setup@v6",
} as const;
