/**
 * Post-publish notification walk — semantic-release parity (`successComment`
 * + `releasedLabels`).
 *
 * Once a publish wave has succeeded and tags are pushed, walk every PR / issue
 * mentioned in the rendered changelog entries and:
 *
 *   1. Upsert a sticky comment listing every package + version the ref
 *      shipped in (marker `&lt;!-- vis-release-success -->`). The list
 *      accumulates per channel across waves: a PR shipped on `alpha` and
 *      later promoted to `latest` keeps both lines.
 *   2. Add the configured labels (default `["released"]`).
 *
 * The walk runs inside `publishContext` after `createRemoteReleases`; every
 * call is wrapped in soft-fail handling so a forge-side hiccup on a single
 * ref doesn't roll back the rest of the wave (the publish itself already
 * landed).
 *
 * Reference extraction supports the two most common forms used in vis
 * change-files and conventional commit footers:
 *
 *   - `#123`     — bare GitHub-style reference (an issue on GitLab)
 *   - `gh-123`   — alternate prefix used by some teams to disambiguate
 *   - `!123`     — GitLab merge request (GitLab remotes only)
 *
 * URLs that already point at a PR (`https://github.com/x/y/pull/123`,
 * `https://gitlab.com/x/y/-/merge_requests/123`) are also picked up so links
 * embedded in change-file bodies don't drop on the floor.
 *
 * Refs are deduped across every release in the wave — if a single PR shows
 * up in the changelogs of three packages we still only comment / label it
 * once.
 */

import semver from "semver";

import type { PlannedRelease } from "../types";
import type { ChangelogFormatter } from "./changelog/api";
import type { OrchestratorContext, PublishContextResult } from "./orchestrator";
import type { CommandRunner } from "./package-managers/interface";
import type { IssueTarget, RemoteReleaseClient } from "./remote/interface";

/** Stable marker used by the sticky-comment upsert path. */
export const SUCCESS_WALK_MARKER = "<!-- vis-release-success -->";

/** Default labels appended to walked PRs / issues. */
export const DEFAULT_SUCCESS_WALK_LABELS = ["released"];

/**
 * Default comment template. `{releases}` lists every package + version the
 * ref shipped in, grouped by channel, so it reads correctly for a single
 * package and for a monorepo wave alike.
 */
export const DEFAULT_SUCCESS_WALK_COMMENT = `${SUCCESS_WALK_MARKER}\n:tada: This has been released :tada:\n\n{releases}`;

/**
 * Hidden block holding every release the comment has listed so far. The
 * visible body is re-rendered from it on each wave, so history survives a
 * custom template and nothing has to be parsed back out of Markdown.
 */
const DATA_PATTERN = /<!-- vis-release-success-data (.*?) -->/s;

/** A channel list longer than this collapses into a `&lt;details>` block. */
const COLLAPSE_ABOVE = 10;

/** One package release listed in the sticky comment. */
export interface SuccessCommentRelease {
    name: string;
    /** Published to npmjs.com; the npm link is rebuilt from `name` + `version`, never stored. */
    npm?: boolean;
    /** Forge release page. */
    url?: string;
    version: string;
}

/** Releases per channel (dist-tag), in the order the channels first shipped the ref. */
type SuccessCommentData = Record<string, SuccessCommentRelease[]>;

// The history is read back from a forge comment, so everything rendered from it is checked
// against charsets that cannot carry Markdown, HTML or a link target.
const CHANNEL = /^[\w.-]*$/;
const NAME = /^[\w@/.:~+-]{1,214}$/;
const NPM_NAME = /^(?:@[a-z0-9-~][\w.~-]*\/)?[a-z0-9-~][\w.~-]*$/;
const VERSION = /^[\w.+-]{1,64}$/;
const SAFE_URL = /^https:\/\/[^\s"'()<>[\]`\\]+$/;

/**
 * Keep an entry only when it renders inert. `urlPrefix` gates the release link: a fresh entry
 * from this wave passes `undefined` (its URL came from the forge), a stored one must point
 * under this repository's releases page or loses the link.
 */
const sanitizeRelease = (entry: unknown, urlPrefix: string | false | undefined): SuccessCommentRelease | undefined => {
    const { name, npm, url, version } = (entry ?? {}) as Partial<Record<keyof SuccessCommentRelease, unknown>>;

    if (typeof name !== "string" || typeof version !== "string" || !NAME.test(name) || !VERSION.test(version)) {
        return undefined;
    }

    const safeUrl = typeof url === "string" && SAFE_URL.test(url) && (urlPrefix === undefined || (urlPrefix !== false && url.startsWith(urlPrefix))) ? url : undefined;

    return {
        name,
        npm: npm === true && NPM_NAME.test(name) && semver.valid(version) !== null ? true : undefined,
        url: safeUrl,
        version,
    };
};

const readCommentData = (body: string | undefined, urlPrefix: string | false): SuccessCommentData => {
    const json = body === undefined ? undefined : DATA_PATTERN.exec(body)?.[1];

    if (json === undefined) {
        return {};
    }

    try {
        const parsed = JSON.parse(json);

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }

        const data: SuccessCommentData = {};

        for (const [channel, releases] of Object.entries(parsed as Record<string, unknown>)) {
            if (CHANNEL.test(channel) && Array.isArray(releases)) {
                data[channel] = releases.map((entry) => sanitizeRelease(entry, urlPrefix)).filter((entry) => entry !== undefined);
            }
        }

        return data;
    } catch {
        return {};
    }
};

const renderRelease = (release: SuccessCommentRelease): string => {
    const label = `\`${release.name}@${release.version}\``;
    const main = release.url ? `[${label}](${release.url})` : label;

    return release.npm ? `- ${main} · [npm](https://www.npmjs.com/package/${release.name}/v/${release.version})` : `- ${main}`;
};

const renderReleases = (data: SuccessCommentData): string =>
    Object.entries(data)
        .map(([channel, releases]) => {
            let list = releases.map((release) => renderRelease(release)).join("\n");

            if (releases.length > COLLAPSE_ABOVE) {
                list = `<details>\n<summary>${releases.length} packages</summary>\n\n${list}\n\n</details>`;
            }

            return channel ? `**${channel}**\n\n${list}` : list;
        })
        .join("\n\n");

/** A ref plus the GitLab object it names (always `"issue"` off GitLab). */
export interface TypedReference {
    number: number;
    target: IssueTarget;
}

/**
 * Like {@link extractReferences}, but keeps which object each number names. On
 * GitLab `#N` is an issue and `!N` a merge request, in separate number
 * spaces; `!N` is only scanned there since `!` carries no meaning on GitHub.
 */
export const extractTypedReferences = (body: string, repo: string | undefined, gitlab: boolean): TypedReference[] => {
    const found = new Map<string, TypedReference>();
    const add = (num: number, target: IssueTarget): void => {
        const resolved = gitlab ? target : "issue";

        found.set(`${resolved}:${num}`, { number: num, target: resolved });
    };

    // #123 — but only when preceded by whitespace, start-of-line, or a
    // common punctuation char. The negative lookbehind would be cleaner,
    // but lookbehinds are not universally supported in older Node — use a
    // positive boundary check instead.
    const hashRegex = /(?:^|[\s(,;:!?])#(\d+)/g;
    let match: RegExpExecArray | null;

    // eslint-disable-next-line no-cond-assign
    while ((match = hashRegex.exec(body)) !== null) {
        const num = Number.parseInt(match[1]!, 10);

        if (Number.isFinite(num) && num > 0) {
            add(num, "issue");
        }
    }

    // gh-123 / GH-123
    const ghRegex = /\bgh-(\d+)/gi;

    // eslint-disable-next-line no-cond-assign
    while ((match = ghRegex.exec(body)) !== null) {
        const num = Number.parseInt(match[1]!, 10);

        if (Number.isFinite(num) && num > 0) {
            add(num, "issue");
        }
    }

    if (gitlab) {
        // !123 — same left boundary as `#123`, so `group/project!12`
        // (another project's MR) is not taken for a local one.
        const mergeRequestRegex = /(?:^|[\s(,;:?])!(\d+)/g;

        // eslint-disable-next-line no-cond-assign
        while ((match = mergeRequestRegex.exec(body)) !== null) {
            const num = Number.parseInt(match[1]!, 10);

            if (Number.isFinite(num) && num > 0) {
                add(num, "merge_request");
            }
        }
    }

    // Forge URLs — /pull/N (GitHub), /issues/N (both), /-/merge_requests/N
    // (GitLab). The host+path is checked against `repo` so a competitor's
    // URL pasted into a change-file body doesn't get applied locally.
    // We intentionally don't restrict to a specific host so self-hosted
    // GHE / GitLab instances are picked up too — only the path segment
    // (the `owner/name` portion of the URL) needs to match.
    //
    // Capture groups:
    //   [1] host (e.g. `github.com`)
    //   [2] path segment between host and the resource keyword (the
    //       `owner/name` part — empty when the URL has no repo prefix)
    //   [3] resource keyword (`pull` / `issues` / `merge_requests`)
    //   [4] numeric id
    const urlRegex = /https?:\/\/([^\s/]+)\/([^\s)]*?)\/(pull|issues|merge_requests)\/(\d+)/gi;

    // eslint-disable-next-line no-cond-assign
    while ((match = urlRegex.exec(body)) !== null) {
        const num = Number.parseInt(match[4]!, 10);

        if (!(Number.isFinite(num) && num > 0)) {
            continue;
        }

        if (repo) {
            // The URL's path segment is everything between the host and the
            // `/pull/N` (or `/issues/N` or `/merge_requests/N`) tail. GitLab
            // MRs structure the path as `<owner>/<name>/-/merge_requests/N`
            // — strip a trailing `/-` so the comparison against `<owner>/<name>`
            // still works. Trailing/leading slashes trimmed on both sides.
            const pathSegment = (match[2] ?? "").replaceAll(/^\/+|\/+$/g, "").replace(/\/-$/, "");
            const expected = repo.replaceAll(/^\/+|\/+$/g, "");

            if (pathSegment.toLowerCase() !== expected.toLowerCase()) {
                continue;
            }
        }

        add(num, match[3]!.toLowerCase() === "issues" ? "issue" : "merge_request");
    }

    return [...found.values()].sort((a, b) => a.number - b.number || a.target.localeCompare(b.target));
};

/**
 * Extract every PR / issue reference from a rendered changelog body. Both
 * `#123` and `gh-123` forms are accepted; numbers are deduped at the caller.
 *
 * Two guardrails worth pointing out:
 *
 *   1. The `#123` regex is anchored to a non-word boundary on the left to
 *      avoid matching colour hex codes (`color: #ff00ff`), Markdown anchor
 *      links (`[foo](#section)`), and other false positives. Practically:
 *      a `#` only counts when preceded by whitespace, start-of-string, or
 *      a punctuation character.
 *   2. The `gh-` prefix is matched case-insensitively but the captured
 *      number is returned as a plain int — the caller doesn't care which
 *      casing the source used.
 *
 * Forge URLs (`/pull/123`, `/issues/123`, `/-/merge_requests/123`) are also
 * scraped so an entry like
 * `See https://github.com/x/y/pull/45 for details` shows up in the walk.
 *
 * **Cross-repo guardrail:** when `repo` is provided (`"owner/name"`), URL-
 * shaped refs are dropped unless the URL's host+path matches that repo.
 * Otherwise a competitor's PR URL pasted into a change-file body
 * (`https://github.com/competitor/repo/pull/42`) would cause vis to
 * comment on its own repo's #42. Bare refs (`#123`, `gh-123`) are always
 * kept since by convention they refer to the local repo.
 */
export const extractReferences = (body: string, repo?: string): number[] => [
    ...new Set(extractTypedReferences(body, repo, false).map((reference) => reference.number)),
];

/**
 * Expand the comment-body template's tokens. Identical token set to the
 * extra-files applier so users learn one substitution language.
 *
 * F3 fix (audit): when `vars.url` is empty (the common case when the
 * operator opts into `publish.noRelease: true` and no forge release is
 * created), naive `replaceAll` would emit `[GitHub release]()` — a
 * broken markdown link consumers see in their sticky comments.
 *
 * To avoid that, every `{url}` placeholder is first considered in its
 * surrounding markdown-link context: `[&lt;text>]({url})` collapses to
 * `&lt;package>@&lt;version>` plain text when the URL is empty. Remaining
 * bare `{url}` occurrences fall back to the same `name@version` plain
 * text. A non-empty URL flows through exactly as before.
 *
 * `{releases}` is substituted last so a token-like string inside a
 * package name is never expanded a second time.
 */
const expandTemplate = (template: string, vars: SuccessCommentVars & { releases: string }): string => {
    let out = template;

    if (vars.url) {
        out = out.replaceAll("{url}", vars.url);
    } else {
        const fallback = `${vars.name}@${vars.version}`;

        // Collapse `[<text>]({url})` → plain `name@version`. Anchored
        // tightly so unrelated markdown links in the template aren't
        // disturbed.
        out = out.replaceAll(/\[[^\]]*\]\(\{url\}\)/g, fallback);

        // Any leftover bare `{url}` falls back to the same plain text
        // so we never emit an empty parenthesis pair.
        out = out.replaceAll("{url}", fallback);
    }

    return out.replaceAll("{version}", vars.version).replaceAll("{name}", vars.name).replaceAll("{tag}", vars.tag).replaceAll("{releases}", vars.releases);
};

/** Single-release tokens: the current wave's first release of the ref, and its channel. */
export interface SuccessCommentVars {
    name: string;
    tag: string;
    url: string;
    version: string;
}

/**
 * Build the sticky comment for one ref: merge this wave's releases into
 * the history stored in `existingBody` (under `channel`), then re-render
 * the whole comment from that history. Pure, so a re-run over the same
 * wave reproduces `existingBody` byte for byte and the client skips the
 * write.
 *
 * Within a channel a package keeps the first version it shipped the ref
 * in. A comment from before the history block existed counts as empty
 * history and is replaced, as it always was.
 *
 * Stored history is re-validated on every read (see `sanitizeRelease`):
 * a stored release link survives only under `releaseUrlPrefix`, the
 * repository's own releases page; without one, stored links are dropped.
 */
export const renderSuccessComment = (
    existingBody: string | undefined,
    template: string,
    wave: { channel: string; releases: SuccessCommentRelease[] },
    vars: SuccessCommentVars,
    releaseUrlPrefix?: string,
): string => {
    const data = readCommentData(existingBody, releaseUrlPrefix ?? false);
    const channel = CHANNEL.test(wave.channel) ? wave.channel : "";
    const listed = data[channel] ?? [];

    for (const release of wave.releases) {
        const sanitized = sanitizeRelease(release, undefined);

        if (sanitized && !listed.some((entry) => entry.name === sanitized.name)) {
            listed.push(sanitized);
        }
    }

    data[channel] = listed;

    const visible = expandTemplate(template, { ...vars, releases: renderReleases(data) });
    const withMarker = visible.includes(SUCCESS_WALK_MARKER) ? visible : `${SUCCESS_WALK_MARKER}\n${visible}`;
    // `--` would end the HTML comment early; `\u002d` is the same character to JSON.parse.
    const json = JSON.stringify(data).replaceAll("--", String.raw`-\u002d`);

    return `${withMarker}\n\n<!-- vis-release-success-data ${json} -->`;
};

export interface WalkSuccessfulReleaseDeps {
    /** Resolved provider client. Injected so tests don't need network. */
    client: RemoteReleaseClient;
    /** Rendered changelog formatter. */
    formatter: ChangelogFormatter;
    /** Repo slug ("owner/name"); when undefined the walk is a no-op. */
    repo: string | undefined;
}

export interface WalkSuccessfulReleaseResult {
    /** Refs the walk successfully commented on. */
    commented: number[];
    /** Refs the walk successfully labelled. */
    labeled: number[];
    /** Soft-fail warnings — surfaced through plan.warnings by the caller. */
    warnings: string[];
}

/**
 * Resolve the runtime `SuccessWalkConfig` from `context.config.successWalk`.
 * Applies defaults so call-sites don't have to re-derive them.
 */
const resolveConfig = (context: OrchestratorContext): { commentBody: string; enabled: boolean; labels: string[]; skipPrerelease: boolean } => {
    const cfg = context.config.successWalk ?? {};

    return {
        commentBody: cfg.commentBody ?? DEFAULT_SUCCESS_WALK_COMMENT,
        enabled: cfg.enabled !== false,
        labels: cfg.labels ?? DEFAULT_SUCCESS_WALK_LABELS,
        skipPrerelease: cfg.skipPrerelease !== false,
    };
};

/** Every release in the wave that mentions one ref. */
interface CollectedReference extends TypedReference {
    releases: PlannedRelease[];
}

/**
 * Render each published release's changelog body once and collect, per
 * ref, every release that mentions it. The formatter result is
 * target=`github-release` so we don't pull in the `## version` header
 * (the comment template handles version display itself).
 */
const collectReferences = async (
    context: OrchestratorContext,
    result: PublishContextResult,
    formatter: ChangelogFormatter,
    repo: string,
    gitlab: boolean,
): Promise<CollectedReference[]> => {
    const byKey = new Map<string, CollectedReference>();

    const date = new Date().toISOString().slice(0, 10);

    for (const published of result.published) {
        const release = context.plan.releases.find((r) => r.name === published.name);

        if (!release) {
            continue;
        }

        let body: string;

        try {
            body = await formatter({
                changeFiles: release.changeFiles,
                date,
                release,
                target: "github-release",
            });
        } catch {
            // A broken custom formatter shouldn't stop us from walking the
            // remaining releases — just skip this one.
            continue;
        }

        // Also harvest refs directly from the change-file bodies, in case
        // the active formatter strips them (the github formatter, for
        // example, can rewrite `#123` into resolved markdown links). Pass
        // the local `repo` so URL-shaped refs pointing at other repos are
        // dropped (see `extractReferences`).
        const combined = [body, ...release.changeFiles.map((f) => f.body)].join("\n");

        for (const reference of extractTypedReferences(combined, repo, gitlab)) {
            const key = `${reference.target}:${reference.number}`;
            const collected = byKey.get(key) ?? { ...reference, releases: [] };

            collected.releases.push(release);
            byKey.set(key, collected);
        }
    }

    return [...byKey.values()].sort((a, b) => a.number - b.number || a.target.localeCompare(b.target));
};

/**
 * Release page recorded for the package by `createRemoteReleases`
 * (per-package release, or the shared aggregate-release URL), plus its
 * npmjs.com page when it is an npm package on the public registry.
 */
const toCommentRelease = (release: PlannedRelease, context: OrchestratorContext, result: PublishContextResult): SuccessCommentRelease => {
    const url = result.published.find((p) => p.name === release.name)?.url;
    const pkg = context.packages.find((p) => p.name === release.name);
    const registry = pkg?.manifest.publishConfig?.["registry"];
    const onNpm = pkg !== undefined && pkg.ecosystem === undefined && !pkg.private && (typeof registry !== "string" || registry.includes("registry.npmjs.org"));

    return {
        name: release.name,
        npm: onNpm || undefined,
        url: url || undefined,
        version: release.newVersion,
    };
};

/** Where this repository's release pages live, for vetting links read back from a comment. */
const resolveReleaseUrlPrefix = (context: OrchestratorContext, provider: string, repo: string): string | undefined => {
    const host = (provider === "github" ? (context.config.githubHost ?? "github.com") : provider === "gitlab" ? (context.config.gitlabHost ?? "gitlab.com") : undefined)
        ?.replace(/^https?:\/\//i, "")
        .replace(/\/+$/, "");

    if (host === undefined) {
        return undefined;
    }

    return `https://${host}/${repo}/${provider === "gitlab" ? "-/" : ""}releases/`;
};

/**
 * Tiny concurrency limiter — `n` tasks run in flight at a time, the rest
 * queue. Returns a function with the same shape as a promise factory
 * (`() => Promise&lt;T>`), wrapped to enforce the cap.
 *
 * Implemented inline to avoid adding a `p-limit` dep just for this single
 * use site. The two semantics that matter for the walk:
 *
 *   1. The returned promise resolves in submission order (not completion
 *      order) — callers `Promise.all` the wrapped factories and rely on
 *      indexed positions.
 *   2. Rejections propagate via the inner promise; the limiter itself
 *      never throws. This lines up with the existing soft-fail behaviour
 *      where each ref's failure is captured locally and turned into a
 *      `warnings[]` entry.
 *
 * Exported for testability — `__tests__/release/core/success-walk.test.ts`
 * uses it to assert the cap on in-flight workers.
 */
export const pLimit = <T = unknown>(n: number): ((task: () => Promise<T>) => Promise<T>) => {
    let active = 0;
    const queue: (() => void)[] = [];

    const next = (): void => {
        if (active >= n) {
            return;
        }

        const job = queue.shift();

        if (job) {
            active += 1;
            job();
        }
    };

    return (task) =>
        new Promise<T>((resolve, reject) => {
            const onSettled = (): void => {
                active -= 1;
                next();
            };

            const run = (): void => {
                // The reject handler passed to then() captures every rejection;
                // catch-or-return is satisfied by returning the settled chain.
                // eslint-disable-next-line promise/catch-or-return -- rejection handled by the reject handler passed to then()
                task().then(resolve, reject).finally(onSettled);
            };

            queue.push(run);
            next();
        });
};

/**
 * Sleep helper used by the 429 backoff path. Promise-based so callers
 * `await` it inline. The retry layer caps at one retry per call so the
 * worst-case extra latency per ref is one Retry-After header value.
 */
const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Detect whether an error thrown by `RemoteReleaseClient` was a 429 / rate
 * limit. The forge clients today wrap `gh`/`glab` CLI output; the message
 * field is the most reliable signal across both. We also peek at a
 * `status` field for forge-clients that surface fetch-style errors
 * directly (future hardening).
 */
const isRateLimit = (error: unknown): boolean => {
    if (!error || typeof error !== "object") {
        return false;
    }

    const e = error as { message?: unknown; status?: unknown; statusCode?: unknown };

    if (typeof e.status === "number" && e.status === 429) {
        return true;
    }

    if (typeof e.statusCode === "number" && e.statusCode === 429) {
        return true;
    }

    if (typeof e.message === "string") {
        // `gh` surfaces "HTTP 429" in stderr when it hits the rate limit;
        // we also catch the textual "rate limit" phrase for clients that
        // format it differently.
        return /\b429\b|rate[- ]?limit/i.test(e.message);
    }

    return false;
};

/**
 * Extract the `Retry-After` value (seconds) from a thrown error. The forge
 * adapters tuck the header into either `error.retryAfter` (numeric) or a
 * `Retry-After: N` line inside `error.message`. Falls back to the default
 * when neither is present.
 */
const parseRetryAfter = (error: unknown, defaultMs: number): number => {
    if (!error || typeof error !== "object") {
        return defaultMs;
    }

    const e = error as { message?: unknown; retryAfter?: unknown };

    if (typeof e.retryAfter === "number" && Number.isFinite(e.retryAfter) && e.retryAfter >= 0) {
        return Math.round(e.retryAfter * 1000);
    }

    if (typeof e.message === "string") {
        const match = /Retry-After:\s*(\d+)/i.exec(e.message);

        if (match) {
            const seconds = Number.parseInt(match[1]!, 10);

            if (Number.isFinite(seconds) && seconds >= 0) {
                return seconds * 1000;
            }
        }
    }

    return defaultMs;
};

/**
 * Run `op` once. On a 429-style error, sleep for the `Retry-After` header
 * value (or `defaultRetryAfterMs`) and retry exactly once. Any other
 * error or a 429 on the retry attempt propagates to the caller — the
 * existing soft-fail layer turns it into a `warnings[]` entry.
 *
 * Exported for testability — the M-8 regression test injects a fake
 * client that throws a 429 on first call and succeeds on retry.
 */
export const withRateLimitRetry = async <T = unknown>(op: () => Promise<T>, defaultRetryAfterMs = 5000): Promise<T> => {
    try {
        return await op();
    } catch (error) {
        if (!isRateLimit(error)) {
            throw error;
        }

        const delayMs = parseRetryAfter(error, defaultRetryAfterMs);

        await sleep(delayMs);

        return op();
    }
};

/**
 * Walk every PR / issue ref harvested from the published wave's changelogs
 * and (a) post a sticky comment, (b) add the configured labels.
 *
 * Soft-fail semantics: a single bad ref appends a warning but the walk
 * continues. The aggregate result is returned so callers can surface
 * warnings via `plan.warnings`.
 *
 * Concurrency: refs are processed in parallel with a cap of 4 in-flight
 * workers (`pLimit(4)`). Each worker makes up to two forge calls (sticky
 * comment + label) and re-tries each call once on a 429 with the server-
 * supplied `Retry-After` delay. For a wave touching 200 PRs that's at
 * most 50 batches of 8 round-trips, with the rate-limit retry as a
 * safety net.
 *
 * **Default OFF.** The walk only runs when `context.config.successWalk`
 * is explicitly defined AND `enabled !== false`. Leaving `successWalk`
 * undefined is the recommended stance — see `SuccessWalkConfig` docstring.
 */
export const walkSuccessfulRelease = async (
    context: OrchestratorContext,
    result: PublishContextResult,
    runner: CommandRunner,
    deps: WalkSuccessfulReleaseDeps,
): Promise<WalkSuccessfulReleaseResult> => {
    const out: WalkSuccessfulReleaseResult = { commented: [], labeled: [], warnings: [] };

    // C-1 gate: never apply sticky comments / labels to third-party PRs
    // by accident. The walk is opt-in — operators must explicitly
    // configure `successWalk` (even an empty `{}` is fine) to enable it.
    if (context.config.successWalk === undefined) {
        return out;
    }

    const cfg = resolveConfig(context);

    if (!cfg.enabled) {
        return out;
    }

    // Bail on prerelease channels by default — the typical case is "don't
    // notify users their PR shipped in a beta before stable". The
    // skip-prerelease guard inspects both the channel's prerelease marker
    // and the published versions themselves (-rc / -alpha / etc.) so the
    // guardrail still kicks in when a release was prereleased without a
    // channel having been declared.
    const isPrerelease = Boolean(context.channel?.prerelease) || result.published.some((p) => p.version.includes("-"));

    if (cfg.skipPrerelease && isPrerelease) {
        return out;
    }

    if (!deps.repo) {
        return out;
    }

    const references = await collectReferences(context, result, deps.formatter, deps.repo, deps.client.id === "gitlab");

    if (references.length === 0) {
        return out;
    }

    const channelTag = context.channel?.tag ?? "";
    const releaseUrlPrefix = resolveReleaseUrlPrefix(context, deps.client.id, deps.repo);
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- pLimit's type parameter is the task return type; these tasks resolve to void.
    const limit = pLimit<void>(4);

    const tasks = references.map(({ number: ref, releases, target }) =>
        limit(async () => {
            const wave = { channel: channelTag, releases: releases.map((release) => toCommentRelease(release, context, result)) };
            const first = wave.releases[0]!;
            const vars = { name: first.name, tag: channelTag, url: first.url ?? "", version: first.version };
            const render = (existingBody?: string): string => renderSuccessComment(existingBody, cfg.commentBody, wave, vars, releaseUrlPrefix);

            // 1. Sticky comment. `merge` folds this wave into the history the
            //    existing comment carries, so earlier channels keep their lines.
            try {
                const upsert = await withRateLimitRetry(() =>
                    deps.client.upsertStickyComment(runner, {
                        body: render(),
                        cwd: context.cwd,
                        issueNumber: ref,
                        marker: SUCCESS_WALK_MARKER,
                        merge: render,
                        repo: deps.repo as string,
                        target,
                    }),
                );

                if (upsert) {
                    out.commented.push(ref);
                } else {
                    out.warnings.push(`successWalk: upsertStickyComment returned undefined for #${ref}; skipping label step.`);

                    return;
                }
            } catch (error) {
                out.warnings.push(`successWalk: failed to comment on #${ref}: ${(error as Error).message}`);

                return;
            }

            // 2. Labels. Empty `labels: []` is a valid config — skip the call
            //    entirely so we don't waste a round-trip.
            if (cfg.labels.length === 0) {
                return;
            }

            try {
                const ok = await withRateLimitRetry(() =>
                    deps.client.addLabels(runner, {
                        cwd: context.cwd,
                        issueNumber: ref,
                        labels: cfg.labels,
                        repo: deps.repo as string,
                        target,
                    }),
                );

                if (ok) {
                    out.labeled.push(ref);
                } else {
                    out.warnings.push(`successWalk: addLabels returned false for #${ref}; the labels may not have been applied.`);
                }
            } catch (error) {
                out.warnings.push(`successWalk: failed to label #${ref}: ${(error as Error).message}`);
            }
        }),
    );

    await Promise.all(tasks);

    // Sort the result arrays so test/observation order is deterministic
    // (parallel execution scrambles the natural insertion order).
    out.commented.sort((a, b) => a - b);
    out.labeled.sort((a, b) => a - b);

    return out;
};
