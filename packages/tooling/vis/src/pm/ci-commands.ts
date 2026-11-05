import type { LockfilePackageManager } from "../preflight/lockfile";
import { GITHUB_ACTIONS } from "../util/github-actions";

/**
 * What a generated CI workflow runs for each package manager. Shared by the
 * workflow generators (`vis sync ci-workflow`, `vis release init --workflows`)
 * so their install and exec commands cannot drift apart.
 */
export interface CiPackageManagerCommands {
    /** Prefix that runs a binary installed in the workspace, e.g. `pnpm exec`. */
    exec: string;
    /** GitHub Action that installs the package manager, when it has one. */
    githubAction?: string;

    /**
     * `actions/setup-node` `cache:` value, when setup-node can cache for this
     * manager. setup-node asks the manager for its cache directory, so a manager
     * that only becomes available through `setup` (after setup-node) has none.
     */
    githubNodeCache?: "npm" | "pnpm";
    /** Lockfile-respecting install. */
    install: string;

    /**
     * Shell lines that make the package manager available on a plain `node`
     * image (GitLab), or on the GitHub runner when there is no `githubAction`.
     * corepack is installed explicitly because Node.js 25+ no longer bundles it.
     */
    setup: string[];
}

const COREPACK = ["npm install -g corepack", "corepack enable"];

export const CI_PACKAGE_MANAGER_COMMANDS: Record<LockfilePackageManager, CiPackageManagerCommands> = {
    aube: { exec: "npx", install: "aube install --frozen-lockfile", setup: COREPACK },
    bun: { exec: "bunx", githubAction: GITHUB_ACTIONS.setupBun, install: "bun install --frozen-lockfile", setup: ["npm install -g bun"] },
    npm: { exec: "npx", githubNodeCache: "npm", install: "npm ci", setup: [] },
    pnpm: { exec: "pnpm exec", githubAction: GITHUB_ACTIONS.setupPnpm, githubNodeCache: "pnpm", install: "pnpm install --frozen-lockfile", setup: COREPACK },
    // `yarn <bin>` runs a workspace binary on both yarn 1 and yarn berry.
    yarn: { exec: "yarn", install: "yarn install --immutable", setup: COREPACK },
};
