import { getRegistryForPackage, TRAILING_SLASH_REGEX } from "./npmrc";
import type { ChangelogInfo, NpmrcConfig, OutdatedEntry } from "./types";

const GITHUB_REPO_REGEX = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git|\/|$)/;

export const fetchChangelogInfo = async (packages: OutdatedEntry[], timeoutMs: number = 10_000, npmrcConfig?: NpmrcConfig): Promise<ChangelogInfo[]> => {
    const results: ChangelogInfo[] = [];

    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    const fetchOne = async (entry: OutdatedEntry): Promise<ChangelogInfo> => {
        const npmUrl = `https://www.npmjs.com/package/${entry.packageName}`;

        try {
            const registry = npmrcConfig ? getRegistryForPackage(entry.packageName, npmrcConfig) : { url: "https://registry.npmjs.org" };
            const baseUrl = registry.url.replace(TRAILING_SLASH_REGEX, "");
            const headers: Record<string, string> = { Accept: "application/json" };

            if (registry.token) {
                headers["Authorization"] = `Bearer ${registry.token}`;
            }

            // Fetch the `latest` version manifest (a few KB) instead of the full
            // packument (multi-megabyte for high-version-count packages) — it
            // still carries the `repository` field we need.
            const response = await fetch(`${baseUrl}/${entry.packageName}/latest`, {
                headers,
                signal: controller.signal,
            });

            if (!response.ok) {
                return { npmUrl, packageName: entry.packageName };
            }

            const data = (await response.json()) as { repository?: { url?: string } };
            const repoUrl = data.repository?.url;

            if (!repoUrl) {
                return { npmUrl, packageName: entry.packageName };
            }

            const match = GITHUB_REPO_REGEX.exec(repoUrl);

            if (!match) {
                return { npmUrl, packageName: entry.packageName, repoUrl };
            }

            const owner = match[1];
            const repo = match[2];
            const releaseUrl = `https://github.com/${owner}/${repo}/releases/tag/v${entry.targetVersion}`;

            return { npmUrl, packageName: entry.packageName, releaseUrl, repoUrl: `https://github.com/${owner}/${repo}` };
        } catch {
            return { npmUrl, packageName: entry.packageName };
        }
    };

    // Cap in-flight requests with a sliding worker pool so a large catalog can't
    // fire hundreds of parallel downloads under the shared abort controller.
    const concurrency = Math.min(8, packages.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
        while (nextIndex < packages.length) {
            const index = nextIndex;

            nextIndex += 1;

            results[index] = await fetchOne(packages[index] as OutdatedEntry);
        }
    };

    try {
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
        clearTimeout(timeout);
    }

    return results;
};
