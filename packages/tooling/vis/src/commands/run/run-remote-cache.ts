import type { Toolbox } from "@visulima/cerebro";
import type { TaskRunnerOptions } from "@visulima/task-runner";
import { resolveTurboEnvCompat } from "@visulima/task-runner";

import type { RunOptions } from "./index";
import { parseCacheBackend, parseCacheMode } from "./parse";

/**
 * Applies the `remoteCache` settings to the runner options: CLI and config
 * layers, TURBO_* env fallbacks, and the optional sigstore attestation hooks.
 * Throws on a half-configured attestation block.
 */
export const applyRemoteCacheConfig = async ({
    configTaskRunner,
    logger,
    options,
    runnerOptions,
    workspaceRoot,
}: {
    configTaskRunner: TaskRunnerOptions & { cacheDirectory?: string };
    logger: Toolbox<Console, RunOptions>["logger"];
    options: RunOptions;
    runnerOptions: TaskRunnerOptions;
    workspaceRoot: string;
}): Promise<void> => {
    // Resolve the remote-cache config in three layers (CLI > vis.config.ts
    // > TURBO_* env-var fallback). Fill missing HTTP fields from TURBO_API /
    // TURBO_TOKEN / TURBO_TEAM so CI jobs that already export those variables
    // keep working without rewriting their secrets. Rejects malformed CLI values
    // up front so a typo in `--cache-mode=eread` doesn't silently fall
    // through to the runner and surface as "no cache hits".
    const envCompatRemoteCache = resolveTurboEnvCompat(configTaskRunner.remoteCache);

    if (envCompatRemoteCache) {
        const cliMode = parseCacheMode(options.cacheMode);
        const cliBackend = parseCacheBackend(options.cacheBackend);

        runnerOptions.remoteCache = {
            ...envCompatRemoteCache,
            ...(cliMode ? { mode: cliMode } : {}),
            ...(cliBackend ? { backend: cliBackend } : {}),
        };

        // Config can only carry serializable attestation knobs
        // (`requireOnDownload`, `expectedIdentity`); the actual keyless
        // sign/verify callbacks can't live in vis.config.ts. When the
        // user opted in, swap the declarative stub for Sigstore-backed
        // hooks here.
        if (runnerOptions.remoteCache.attestation) {
            const { expectedIdentity, requireOnDownload } = runnerOptions.remoteCache.attestation;

            // Verifying a keyless bundle without pinning the signer
            // proves integrity, not authenticity — that is what the HMAC
            // `signing` block already does. Accept any of the three
            // public identity forms; refuse a half-configured setup
            // loudly rather than ship a false sense of provenance.
            const identityConfigured
                = expectedIdentity !== undefined
                    && (("github" in expectedIdentity
                        && typeof expectedIdentity.github?.ref === "string"
                        && typeof expectedIdentity.github.repo === "string"
                        && typeof expectedIdentity.github.workflow === "string")
                    || ("oidcIssuer" in expectedIdentity
                        && typeof expectedIdentity.oidcIssuer === "string"
                        && (typeof (expectedIdentity as { san?: unknown }).san === "string"
                            || typeof (expectedIdentity as { sanRegex?: unknown }).sanRegex === "string")));

            if (!identityConfigured) {
                throw new Error(
                    "[vis run] remoteCache.attestation requires a pinned keyless signer via `expectedIdentity`. Use one of:\n  • { github: { repo, workflow, ref } }   (GitHub Actions — recommended)\n  • { oidcIssuer, san }                   (literal identity; vis regex-escapes + anchors it)\n  • { oidcIssuer, sanRegex }              (advanced: raw regex, you own anchoring)\nWithout it, verification is integrity-only — use `remoteCache.signing` (HMAC) for that instead.",
                );
            }

            // Only the raw-regex form carries the unanchored-match
            // hazard: sigstore matches the SAN with `String.match`, so a
            // substring-matched pattern lets a longer attacker SAN that
            // merely *contains* the expected value pass. The `github`
            // and literal `san` forms are escaped and `^…$`-anchored by
            // `normalizeExpectedIdentity`, so they're safe by default.
            if ("sanRegex" in expectedIdentity && (!expectedIdentity.sanRegex.startsWith("^") || !expectedIdentity.sanRegex.endsWith("$"))) {
                logger.warn(
                    "[vis run] remoteCache.attestation.expectedIdentity.sanRegex is not anchored (^…$). sigstore matches it as a regex; an unanchored value is substring-matched and weakens the identity pin. Prefer the literal `san` form unless you need a pattern.",
                );
            }

            const { installCommandFor, isSigstoreInstalled } = await import("../../security/sigstore/loader");

            // Surface a missing optional peer dep at startup rather than
            // mid-run: warn (don't fail) so a misconfigured consumer
            // still runs, just without provenance, with a copy-paste fix.
            if (!isSigstoreInstalled()) {
                logger.warn(
                    `[vis run] remoteCache.attestation is configured but the optional \`sigstore\` package is not installed. Cache uploads will be unsigned and signed entries can't be verified until you install it:\n  ${installCommandFor(workspaceRoot)}`,
                );
            }

            const { buildCacheAttestationHooks } = await import("../../security/sigstore/cache-attestation");

            runnerOptions.remoteCache.attestation = buildCacheAttestationHooks({
                expectedIdentity,
                onReject: (hash, reason) => {
                    logger.warn(`[vis run] remote cache entry ${hash.slice(0, 12)} rejected: attestation ${reason}. Treating as a cache miss.`);
                },
                onVerifyFailure: (message) => {
                    logger.warn(`[vis run] attestation verification failed: ${message}`);
                },
                requireOnDownload,
                workspaceRoot,
            });
        }
    } else if (options.cacheMode || options.cacheBackend) {
        logger.warn("[vis run] --cache-mode and --cache-backend require a `remoteCache` block in vis.config.ts (or TURBO_API env); ignoring.");
    }
};
