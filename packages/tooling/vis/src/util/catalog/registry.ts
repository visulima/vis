import { getRegistryForPackage, TRAILING_SLASH_REGEX } from "./npmrc";
import type { NpmrcConfig, RegistryVersionInfo } from "./types";

const DEFAULT_FETCH_TIMEOUT = 15_000;

export const fetchPackageVersions = async (
    packageName: string,
    registryConfig?: { authToken?: string; url: string },
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT,
    fetchPublishTimes: boolean = false,
): Promise<RegistryVersionInfo> => {
    const baseUrl = (registryConfig?.url ?? "https://registry.npmjs.org").replace(TRAILING_SLASH_REGEX, "");
    const url = `${baseUrl}/${packageName}`;

    // Use abbreviated metadata by default; full metadata when publish times are needed
    const headers: Record<string, string> = fetchPublishTimes ? { Accept: "application/json" } : { Accept: "application/vnd.npm.install-v1+json" };

    if (registryConfig?.authToken) {
        headers["Authorization"] = `Bearer ${registryConfig.authToken}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const response = await fetch(url, { headers, signal: controller.signal });

        if (!response.ok) {
            throw new Error(`Failed to fetch ${packageName}: ${String(response.status)} ${response.statusText}`);
        }

        const data = (await response.json()) as {
            "dist-tags"?: Record<string, string>;
            time?: Record<string, string>;
            versions?: Record<string, unknown>;
        };

        const result: RegistryVersionInfo = {
            latest: data["dist-tags"]?.["latest"] ?? "",
            versions: Object.keys(data.versions ?? {}),
        };

        if (fetchPublishTimes && data.time) {
            result.publishTimes = new Map(Object.entries(data.time));
        }

        return result;
    } finally {
        clearTimeout(timeout);
    }
};

export const fetchVersionsBatched = async (
    uniquePackages: string[],
    npmrcConfig: NpmrcConfig | undefined,
    onProgress: ((current: number, total: number) => void) | undefined,
    fetchPublishTimes: boolean = false,
    maxConcurrentRequests?: number,
): Promise<{ failed: string[]; versionCache: Map<string, RegistryVersionInfo> }> => {
    const versionCache = new Map<string, RegistryVersionInfo>();
    const failed: string[] = [];
    // Clamp to [1, 64] so a misconfigured value can't either deadlock (0)
    // or starve the registry (1000).
    const concurrency = Math.max(1, Math.min(64, Math.floor(maxConcurrentRequests ?? 8) || 8));
    let completed = 0;
    let nextIndex = 0;

    const fetchOne = async (name: string): Promise<void> => {
        try {
            const registry = npmrcConfig ? getRegistryForPackage(name, npmrcConfig) : undefined;
            const info = await fetchPackageVersions(
                name,
                registry ? { authToken: registry.token, url: registry.url } : undefined,
                DEFAULT_FETCH_TIMEOUT,
                fetchPublishTimes,
            );

            versionCache.set(name, info);
        } catch {
            failed.push(name);
        } finally {
            completed += 1;

            if (onProgress) {
                onProgress(completed, uniquePackages.length);
            }
        }
    };

    // Sliding worker pool: keep `concurrency` requests in flight and refill
    // from the queue the instant any one settles, instead of waiting for a
    // whole fixed-size batch to finish. This stops a single slow registry
    // response (up to DEFAULT_FETCH_TIMEOUT) from head-of-line-blocking the
    // next batch, which meaningfully cuts `vis check` wall time on large
    // catalogs behind a flaky private registry.
    const worker = async (): Promise<void> => {
        while (nextIndex < uniquePackages.length) {
            const name = uniquePackages[nextIndex] as string;

            nextIndex += 1;

            await fetchOne(name);
        }
    };

    const workerCount = Math.min(concurrency, uniquePackages.length);

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { failed, versionCache };
};
