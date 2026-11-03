/**
 * Shared trusted-publishing (OIDC) vs static-token precedence.
 *
 * python (`TWINE_PASSWORD`) and cargo (`CARGO_REGISTRY_TOKEN`) all resolved the exact same decision independently; the
 * only thing that varied was the static-token env-var name. The invariant
 * was being maintained by cross-referencing comments ("aligned with cargo.ts /
 * python.ts") rather than by shared code — a drift hazard. This module is the
 * single source of truth.
 *
 * Not used by native-addon: that adapter performs the npm OIDC token exchange
 * itself (async) and has no `preferStaticToken` escape hatch, so it has a
 * genuinely different shape.
 */
import { VisReleaseError } from "../../errors";
import type { VisReleaseConfig } from "../../types";

export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";

const OIDC_AUDIENCE = "npm:registry.npmjs.org";

/** GitHub Actions CI signal that `permissions: id-token: write` was granted. */
const OIDC_ENV_SIGNAL = "ACTIONS_ID_TOKEN_REQUEST_URL";

export type AuthMode = "missing" | "oidc" | "token";

export interface ResolveAuthModeOptions {
    /** Process env to read the OIDC + static-token signals from. */
    env: NodeJS.ProcessEnv;
    /** Registry-specific static-token env var (e.g. `TWINE_PASSWORD`). */
    staticTokenVar: string;
    /** Workspace config — read for the `publish.preferStaticToken` escape hatch. */
    workspaceConfig?: VisReleaseConfig;
}

/**
 * Resolve which credential path a trusted-publishing adapter should take,
 * without performing any token exchange.
 *
 * Precedence:
 *   - OIDC wins whenever the `ACTIONS_ID_TOKEN_REQUEST_URL` env signal is
 *     present — a leftover static token in the env is more likely stale than
 *     an explicit downgrade.
 *   - Escape hatch: `release.publish.preferStaticToken: true` flips that, so a
 *     present static token wins over OIDC (useful when migrating auth modes).
 *   - Neither signal → `"missing"`, so the caller's `AUTH_MISSING` gate fires
 *     early rather than as a confusing 403 mid-upload.
 * @param options resolution inputs.
 * @returns `"oidc"`, `"token"`, or `"missing"`.
 */
export const resolveAuthMode = (options: ResolveAuthModeOptions): AuthMode => {
    const hasOidc = Boolean(options.env[OIDC_ENV_SIGNAL]);
    const hasStatic = Boolean(options.env[options.staticTokenVar]);
    const preferStatic = options.workspaceConfig?.publish?.preferStaticToken === true;

    if (hasOidc && !(preferStatic && hasStatic)) {
        return "oidc";
    }

    if (hasStatic) {
        return "token";
    }

    return "missing";
};

/**
 * Whether npm authenticates this publish with OIDC: GitHub Actions, or GitLab through `NPM_ID_TOKEN`.
 * `NPM_ID_TOKEN` is checked here rather than in `resolveAuthMode`, which Python and Cargo share.
 */
export const npmUsesOidc = (env: NodeJS.ProcessEnv, config?: VisReleaseConfig): boolean =>
    resolveAuthMode({ env, staticTokenVar: "NPM_TOKEN", workspaceConfig: config }) === "oidc" || (!env["NPM_TOKEN"] && Boolean(env["NPM_ID_TOKEN"]));

export const getGithubActionsIdToken = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
    const requestUrl = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
    const requestToken = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];

    if (!requestUrl || !requestToken) {
        return undefined;
    }

    const url = `${requestUrl}${requestUrl.includes("?") ? "&" : "?"}audience=${encodeURIComponent(OIDC_AUDIENCE)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${requestToken}` } });

    if (!response.ok) {
        return undefined;
    }

    const body = (await response.json().catch(() => {
        return {};
    })) as { value?: string };

    return typeof body.value === "string" ? body.value : undefined;
};

export const exchangeOidcTokenForPackage = async (packageName: string, idToken: string): Promise<string | undefined> => {
    const response = await fetch(`${OFFICIAL_REGISTRY}-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(packageName)}`, {
        headers: { Authorization: `Bearer ${idToken}` },
        method: "POST",
    });

    if (!response.ok) {
        return undefined;
    }

    const body = (await response.json().catch(() => {
        return {};
    })) as { token?: string };

    return typeof body.token === "string" ? body.token : undefined;
};

/**
 * Ask npm, before anything is pushed, whether it accepts this run's OIDC token for every package
 * about to publish. A package without a trusted publisher then fails here instead of after the
 * version commit has landed. Skipped when the static token wins (see `npmUsesOidc`).
 * @param packageNames packages the release is about to publish.
 * @param env process environment.
 */
export const assertOidcPublishable = async (packageNames: readonly string[], env: NodeJS.ProcessEnv, config: VisReleaseConfig): Promise<void> => {
    // The exchange below is GitHub-only; npm checks GitLab's NPM_ID_TOKEN itself.
    if (packageNames.length === 0 || !env["ACTIONS_ID_TOKEN_REQUEST_URL"] || !npmUsesOidc(env, config)) {
        return;
    }

    const idToken = await getGithubActionsIdToken(env);

    if (!idToken) {
        throw new VisReleaseError({
            code: "AUTH_MISSING",
            hint: "Grant `permissions: id-token: write` to the publish job.",
            message: "The publish job did not receive a GitHub OIDC token, so npm cannot be asked for a publish token.",
        });
    }

    const rejected: string[] = [];

    for (const name of packageNames) {
        if (!(await exchangeOidcTokenForPackage(name, idToken))) {
            rejected.push(name);
        }
    }

    if (rejected.length > 0) {
        throw new VisReleaseError({
            code: "AUTH_MISSING",
            hint: "Add a trusted publisher on npm for each package: this repository, the release workflow, and its environment.",
            message: `npm rejected the OIDC token for ${rejected.length} package(s), so nothing was pushed: ${rejected.join(", ")}.`,
        });
    }
};
