import { isAccessibleSync, readFileSync } from "@visulima/fs";
import { join } from "@visulima/path";

import type { NpmrcConfig } from "./types";

const SCOPE_REGISTRY_REGEX = /^(@[^:]+):registry$/;

const AUTH_TOKEN_REGEX = /^\/\/(.+)\/:_authToken$/;

const REGISTRY_PROTOCOL_REGEX = /^https?:\/\//;

export const TRAILING_SLASH_REGEX = /\/$/;

const ENV_VAR_REGEX = /\$\{([^}]+)\}/g;

// npm/pnpm/yarn expand `${VAR}` (and `${VAR:-default}`) env references in .npmrc
// values, so `_authToken=${NPM_TOKEN}` is the standard CI pattern. `hasUnresolved`
// flags a reference with no env value and no default so callers can drop broken
// auth entries instead of sending the literal `${NPM_TOKEN}` over the wire.
const expandEnvVars = (value: string): { hasUnresolved: boolean; value: string } => {
    let hasUnresolved = false;

    const expanded = value.replaceAll(ENV_VAR_REGEX, (_match, expression: string) => {
        const defaultIndex = expression.indexOf(":-");
        const name = (defaultIndex === -1 ? expression : expression.slice(0, defaultIndex)).trim();
        const fallback = defaultIndex === -1 ? undefined : expression.slice(defaultIndex + 2);
        const resolved = process.env[name];

        if (resolved !== undefined) {
            return resolved;
        }

        if (fallback !== undefined) {
            return fallback;
        }

        hasUnresolved = true;

        return "";
    });

    return { hasUnresolved, value: expanded };
};

export const parseNpmrc = (content: string): NpmrcConfig => {
    const registries = new Map<string, string>();
    const authTokens = new Map<string, string>();
    let defaultRegistry = "https://registry.npmjs.org";

    for (const line of content.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
            continue;
        }

        const eqIndex = trimmed.indexOf("=");

        if (eqIndex === -1) {
            continue;
        }

        const key = trimmed.slice(0, eqIndex).trim();
        const { hasUnresolved, value } = expandEnvVars(trimmed.slice(eqIndex + 1).trim());

        // @scope:registry=url
        const scopeMatch = SCOPE_REGISTRY_REGEX.exec(key);

        if (scopeMatch?.[1]) {
            registries.set(scopeMatch[1], value);
            continue;
        }

        // registry=url (default)
        if (key === "registry") {
            defaultRegistry = value;
            continue;
        }

        // //registry.url/:_authToken=token
        const authMatch = AUTH_TOKEN_REGEX.exec(key);

        // Drop auth entries whose `${VAR}` reference is unset so a literal
        // `Bearer ${NPM_TOKEN}` is never sent to the registry.
        if (authMatch?.[1] && !hasUnresolved) {
            authTokens.set(authMatch[1], value);
        }
    }

    return { authTokens, defaultRegistry, registries };
};

const mergeNpmrcConfigs = (base: NpmrcConfig, override: NpmrcConfig): NpmrcConfig => {
    const merged: NpmrcConfig = {
        authTokens: new Map([...base.authTokens, ...override.authTokens]),
        defaultRegistry: override.defaultRegistry === "https://registry.npmjs.org" ? base.defaultRegistry : override.defaultRegistry,
        registries: new Map([...base.registries, ...override.registries]),
    };

    return merged;
};

export const loadNpmrc = (workspaceRoot: string): NpmrcConfig => {
    const empty: NpmrcConfig = { authTokens: new Map(), defaultRegistry: "https://registry.npmjs.org", registries: new Map() };

    // Load user-level ~/.npmrc first (lower precedence)
    const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const userNpmrc = join(homeDirectory, ".npmrc");
    let config = homeDirectory && isAccessibleSync(userNpmrc) ? parseNpmrc(readFileSync(userNpmrc)) : empty;

    // Merge project-level .npmrc on top (higher precedence)
    const projectNpmrc = join(workspaceRoot, ".npmrc");

    if (isAccessibleSync(projectNpmrc)) {
        config = mergeNpmrcConfigs(config, parseNpmrc(readFileSync(projectNpmrc)));
    }

    return config;
};

export const getRegistryForPackage = (packageName: string, config: NpmrcConfig): { token?: string; url: string } => {
    let registryUrl = config.defaultRegistry;

    if (packageName.startsWith("@")) {
        const scope = packageName.split("/")[0];

        if (scope && config.registries.has(scope)) {
            const scopeRegistry = config.registries.get(scope);

            if (scopeRegistry) {
                registryUrl = scopeRegistry;
            }
        }
    }

    // Find auth token
    const registryHost = registryUrl.replace(REGISTRY_PROTOCOL_REGEX, "").replace(TRAILING_SLASH_REGEX, "");
    const token = config.authTokens.get(registryHost);

    return { token, url: registryUrl };
};
