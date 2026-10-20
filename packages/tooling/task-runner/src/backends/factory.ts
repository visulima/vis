import { HttpRemoteCache } from "./http";
import { ReapiRemoteCache } from "./reapi";
import type { CacheMode, RemoteCacheBackend, RemoteCacheOptions } from "./types";

/**
 * Resolves the canonical {@link CacheMode}. `mode` defaults to
 * `"readwrite"` when unset — the safe choice for CI and the most
 * common config in dev. Kept as a separate helper so vis-side code
 * (CLI flag merge, doctor probes) can reuse the resolution rule.
 */
export const resolveCacheMode = (options: { mode?: CacheMode }): CacheMode => options.mode ?? "readwrite";

/**
 * Fill missing HTTP-backend fields from Turborepo's environment
 * variables so a workspace migrating from Turbo can keep its existing
 * CI secrets:
 *
 * - `TURBO_API`   → `url`
 * - `TURBO_TOKEN` → `token`
 * - `TURBO_TEAM`  → `teamId`
 *
 * Explicit values in `input` always win. Returns `undefined` when
 * neither config nor env supplies a URL, which is the signal callers
 * use to mean "no remote cache configured." REAPI users are unaffected
 * — the env vars are Turborepo-shaped and only resolve `http` fields.
 */
export const resolveTurboEnvCompat = (input?: Partial<RemoteCacheOptions>, env: NodeJS.ProcessEnv = process.env): RemoteCacheOptions | undefined => {
    const backend = input?.backend ?? "http";

    if (backend !== "http") {
        return input?.url ? (input as RemoteCacheOptions) : undefined;
    }

    const url = input?.url ?? env["TURBO_API"];

    if (!url) {
        return undefined;
    }

    return {
        ...input,
        teamId: input?.teamId ?? env["TURBO_TEAM"],
        token: input?.token ?? env["TURBO_TOKEN"],
        url,
    };
};

/**
 * Construct the configured remote cache backend. Selects between the
 * Turborepo-compatible HTTP client and the Bazel REAPI gRPC client
 * via `options.backend`.
 *
 * The returned backend is wrapped so that a transport-level failure — a 5xx,
 * a dropped connection, a timeout, any thrown error from an RPC — behaves
 * like a cache miss instead of failing the run. `onError` observes every
 * failure; callers that surface warnings should dedupe. Errors raised by the
 * task command itself never pass through this boundary and are unaffected.
 */
export const createRemoteCacheBackend = (options: RemoteCacheOptions, onError?: (error: unknown, operation: "read" | "write") => void): RemoteCacheBackend => {
    const mode = resolveCacheMode(options);

    const report = (error: unknown, operation: "read" | "write"): void => {
        if (onError) {
            onError(error, operation);
        } else {
            // Preserve the caller's existing upload hook when no wrapper-level
            // reporter was provided.
            options.onUploadError?.("remote-cache", error);
        }
    };

    const resolved: RemoteCacheOptions = {
        ...options,
        mode,
        // Both backends report wire-level upload failures through this hook.
        // Routing it through `report` keeps those errors on the same
        // once-per-run path as thrown read errors. The hook is upload-shaped,
        // so a read failure surfaced here is labelled "write"; callers should
        // treat that label as best-effort.
        onUploadError: (_hash, error) => {
            report(error, "write");
        },
    };

    const backend: RemoteCacheBackend = options.backend === "reapi" ? new ReapiRemoteCache(resolved) : new HttpRemoteCache(resolved);

    return {
        close: () => backend.close(),
        containsAction: async (digest) => {
            try {
                return await backend.containsAction(digest);
            } catch (error) {
                report(error, "read");

                return false;
            }
        },
        fetchBlob: async (digest, destinationPath) => {
            try {
                return await backend.fetchBlob(digest, destinationPath);
            } catch (error) {
                report(error, "read");

                return false;
            }
        },
        retrieveAction: async (digest) => {
            try {
                return await backend.retrieveAction(digest);
            } catch (error) {
                report(error, "read");

                return null;
            }
        },
        storeAction: async (digest, result, blobs) => {
            try {
                return await backend.storeAction(digest, result, blobs);
            } catch (error) {
                report(error, "write");

                return false;
            }
        },
    };
};
