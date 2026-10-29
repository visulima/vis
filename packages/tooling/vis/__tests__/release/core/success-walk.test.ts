/**
 * Coverage for the post-release "success walk" — the semantic-release
 * `successComment` + `releasedLabels` orchestrator that runs after a
 * publish wave to comment + label every referenced PR / issue.
 */

import { describe, expect, it } from "vitest";

import { DependencyGraph } from "../../../src/release/core/dep-graph";
import type { OrchestratorContext, PublishContextResult } from "../../../src/release/core/orchestrator";
import type { CommandRunner } from "../../../src/release/core/package-managers/interface";
import type { RemoteReleaseClient } from "../../../src/release/core/remote/interface";
import {
    DEFAULT_SUCCESS_WALK_COMMENT,
    DEFAULT_SUCCESS_WALK_LABELS,
    extractReferences,
    extractTypedReferences,
    pLimit,
    renderSuccessComment,
    SUCCESS_WALK_MARKER,
    walkSuccessfulRelease,
    withRateLimitRetry,
} from "../../../src/release/core/success-walk";
import type { ChangeFile, PlannedRelease, WorkspacePackage } from "../../../src/release/types";

const noopRunner: CommandRunner = {
    run: async () => {
        return { exitCode: 0, stderr: "", stdout: "" };
    },
};

interface CommentCall {
    body: string;
    issueNumber: number;
    target?: string;
}

interface LabelCall {
    issueNumber: number;
    labels: string[];
    target?: string;
}

interface MockClient {
    addLabelsCalls: LabelCall[];
    client: RemoteReleaseClient;
    commentCalls: CommentCall[];
}

interface MockClientOptions {
    addLabelsFail?: (issueNumber: number) => boolean;
    addLabelsResult?: boolean;
    id?: string;

    /** Forge-side comment bodies by issue number; when set, `merge` is applied like the real clients do. */
    store?: Map<number, string>;
    upsertCommentFail?: (issueNumber: number) => boolean;
    upsertCommentResult?: { created: boolean; id: number };
}

const buildMockClient = (options: MockClientOptions = {}): MockClient => {
    const commentCalls: CommentCall[] = [];
    const addLabelsCalls: LabelCall[] = [];

    const client: RemoteReleaseClient = {
        addLabels: async (_runner, args) => {
            addLabelsCalls.push({ issueNumber: args.issueNumber, labels: args.labels, target: args.target });

            if (options.addLabelsFail?.(args.issueNumber)) {
                throw new Error(`addLabels boom for #${args.issueNumber}`);
            }

            return options.addLabelsResult ?? true;
        },
        closeIssue: async () => true,
        createRelease: async () => {
            return { url: "" };
        },
        detectPullRequestNumber: () => undefined,
        detectRepoSlug: async () => "owner/repo",
        id: options.id ?? "test",
        listRecentReleases: async () => [],
        upsertIssue: async () => {
            return { created: false, number: 0 };
        },
        upsertPullRequest: async () => {
            return { existing: false, number: 0 };
        },
        upsertStickyComment: async (_runner, args) => {
            const existing = options.store?.get(args.issueNumber);
            const body = existing !== undefined && args.merge ? args.merge(existing) : args.body;

            options.store?.set(args.issueNumber, body);
            commentCalls.push({ body, issueNumber: args.issueNumber, target: args.target });

            if (options.upsertCommentFail?.(args.issueNumber)) {
                throw new Error(`upsertStickyComment boom for #${args.issueNumber}`);
            }

            return options.upsertCommentResult ?? { created: true, id: args.issueNumber * 1000 };
        },
    };

    return { addLabelsCalls, client, commentCalls };
};

const mkRelease = (name: string, version: string, bodies: string[] = []): PlannedRelease => {
    const changeFiles: ChangeFile[] = bodies.map((body, index) => {
        return {
            body,
            id: `${name}-${index}`,
            path: `${name}-${index}.md`,
            payload: { bump: "minor", package: name },
        };
    });

    return {
        changeFiles,
        isCascadeBump: false,
        isDependencyBump: false,
        isGroupBump: false,
        name,
        newVersion: version,
        oldVersion: "0.0.1",
        reasons: ["EXPLICIT"],
        sources: [],
        type: "minor",
    };
};

/**
 * Build a fresh `OrchestratorContext` for tests. By default the walk is
 * **opted in** with `successWalk: {}` so every existing assertion that
 * exercises the comment/label path keeps working. Tests that want the
 * default-off behaviour (C-1) pass `config: {}` (or omit `successWalk`).
 */
const mkContext = (overrides: Partial<OrchestratorContext> = {}, releases: PlannedRelease[] = []): OrchestratorContext => {
    return {
        branch: "main",
        channel: { mode: "auto-publish", tag: "latest" },
        config: { successWalk: {} },
        cwd: "/r",
        depGraph: new DependencyGraph([]),
        firstRelease: false,
        packages: [],
        perPackageConfig: new Map(),
        plan: { consumedChangeFiles: [], releases, warnings: [] },
        pm: { id: "pnpm" } as never,
        ...overrides,
    };
};

const mkResult = (published: { name: string; url?: string; version: string }[]): PublishContextResult => {
    return {
        failed: [],
        published: published.map((p) => {
            return { name: p.name, url: p.url, version: p.version };
        }),
        skipped: [],
        tags: [],
        tagsPushed: true,
    };
};

/** Bypass the formatter and rely on raw change-file bodies for ref extraction. */
const noopFormatter = async () => "";

describe(extractReferences, () => {
    it("picks up bare `#123` references", () => {
        expect.hasAssertions();
        expect(extractReferences("Closes #123 and #456.")).toStrictEqual([123, 456]);
    });

    it("picks up `gh-123` (case-insensitive) references", () => {
        expect.hasAssertions();
        expect(extractReferences("Resolves gh-7 and GH-12 and Gh-9.")).toStrictEqual([7, 9, 12]);
    });

    it("picks up forge URLs (/pull/N, /issues/N, /-/merge_requests/N) when no repo gate is supplied", () => {
        expect.hasAssertions();

        const body = `
            See https://github.com/x/y/pull/45 and
            https://gitlab.com/x/y/-/merge_requests/77
            and https://github.com/x/y/issues/100 for context.`;

        expect(extractReferences(body)).toStrictEqual([45, 77, 100]);
    });

    it("deduplicates references appearing multiple times", () => {
        expect.hasAssertions();
        expect(extractReferences("#42 and #42 again, and gh-42 too")).toStrictEqual([42]);
    });

    it("does not match colour hex codes like #ff00ff", () => {
        expect.hasAssertions();
        expect(extractReferences("color: #ff00ff;")).toStrictEqual([]);
    });

    it("ignores numbers without a # prefix", () => {
        expect.hasAssertions();
        expect(extractReferences("version 123.456 is shipped")).toStrictEqual([]);
    });

    // ── M-9 regression: URL refs pointing at a different repo must be
    //    dropped to avoid cross-repo comments on local issue numbers.
    describe("m-9 — cross-repo URL guard", () => {
        it("drops URL refs pointing at a different repo", () => {
            // `#42` in a competitor's URL must not get applied locally.
            expect.hasAssertions();
            expect(extractReferences("See https://github.com/competitor/repo/pull/42 for context", "owner/repo")).toStrictEqual([]);
        });

        it("keeps URL refs that match the local repo", () => {
            expect.hasAssertions();
            expect(extractReferences("See https://github.com/owner/repo/pull/42 for context", "owner/repo")).toStrictEqual([42]);
        });

        it("keeps GitLab URLs (`-/merge_requests/N`) that match the local repo", () => {
            expect.hasAssertions();
            expect(extractReferences("See https://gitlab.com/owner/repo/-/merge_requests/77", "owner/repo")).toStrictEqual([77]);
        });

        it("keeps bare `#123` refs even when a cross-repo URL is present", () => {
            // Bare refs always apply locally by convention. The URL pointing
            // at competitor/repo is dropped, but `#7` is kept.
            expect.hasAssertions();

            const body = "Closes #7. See https://github.com/competitor/repo/pull/42 for prior art.";

            expect(extractReferences(body, "owner/repo")).toStrictEqual([7]);
        });

        it("keeps bare `gh-123` refs even when a cross-repo URL is present", () => {
            expect.hasAssertions();

            const body = "Resolves gh-9. Compare https://github.com/competitor/repo/issues/100.";

            expect(extractReferences(body, "owner/repo")).toStrictEqual([9]);
        });

        it("treats the repo comparison as case-insensitive (GitHub repo slugs are too)", () => {
            expect.hasAssertions();
            expect(extractReferences("See https://github.com/Owner/Repo/pull/42", "owner/repo")).toStrictEqual([42]);
        });

        it("drops a URL whose path partially overlaps but doesn't match exactly", () => {
            // `owner/repo-other` must not match `owner/repo`.
            expect.hasAssertions();
            expect(extractReferences("See https://github.com/owner/repo-other/pull/42", "owner/repo")).toStrictEqual([]);
        });
    });
});

describe(walkSuccessfulRelease, () => {
    it("extracts PR refs from a changelog body and posts a sticky comment per ref", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const release = mkRelease("@scope/pkg", "1.2.0", ["Closes #100 and #200."]);
        const context = mkContext({}, [release]);
        const result = mkResult([{ name: "@scope/pkg", url: "https://example/release", version: "1.2.0" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(commentCalls).toHaveLength(2);
        expect(commentCalls.map((c) => c.issueNumber).sort()).toStrictEqual([100, 200]);
        expect(commentCalls[0]!.body).toContain(SUCCESS_WALK_MARKER);
    });

    it("dedupes references across multiple packages in the wave", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const releases = [mkRelease("@scope/a", "1.0.0", ["See #42."]), mkRelease("@scope/b", "2.0.0", ["See #42 and #43."])];
        const context = mkContext({}, releases);
        const result = mkResult([
            { name: "@scope/a", version: "1.0.0" },
            { name: "@scope/b", version: "2.0.0" },
        ]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        // #42 should only be commented on once even though it appears in
        // two packages' change-file bodies.
        const refs = commentCalls.map((c) => c.issueNumber).sort();

        expect(refs).toStrictEqual([42, 43]);
    });

    it("adds the configured labels via client.addLabels", async () => {
        expect.hasAssertions();

        const { addLabelsCalls, client } = buildMockClient();
        const context = mkContext(
            {
                config: { successWalk: { labels: ["released", "shipped"] } },
            },
            [mkRelease("@scope/pkg", "1.0.0", ["Closes #1."])],
        );
        const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(addLabelsCalls).toStrictEqual([{ issueNumber: 1, labels: ["released", "shipped"], target: "issue" }]);
    });

    it("uses default `[\"released\"]` labels when not configured", async () => {
        expect.hasAssertions();

        const { addLabelsCalls, client } = buildMockClient();
        const context = mkContext({}, [mkRelease("@scope/pkg", "1.0.0", ["#5"])]);
        const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(addLabelsCalls[0]!.labels).toStrictEqual(DEFAULT_SUCCESS_WALK_LABELS);
        expect(DEFAULT_SUCCESS_WALK_LABELS).toStrictEqual(["released"]);
    });

    it("skips the walk entirely on prerelease channels by default", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const context = mkContext({ channel: { mode: "auto-publish", prerelease: "beta", tag: "beta" } }, [
            mkRelease("@scope/pkg", "1.0.0-beta.1", ["Closes #99."]),
        ]);
        const result = mkResult([{ name: "@scope/pkg", version: "1.0.0-beta.1" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(commentCalls).toHaveLength(0);
    });

    it("honours `skipPrerelease: false` to walk prerelease channels", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const context = mkContext(
            {
                channel: { mode: "auto-publish", prerelease: "beta", tag: "beta" },
                config: { successWalk: { skipPrerelease: false } },
            },
            [mkRelease("@scope/pkg", "1.0.0-beta.1", ["Closes #99."])],
        );
        const result = mkResult([{ name: "@scope/pkg", version: "1.0.0-beta.1" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(commentCalls).toHaveLength(1);
        expect(commentCalls[0]!.issueNumber).toBe(99);
    });

    it("soft-fails a single bad ref without aborting the rest", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient({
            upsertCommentFail: (n) => n === 100,
        });
        const release = mkRelease("@scope/pkg", "1.0.0", ["Closes #100 and #200."]);
        const context = mkContext({}, [release]);
        const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

        const out = await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        // #100 attempted, #200 succeeded
        expect(commentCalls).toHaveLength(2);
        expect(out.commented).toStrictEqual([200]);
        expect(out.warnings.some((w) => w.includes("#100"))).toBe(true);
    });

    it("renders `{version}` / `{name}` / `{tag}` in the comment template", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const context = mkContext(
            {
                channel: { mode: "auto-publish", tag: "latest" },
                config: {
                    successWalk: {
                        commentBody: "tag={tag} version={version} name={name}",
                    },
                },
            },
            [mkRelease("@scope/pkg", "1.2.3", ["Closes #1."])],
        );
        const result = mkResult([{ name: "@scope/pkg", version: "1.2.3" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(commentCalls[0]!.body).toContain("tag=latest");
        expect(commentCalls[0]!.body).toContain("version=1.2.3");
        expect(commentCalls[0]!.body).toContain("name=@scope/pkg");
        // Marker is auto-prepended for the upsert path even on custom templates.
        expect(commentCalls[0]!.body).toContain(SUCCESS_WALK_MARKER);
    });

    it("substitutes `{url}` when a release URL was recorded by createRemoteReleases", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const context = mkContext({ config: { successWalk: { commentBody: "url={url}" } } }, [mkRelease("@scope/pkg", "1.0.0", ["#7"])]);
        const result = mkResult([{ name: "@scope/pkg", url: "https://github.com/owner/repo/releases/tag/v1.0.0", version: "1.0.0" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(commentCalls[0]!.body).toContain("url=https://github.com/owner/repo/releases/tag/v1.0.0");
    });

    it("returns early (no walk) when `enabled: false`", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const context = mkContext({ config: { successWalk: { enabled: false } } }, [mkRelease("@scope/pkg", "1.0.0", ["Closes #1."])]);
        const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(commentCalls).toHaveLength(0);
    });

    it("returns early when `repo` is undefined (no remote detected)", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const context = mkContext({}, [mkRelease("@scope/pkg", "1.0.0", ["#1"])]);
        const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: undefined,
        });

        expect(commentCalls).toHaveLength(0);
    });

    it("skips the label call when configured `labels: []`", async () => {
        expect.hasAssertions();

        const { addLabelsCalls, client, commentCalls } = buildMockClient();
        const context = mkContext({ config: { successWalk: { labels: [] } } }, [mkRelease("@scope/pkg", "1.0.0", ["#9"])]);
        const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(commentCalls).toHaveLength(1);
        expect(addLabelsCalls).toHaveLength(0);
    });

    it("uses the default comment template when none is configured", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const context = mkContext({}, [mkRelease("@scope/pkg", "9.9.9", ["Closes #11."])]);
        const result = mkResult([{ name: "@scope/pkg", url: "https://example/r", version: "9.9.9" }]);

        await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        // The default template references the version + URL; without doing
        // exact-string equality we just make sure both made it in.
        expect(commentCalls[0]!.body).toContain("9.9.9");
        expect(commentCalls[0]!.body).toContain("https://example/r");
        expect(DEFAULT_SUCCESS_WALK_COMMENT).toContain(SUCCESS_WALK_MARKER);
    });

    it("soft-fails a single bad label call without aborting the rest", async () => {
        expect.hasAssertions();

        const { addLabelsCalls, client } = buildMockClient({
            addLabelsFail: (n) => n === 1,
        });
        const release = mkRelease("@scope/pkg", "1.0.0", ["Closes #1 and #2."]);
        const context = mkContext({}, [release]);
        const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

        const out = await walkSuccessfulRelease(context, result, noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "owner/repo",
        });

        expect(addLabelsCalls).toHaveLength(2);
        expect(out.labeled).toStrictEqual([2]);
        expect(out.warnings.some((w) => w.includes("#1"))).toBe(true);
    });

    // ── C-1 regression: `successWalk` must be explicitly opted in. A
    //    workspace that never configures it must NOT have vis touch
    //    third-party PRs referenced in changelog bodies. ─────────────────
    describe("c-1 — default OFF when `successWalk` is undefined", () => {
        it("is a no-op when `config.successWalk` is `undefined`", async () => {
            expect.hasAssertions();

            const { addLabelsCalls, client, commentCalls } = buildMockClient();
            // Override the helper default (`{}`) back to explicit "not set".
            const context = mkContext({ config: {} }, [mkRelease("@scope/pkg", "1.0.0", ["Closes #1 and #2."])]);
            const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

            const out = await walkSuccessfulRelease(context, result, noopRunner, {
                client,
                formatter: noopFormatter,
                repo: "owner/repo",
            });

            expect(commentCalls).toStrictEqual([]);
            expect(addLabelsCalls).toStrictEqual([]);
            expect(out).toStrictEqual({ commented: [], labeled: [], warnings: [] });
        });

        it("walks when `config.successWalk` is an empty object (opt-in with defaults)", async () => {
            // Sanity-check the other half of the gate: `{}` opts in.
            expect.hasAssertions();

            const { client, commentCalls } = buildMockClient();
            const context = mkContext({ config: { successWalk: {} } }, [mkRelease("@scope/pkg", "1.0.0", ["Closes #1."])]);
            const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

            await walkSuccessfulRelease(context, result, noopRunner, {
                client,
                formatter: noopFormatter,
                repo: "owner/repo",
            });

            expect(commentCalls).toHaveLength(1);
        });
    });

    // ── M-8 regression: concurrency cap + 429 retry. ──────────────────
    describe("m-8 — concurrency limit + 429 retry", () => {
        it("caps in-flight upsert calls at 4 even when 20 refs are processed", async () => {
            expect.hasAssertions();

            let active = 0;
            let peak = 0;

            const slowClient: RemoteReleaseClient = {
                addLabels: async () => true,
                closeIssue: async () => true,
                createRelease: async () => {
                    return { url: "" };
                },
                detectPullRequestNumber: () => undefined,
                detectRepoSlug: async () => "owner/repo",
                id: "test",
                listRecentReleases: async () => [],
                upsertIssue: async () => {
                    return { created: false, number: 0 };
                },
                upsertPullRequest: async () => {
                    return { existing: false, number: 0 };
                },
                upsertStickyComment: async (_runner, args) => {
                    active += 1;
                    peak = Math.max(peak, active);
                    // Yield a few microtasks so concurrent submissions actually
                    // overlap (otherwise the test sees each call complete
                    // before the next one starts).
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, 5);
                    });
                    active -= 1;

                    return { created: true, id: args.issueNumber * 1000 };
                },
            };

            // 20 refs ⇒ 20 upsert + 20 label calls. With a 4-wide limiter
            // the upsert peak should never exceed 4.
            const body = Array.from({ length: 20 }, (_, i) => `#${i + 1}`).join(" ");
            const context = mkContext({}, [mkRelease("@scope/pkg", "1.0.0", [body])]);
            const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

            await walkSuccessfulRelease(context, result, noopRunner, {
                client: slowClient,
                formatter: noopFormatter,
                repo: "owner/repo",
            });

            expect(peak).toBeLessThanOrEqual(4);
            // Sanity: we did actually parallelise, not just run serially.
            expect(peak).toBeGreaterThan(1);
        });

        it("retries a 429-failed upsert once after the Retry-After delay", async () => {
            expect.hasAssertions();

            let attempts = 0;

            const flakyClient: RemoteReleaseClient = {
                addLabels: async () => true,
                closeIssue: async () => true,
                createRelease: async () => {
                    return { url: "" };
                },
                detectPullRequestNumber: () => undefined,
                detectRepoSlug: async () => "owner/repo",
                id: "test",
                listRecentReleases: async () => [],
                upsertIssue: async () => {
                    return { created: false, number: 0 };
                },
                upsertPullRequest: async () => {
                    return { existing: false, number: 0 };
                },
                upsertStickyComment: async (_runner, args) => {
                    attempts += 1;

                    if (attempts === 1) {
                        // First call: simulate a `gh` 429 surface with an
                        // explicit Retry-After hint (very small so the test
                        // doesn't take forever).
                        throw new Error("HTTP 429: API rate limit exceeded\nRetry-After: 0");
                    }

                    return { created: true, id: args.issueNumber * 1000 };
                },
            };

            const context = mkContext({}, [mkRelease("@scope/pkg", "1.0.0", ["Closes #1."])]);
            const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

            const out = await walkSuccessfulRelease(context, result, noopRunner, {
                client: flakyClient,
                formatter: noopFormatter,
                repo: "owner/repo",
            });

            // First call failed, second succeeded.
            expect(attempts).toBe(2);
            expect(out.commented).toStrictEqual([1]);
            // No warning was recorded — the retry was successful.
            expect(out.warnings).toStrictEqual([]);
        });

        it("gives up after one 429 retry and records a warning", async () => {
            expect.hasAssertions();

            const persistentClient: RemoteReleaseClient = {
                addLabels: async () => true,
                closeIssue: async () => true,
                createRelease: async () => {
                    return { url: "" };
                },
                detectPullRequestNumber: () => undefined,
                detectRepoSlug: async () => "owner/repo",
                id: "test",
                listRecentReleases: async () => [],
                upsertIssue: async () => {
                    return { created: false, number: 0 };
                },
                upsertPullRequest: async () => {
                    return { existing: false, number: 0 };
                },
                upsertStickyComment: async () => {
                    throw new Error("HTTP 429: rate limit hit again\nRetry-After: 0");
                },
            };

            const context = mkContext({}, [mkRelease("@scope/pkg", "1.0.0", ["Closes #1."])]);
            const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

            const out = await walkSuccessfulRelease(context, result, noopRunner, {
                client: persistentClient,
                formatter: noopFormatter,
                repo: "owner/repo",
            });

            expect(out.commented).toStrictEqual([]);
            expect(out.warnings.some((w) => w.includes("#1") && /429|rate/i.test(w))).toBe(true);
        });

        it("does NOT retry non-429 errors (preserves soft-fail behaviour)", async () => {
            expect.hasAssertions();

            let attempts = 0;
            const grumpyClient: RemoteReleaseClient = {
                addLabels: async () => true,
                closeIssue: async () => true,
                createRelease: async () => {
                    return { url: "" };
                },
                detectPullRequestNumber: () => undefined,
                detectRepoSlug: async () => "owner/repo",
                id: "test",
                listRecentReleases: async () => [],
                upsertIssue: async () => {
                    return { created: false, number: 0 };
                },
                upsertPullRequest: async () => {
                    return { existing: false, number: 0 };
                },
                upsertStickyComment: async () => {
                    attempts += 1;

                    throw new Error("HTTP 500: server exploded");
                },
            };

            const context = mkContext({}, [mkRelease("@scope/pkg", "1.0.0", ["Closes #1."])]);
            const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

            const out = await walkSuccessfulRelease(context, result, noopRunner, {
                client: grumpyClient,
                formatter: noopFormatter,
                repo: "owner/repo",
            });

            // Only one attempt — non-429 errors are not retried.
            expect(attempts).toBe(1);
            expect(out.warnings.some((w) => w.includes("#1") && /500/.test(w))).toBe(true);
        });
    });

    // ── M-9 regression at the walk level: cross-repo URLs in change-file
    //    bodies must not produce comment / label calls. ─────────────────
    describe("m-9 — cross-repo URL refs are dropped during the walk", () => {
        it("does not comment on a #N from a competitor's URL", async () => {
            expect.hasAssertions();

            const { addLabelsCalls, client, commentCalls } = buildMockClient();
            const body = "Closes https://github.com/competitor/repo/pull/42.";
            const context = mkContext({}, [mkRelease("@scope/pkg", "1.0.0", [body])]);
            const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

            await walkSuccessfulRelease(context, result, noopRunner, {
                client,
                formatter: noopFormatter,
                repo: "owner/repo",
            });

            expect(commentCalls).toStrictEqual([]);
            expect(addLabelsCalls).toStrictEqual([]);
        });

        it("comments on a same-repo URL ref and skips a same-body cross-repo URL", async () => {
            expect.hasAssertions();

            const { client, commentCalls } = buildMockClient();
            const body = "Same-repo: https://github.com/owner/repo/pull/10. Competitor: https://github.com/competitor/repo/pull/42.";
            const context = mkContext({}, [mkRelease("@scope/pkg", "1.0.0", [body])]);
            const result = mkResult([{ name: "@scope/pkg", version: "1.0.0" }]);

            await walkSuccessfulRelease(context, result, noopRunner, {
                client,
                formatter: noopFormatter,
                repo: "owner/repo",
            });

            expect(commentCalls.map((c) => c.issueNumber).sort()).toStrictEqual([10]);
        });
    });
});

// ── Unit coverage for the inline helpers — invoked directly by the walk
//    but useful to validate in isolation so regressions surface fast. ──
describe(pLimit, () => {
    it("never runs more than `n` tasks in flight", async () => {
        expect.hasAssertions();

        let active = 0;
        let peak = 0;
        const limit = pLimit<number>(3);

        const tasks = Array.from({ length: 20 }, (_, i) =>
            limit(async () => {
                active += 1;
                peak = Math.max(peak, active);
                // Yield to other awaiters so concurrent tasks actually overlap.
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 2);
                });
                active -= 1;

                return i;
            }));

        const results = await Promise.all(tasks);

        expect(peak).toBeLessThanOrEqual(3);
        // Sanity-check that *some* parallelism happened.
        expect(peak).toBeGreaterThan(1);
        expect(results).toStrictEqual(Array.from({ length: 20 }, (_, i) => i));
    });

    it("propagates rejections without crashing the limiter", async () => {
        expect.hasAssertions();

        const limit = pLimit<number>(2);

        const tasks = [
            limit(async () => 1),
            limit(async () => {
                throw new Error("boom");
            }),
            limit(async () => 3),
        ];

        const settled = await Promise.allSettled(tasks);

        expect(settled[0]).toStrictEqual({ status: "fulfilled", value: 1 });
        expect(settled[1]!.status).toBe("rejected");
        expect(settled[2]).toStrictEqual({ status: "fulfilled", value: 3 });
    });
});

describe(withRateLimitRetry, () => {
    it("returns the value on first success without sleeping", async () => {
        expect.hasAssertions();

        const before = Date.now();
        const value = await withRateLimitRetry(async () => "ok");

        expect(value).toBe("ok");
        // Should be near-instant.
        expect(Date.now() - before).toBeLessThan(50);
    });

    it("retries once on a 429-tagged error and returns the second result", async () => {
        expect.hasAssertions();

        let attempts = 0;
        const value = await withRateLimitRetry(async () => {
            attempts += 1;

            if (attempts === 1) {
                throw new Error("HTTP 429: try again\nRetry-After: 0");
            }

            return "ok";
        });

        expect(value).toBe("ok");
        expect(attempts).toBe(2);
    });

    it("does not retry non-429 errors", async () => {
        expect.hasAssertions();

        let attempts = 0;

        await expect(
            withRateLimitRetry(async () => {
                attempts += 1;

                throw new Error("HTTP 500: server exploded");
            }),
        ).rejects.toThrow(/500/);

        expect(attempts).toBe(1);
    });

    it("only retries once — a second 429 propagates", async () => {
        expect.hasAssertions();

        let attempts = 0;

        await expect(
            withRateLimitRetry(async () => {
                attempts += 1;

                throw new Error("HTTP 429: still over the limit\nRetry-After: 0");
            }),
        ).rejects.toThrow(/429/);

        // 1 initial + 1 retry = 2 attempts.
        expect(attempts).toBe(2);
    });
});

const mkPackage = (name: string, extra: Partial<WorkspacePackage> = {}): WorkspacePackage => {
    return {
        dir: `/r/${name}`,
        manifest: { name, version: "0.0.1" },
        manifestPath: `/r/${name}/package.json`,
        name,
        private: false,
        version: "0.0.1",
        ...extra,
    };
};

describe("successWalk — one comment per ref lists every package it shipped in", () => {
    it("lists all packages of the wave that mention the ref, with release and npm links", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const releases = [
            mkRelease("@lunora/a", "1.0.0", ["feat(a): x (#42)"]),
            mkRelease("@lunora/b", "2.0.0", ["feat(b): x (#42)"]),
            mkRelease("lunora-crate", "0.3.0", ["feat(crate): x (#42)"]),
        ];
        const context = mkContext({ packages: [mkPackage("@lunora/a"), mkPackage("@lunora/b"), mkPackage("lunora-crate", { ecosystem: "cargo" })] }, releases);
        const result = mkResult([
            { name: "@lunora/a", url: "https://github.com/o/r/releases/tag/a", version: "1.0.0" },
            { name: "@lunora/b", version: "2.0.0" },
            { name: "lunora-crate", version: "0.3.0" },
        ]);

        await walkSuccessfulRelease(context, result, noopRunner, { client, formatter: noopFormatter, repo: "o/r" });

        expect(commentCalls).toHaveLength(1);

        const { body } = commentCalls[0]!;

        expect(body).toContain("- [`@lunora/a@1.0.0`](https://github.com/o/r/releases/tag/a) · [npm](https://www.npmjs.com/package/@lunora/a/v/1.0.0)");
        expect(body).toContain("- `@lunora/b@2.0.0` · [npm](https://www.npmjs.com/package/@lunora/b/v/2.0.0)");
        // Not an npm package — no npm link.
        expect(body).toContain("- `lunora-crate@0.3.0`\n");
        expect(body).toContain("**latest**");
    });

    it("renders `{releases}` and keeps `{name}` / `{version}` / `{url}` on the first package", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const releases = [mkRelease("@s/a", "1.0.0", ["#1"]), mkRelease("@s/b", "1.1.0", ["#1"])];
        const context = mkContext({ config: { successWalk: { commentBody: "first={name}@{version} url={url}\n{releases}" } } }, releases);
        const result = mkResult([
            { name: "@s/a", url: "https://rel/a", version: "1.0.0" },
            { name: "@s/b", version: "1.1.0" },
        ]);

        await walkSuccessfulRelease(context, result, noopRunner, { client, formatter: noopFormatter, repo: "o/r" });

        const { body } = commentCalls[0]!;

        expect(body).toContain("first=@s/a@1.0.0 url=https://rel/a");
        expect(body).toContain("**latest**\n\n- [`@s/a@1.0.0`](https://rel/a)\n- `@s/b@1.1.0`");
    });

    it("collapses a channel listing more than 10 packages into a <details> block", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const releases = Array.from({ length: 11 }, (_, index) => mkRelease(`@s/p${String(index).padStart(2, "0")}`, "1.0.0", ["#9"]));
        const context = mkContext({}, releases);
        const result = mkResult(releases.map((r) => { return { name: r.name, version: r.newVersion }; }));

        await walkSuccessfulRelease(context, result, noopRunner, { client, formatter: noopFormatter, repo: "o/r" });

        expect(commentCalls[0]!.body).toContain("<details>\n<summary>11 packages</summary>\n\n- `@s/p00@1.0.0`");
    });
});

describe("successWalk — npm links only for the public registry", () => {
    it("matches the publishConfig registry host exactly", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        const registries: Record<string, string> = {
            "@s/a": "https://registry.npmjs.org/",
            "@s/b": "https://registry.npmjs.org.evil.example/",
            "@s/c": "https://evil.example/registry.npmjs.org",
            "@s/d": "http://registry.npmjs.org/",
        };
        const names = Object.keys(registries);
        const packages = names.map((name) => mkPackage(name, { manifest: { name, publishConfig: { registry: registries[name] }, version: "0.0.1" } }));
        const releases = names.map((name) => mkRelease(name, "1.0.0", ["#5"]));

        await walkSuccessfulRelease(mkContext({ packages }, releases), mkResult(names.map((name) => { return { name, version: "1.0.0" }; })), noopRunner, {
            client,
            formatter: noopFormatter,
            repo: "o/r",
        });

        const { body } = commentCalls[0]!;

        expect(body).toContain("- `@s/a@1.0.0` · [npm]");
        expect(body).toContain("- `@s/b@1.0.0`\n- `@s/c@1.0.0`\n- `@s/d@1.0.0`\n");
    });
});

describe("successWalk — comment accumulates per channel", () => {
    it("keeps the alpha section when the PR later ships on latest", async () => {
        expect.hasAssertions();

        const store = new Map<number, string>();
        const { client } = buildMockClient({ store });

        await walkSuccessfulRelease(
            mkContext({ channel: { mode: "auto-publish", prerelease: "alpha", tag: "alpha" }, config: { successWalk: { skipPrerelease: false } } }, [
                mkRelease("@s/a", "1.0.0-alpha.3", ["fix: y (#7)"]),
            ]),
            mkResult([{ name: "@s/a", version: "1.0.0-alpha.3" }]),
            noopRunner,
            { client, formatter: noopFormatter, repo: "o/r" },
        );
        await walkSuccessfulRelease(
            mkContext({ channel: { mode: "auto-publish", tag: "latest" } }, [mkRelease("@s/a", "1.0.0", ["fix: y (#7)"])]),
            mkResult([{ name: "@s/a", version: "1.0.0" }]),
            noopRunner,
            { client, formatter: noopFormatter, repo: "o/r" },
        );

        const body = store.get(7)!;

        expect(body).toContain("**alpha**\n\n- `@s/a@1.0.0-alpha.3`\n\n**latest**\n\n- `@s/a@1.0.0`");
        expect(body.split(SUCCESS_WALK_MARKER)).toHaveLength(2);
    });

    it("is byte-identical when the same wave is walked again", async () => {
        expect.hasAssertions();

        const store = new Map<number, string>();
        const { client, commentCalls } = buildMockClient({ store });
        const walk = async (): Promise<void> => {
            await walkSuccessfulRelease(
                mkContext({}, [mkRelease("@s/a", "1.0.0", ["#7"]), mkRelease("@s/b", "1.0.0", ["#7"])]),
                mkResult([
                    { name: "@s/a", version: "1.0.0" },
                    { name: "@s/b", version: "1.0.0" },
                ]),
                noopRunner,
                { client, formatter: noopFormatter, repo: "o/r" },
            );
        };

        await walk();
        await walk();

        expect(commentCalls[1]!.body).toBe(commentCalls[0]!.body);
    });
});

describe(renderSuccessComment, () => {
    const vars = { name: "@s/a", tag: "latest", url: "", version: "1.0.0" };

    it("adds a resumed wave's packages to the channel instead of replacing it", () => {
        expect.hasAssertions();

        const first = renderSuccessComment(undefined, DEFAULT_SUCCESS_WALK_COMMENT, { channel: "alpha", releases: [{ name: "@s/a", version: "1.0.0-alpha.1" }] }, vars);
        const second = renderSuccessComment(first, DEFAULT_SUCCESS_WALK_COMMENT, { channel: "alpha", releases: [{ name: "@s/b", version: "1.0.0-alpha.1" }] }, vars);

        expect(second).toContain("- `@s/a@1.0.0-alpha.1`\n- `@s/b@1.0.0-alpha.1`");
    });

    it("keeps the first version a package shipped the ref in, per channel", () => {
        expect.hasAssertions();

        const first = renderSuccessComment(undefined, DEFAULT_SUCCESS_WALK_COMMENT, { channel: "alpha", releases: [{ name: "@s/a", version: "1.0.0-alpha.1" }] }, vars);
        const second = renderSuccessComment(first, DEFAULT_SUCCESS_WALK_COMMENT, { channel: "alpha", releases: [{ name: "@s/a", version: "1.0.0-alpha.2" }] }, vars);

        expect(second).toBe(first);
    });

    it("replaces a comment written before the history block existed", () => {
        expect.hasAssertions();

        const legacy = `${SUCCESS_WALK_MARKER}\n:tada: This issue has been resolved in version 0.9.0 :tada:`;
        const body = renderSuccessComment(legacy, DEFAULT_SUCCESS_WALK_COMMENT, { channel: "latest", releases: [{ name: "@s/a", version: "1.0.0" }] }, vars);

        expect(body).not.toContain("0.9.0");
        expect(body).toContain("- `@s/a@1.0.0`");
    });

    it("drops malformed entries from an edited history block", () => {
        expect.hasAssertions();

        const edited = `${SUCCESS_WALK_MARKER}\n\n<!-- vis-release-success-data {"alpha":[null,{"name":"x"}],"beta":"nope"} -->`;
        const body = renderSuccessComment(edited, "{releases}", { channel: "latest", releases: [{ name: "@s/a", version: "1.0.0" }] }, vars);

        expect(body).toContain("**latest**\n\n- `@s/a@1.0.0`");
        expect(body).not.toContain("undefined");
    });

    it("round-trips `--` in a package name without closing the hidden HTML comment", () => {
        expect.hasAssertions();

        const first = renderSuccessComment(undefined, "{releases}", { channel: "latest", releases: [{ name: "a--b", url: "https://x/--/y", version: "1.0.0" }] }, vars, "https://x/");

        // Only the marker's and the data block's own closers.
        expect(first.split("-->")).toHaveLength(3);

        const second = renderSuccessComment(first, "{releases}", { channel: "next", releases: [{ name: "c", version: "2.0.0" }] }, vars, "https://x/");

        expect(second).toContain("- [`a--b@1.0.0`](https://x/--/y)");
        expect(second).toContain("- `c@2.0.0`");
    });
});

describe("renderSuccessComment — stored history is untrusted", () => {
    const vars = { name: "@s/a", tag: "latest", url: "", version: "1.0.0" };
    const prefix = "https://github.com/o/r/releases/";
    const withHistory = (data: unknown): string => `${SUCCESS_WALK_MARKER}\n\n<!-- vis-release-success-data ${JSON.stringify(data)} -->`;
    const render = (data: unknown): string =>
        renderSuccessComment(withHistory(data), "{releases}", { channel: "latest", releases: [{ name: "@s/a", version: "1.0.0" }] }, vars, prefix);

    it("drops stored links that are not this repo's release pages", () => {
        expect.hasAssertions();

        // Assembled so the lint rule against script URLs doesn't read the fixture as code.
        const scriptUrl = ["javascript", "alert(1)"].join(":");

        const body = render({
            alpha: [
                { name: "@s/x", url: scriptUrl, version: "1.0.0" },
                { name: "@s/y", url: "https://evil.example/o/r/releases/tag/y", version: "1.0.0" },
                { name: "@s/z", url: "https://github.com/o/r/releases/tag/z)](https://evil.example", version: "1.0.0" },
                { name: "@s/v", url: "https://github.com.evil.example/o/r/releases/tag/v", version: "1.0.0" },
                { name: "@s/w", url: "https://github.com/o/r/releases/../../../evil/w", version: "1.0.0" },
                { name: "@s/ok", url: "https://github.com/o/r/releases/tag/ok", version: "1.0.0" },
            ],
        });

        expect(body).not.toContain(scriptUrl);
        expect(body).not.toContain("evil.example)");
        expect(body).not.toContain("evil.example/");
        expect(body).not.toContain("/evil/w");
        expect(body).toContain("- `@s/x@1.0.0`\n- `@s/y@1.0.0`\n- `@s/z@1.0.0`\n- `@s/v@1.0.0`\n- `@s/w@1.0.0`\n- [`@s/ok@1.0.0`](https://github.com/o/r/releases/tag/ok)");
    });

    it("drops entries and channels carrying Markdown or HTML, and rebuilds npm links instead of trusting stored ones", () => {
        expect.hasAssertions();

        const body = render({
            "**x**": [{ name: "@s/c", version: "1.0.0" }],
            alpha: [
                { name: "x` [click](https://evil.example) `", version: "1.0.0" },
                { name: "@s/b", version: "<img src=x>" },
                { name: "@s/d", npm: true, npmUrl: "https://evil.example", version: "2.0.0" },
                { name: "@s/e", npm: true, version: "not-semver" },
            ],
        });

        expect(body).not.toContain("evil.example");
        expect(body).not.toContain("<img");
        expect(body).not.toContain("**x**");
        expect(body).toContain("**alpha**\n\n- `@s/d@2.0.0` · [npm](https://www.npmjs.com/package/@s/d/v/2.0.0)\n- `@s/e@not-semver`\n\n**latest**");
    });
});

describe("successWalk — GitLab issue vs merge request refs", () => {
    it("routes `#N` to the issue and `!N` to the merge request, for the note and the labels", async () => {
        expect.hasAssertions();

        const { addLabelsCalls, client, commentCalls } = buildMockClient({ id: "gitlab" });
        const context = mkContext({}, [mkRelease("@s/a", "1.0.0", ["fix: y (!12), closes #12 and #3"])]);

        await walkSuccessfulRelease(context, mkResult([{ name: "@s/a", version: "1.0.0" }]), noopRunner, { client, formatter: noopFormatter, repo: "g/p" });

        const seen = (calls: { issueNumber: number; target?: string }[]): string[] => calls.map((c) => `${c.target}:${c.issueNumber}`).sort();

        expect(seen(commentCalls)).toStrictEqual(["issue:12", "issue:3", "merge_request:12"]);
        expect(seen(addLabelsCalls)).toStrictEqual(["issue:12", "issue:3", "merge_request:12"]);
    });

    it("types GitLab URLs by resource and ignores `!N` off GitLab", () => {
        expect.hasAssertions();

        const body = "see https://gitlab.com/g/p/-/merge_requests/4 and https://gitlab.com/g/p/-/issues/5 and !6";

        expect(extractTypedReferences(body, "g/p", true)).toStrictEqual([
            { number: 4, target: "merge_request" },
            { number: 5, target: "issue" },
            { number: 6, target: "merge_request" },
        ]);
        expect(extractTypedReferences(body, "g/p", false).map((r) => r.number)).toStrictEqual([4, 5]);
    });
});

describe("successWalk — refs from a custom changelog formatter", () => {
    it("finds refs that only the formatter output carries (lunora's linked `([#N](…/issues/N))` form)", async () => {
        expect.hasAssertions();

        const { client, commentCalls } = buildMockClient();
        // Change-file body carries no ref; only the formatter's rendered output does.
        const context = mkContext({ config: { successWalk: { skipPrerelease: false } } }, [mkRelease("@lunora/runtime", "1.0.0-alpha.77", ["fix(runtime): drop stale shard"])]);
        const formatter = async (): Promise<string> => "### Bug Fixes\n\n* **runtime:** drop stale shard ([#1234](https://github.com/anolilab/lunora/issues/1234))\n";

        await walkSuccessfulRelease(context, mkResult([{ name: "@lunora/runtime", version: "1.0.0-alpha.77" }]), noopRunner, {
            client,
            formatter,
            repo: "anolilab/lunora",
        });

        expect(commentCalls.map((c) => c.issueNumber)).toStrictEqual([1234]);
    });
});
