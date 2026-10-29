import { describe, expect, it } from "vitest";

import type { CommandRunner } from "../../../src/release/core/package-managers/interface";
import { GithubRemoteClient } from "../../../src/release/core/remote/github";

interface RecordedCall {
    args: ReadonlyArray<string>;
    command: string;
    env?: NodeJS.ProcessEnv;
}

interface RunnerStub {
    calls: RecordedCall[];
    runner: CommandRunner;
}

const buildRunner = (responses: { exitCode?: number; stdout?: string }[]): RunnerStub => {
    const calls: RecordedCall[] = [];
    let cursor = 0;

    const runner: CommandRunner = {
        run: async (command, args, opts) => {
            calls.push({ args, command, env: opts?.env });

            const next = responses[cursor];

            cursor += 1;

            if (!next) {
                return { exitCode: 1, stderr: "no more stub responses", stdout: "" };
            }

            return { exitCode: next.exitCode ?? 0, stderr: "", stdout: next.stdout ?? "" };
        },
    };

    return { calls, runner };
};

describe("githubRemoteClient.createRelease — structured assets", () => {
    it("renames asset display via <path>#label syntax", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "https://github.com/.../release" }]);

        await new GithubRemoteClient().createRelease(runner, {
            assets: [{ label: "Bundle", path: "/tmp/pkg.tgz" }, { path: "/tmp/raw.tgz" }],
            body: "notes",
            cwd: "/cwd",
            repo: "owner/name",
            tag: "v1.0.0",
            title: "v1.0.0",
        });

        const { args } = calls[0]!;

        expect(args).toContain("/tmp/pkg.tgz#Bundle");
        expect(args).toContain("/tmp/raw.tgz");
    });

    it("inlines link-only assets as a body section since GH Releases don't model link assets", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }]);

        await new GithubRemoteClient().createRelease(runner, {
            assets: [{ label: "Container", linkUrl: "https://images.example/repo:1.0.0" }],
            body: "notes",
            cwd: "/cwd",
            repo: "owner/name",
            tag: "v1.0.0",
            title: "v1.0.0",
        });

        const notesIdx = calls[0]!.args.indexOf("--notes");

        expect(notesIdx).toBeGreaterThan(-1);

        const body = calls[0]!.args[notesIdx + 1] ?? "";

        expect(body).toContain("### Additional links");
        expect(body).toContain("[Container](https://images.example/repo:1.0.0)");
    });

    it("threads discussionCategory into the gh CLI", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }]);

        await new GithubRemoteClient().createRelease(runner, {
            body: "n",
            cwd: "/cwd",
            discussionCategory: "Announcements",
            repo: "owner/name",
            tag: "v1.0.0",
            title: "v1.0.0",
        });

        expect(calls[0]!.args).toContain("--discussion-category");
        expect(calls[0]!.args).toContain("Announcements");
    });
});

describe("githubRemoteClient.addLabels", () => {
    it("pOSTs labels via the issues/labels API", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }]);

        const ok = await new GithubRemoteClient().addLabels(runner, {
            cwd: "/cwd",
            issueNumber: 7,
            labels: ["released", "ship-it"],
            repo: "owner/name",
        });

        expect(ok).toBe(true);

        const { args } = calls[0]!;

        expect(args[1]).toBe("-X");
        expect(args[2]).toBe("POST");
        expect(args).toContain("repos/owner/name/issues/7/labels");
        expect(args.filter((a) => a === "labels[]=released")).toHaveLength(1);
        expect(args.filter((a) => a === "labels[]=ship-it")).toHaveLength(1);
    });

    it("returns true without invoking the runner when labels is empty", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([]);

        const ok = await new GithubRemoteClient().addLabels(runner, {
            cwd: "/cwd",
            issueNumber: 7,
            labels: [],
            repo: "owner/name",
        });

        expect(ok).toBe(true);
        expect(calls).toHaveLength(0);
    });
});

describe("githubRemoteClient.upsertIssue", () => {
    it("edits the existing issue when one matches the title-marker", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            { stdout: JSON.stringify([{ number: 9, title: "[release-failed] v1.0", url: "https://x/9" }]) },
            { stdout: "" },
        ]);

        const result = await new GithubRemoteClient().upsertIssue(runner, {
            assignees: ["alice", "bob"],
            body: "rerun details",
            cwd: "/cwd",
            labels: ["release-bot"],
            marker: "[release-failed]",
            repo: "owner/name",
            title: "[release-failed] v1.0",
        });

        expect(result).toStrictEqual({ created: false, number: 9, url: "https://x/9" });

        const editArgs = calls[1]!.args;

        expect(editArgs).toContain("--add-label");
        expect(editArgs).toContain("release-bot");
        expect(editArgs).toContain("--add-assignee");
        expect(editArgs).toContain("alice,bob");
    });

    it("creates a new issue when none match", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "[]" }, { stdout: "https://github.com/owner/name/issues/42" }]);

        const result = await new GithubRemoteClient().upsertIssue(runner, {
            body: "fresh",
            cwd: "/cwd",
            marker: "[release-failed]",
            repo: "owner/name",
            title: "[release-failed] v1.1",
        });

        expect(result?.number).toBe(42);
        expect(result?.created).toBe(true);
        expect(calls[1]!.args).toContain("create");
    });
});

describe("githubRemoteClient — enterprise host + proxy env wiring", () => {
    it("sets GH_HOST on the subprocess env when host is configured", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }]);

        await new GithubRemoteClient({ host: "github.acme.com" }).createRelease(runner, {
            body: "n",
            cwd: "/cwd",
            repo: "o/r",
            tag: "v1.0.0",
            title: "v1.0.0",
        });

        expect(calls[0]!.env).toBeDefined();
        expect(calls[0]!.env?.["GH_HOST"]).toBe("github.acme.com");
    });

    it("sets HTTPS_PROXY + HTTP_PROXY when httpProxy is configured", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }]);

        await new GithubRemoteClient({ httpProxy: "http://proxy.acme.com:8080" }).addLabels(runner, {
            cwd: "/cwd",
            issueNumber: 7,
            labels: ["x"],
            repo: "o/r",
        });

        expect(calls[0]!.env?.["HTTPS_PROXY"]).toBe("http://proxy.acme.com:8080");
        expect(calls[0]!.env?.["HTTP_PROXY"]).toBe("http://proxy.acme.com:8080");
    });

    it("threads both host and proxy together when both are set", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }]);

        await new GithubRemoteClient({ host: "github.acme.com", httpProxy: "http://proxy.acme.com:8080" }).addLabels(runner, {
            cwd: "/cwd",
            issueNumber: 1,
            labels: ["released"],
            repo: "o/r",
        });

        expect(calls[0]!.env?.["GH_HOST"]).toBe("github.acme.com");
        expect(calls[0]!.env?.["HTTPS_PROXY"]).toBe("http://proxy.acme.com:8080");
    });

    it("omits env entirely when no host/proxy is configured", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }]);

        await new GithubRemoteClient().addLabels(runner, {
            cwd: "/cwd",
            issueNumber: 1,
            labels: ["x"],
            repo: "o/r",
        });

        expect(calls[0]!.env).toBeUndefined();
    });
});

describe("githubRemoteClient.listRecentReleases", () => {
    it("returns parsed releases with the limit applied", async () => {
        expect.hasAssertions();

        const stdout = JSON.stringify([
            { name: "@scope/pkg v1.4.2", tagName: "@scope/pkg@1.4.2", url: "https://github.com/o/r/releases/tag/%40scope%2Fpkg%401.4.2" },
            { name: "@scope/pkg v1.4.1", tagName: "@scope/pkg@1.4.1", url: "https://github.com/o/r/releases/tag/%40scope%2Fpkg%401.4.1" },
            { name: "@scope/pkg v1.4.0", tagName: "@scope/pkg@1.4.0", url: "https://github.com/o/r/releases/tag/%40scope%2Fpkg%401.4.0" },
        ]);
        const { calls, runner } = buildRunner([{ stdout }]);

        const releases = await new GithubRemoteClient().listRecentReleases(runner, {
            cwd: "/cwd",
            limit: 3,
            repo: "owner/name",
        });

        expect(releases).toHaveLength(3);
        expect(releases[0]).toStrictEqual({
            name: "@scope/pkg v1.4.2",
            tag: "@scope/pkg@1.4.2",
            url: "https://github.com/o/r/releases/tag/%40scope%2Fpkg%401.4.2",
        });

        const { args } = calls[0]!;

        expect(args).toContain("release");
        expect(args).toContain("list");
        expect(args).toContain("--json");
        expect(args).toContain("tagName,url,name");
        expect(args).toContain("--repo");
        expect(args).toContain("owner/name");
    });

    it("filters by tagPrefix and excludeTag — only matching tags survive", async () => {
        expect.hasAssertions();

        const stdout = JSON.stringify([
            { name: "@scope/pkg v1.5.0 (current)", tagName: "@scope/pkg@1.5.0", url: "https://github.com/o/r/releases/tag/%40scope%2Fpkg%401.5.0" },
            { name: "@scope/other v2.0.0", tagName: "@scope/other@2.0.0", url: "https://github.com/o/r/releases/tag/%40scope%2Fother%402.0.0" },
            { name: "@scope/pkg v1.4.2", tagName: "@scope/pkg@1.4.2", url: "https://github.com/o/r/releases/tag/%40scope%2Fpkg%401.4.2" },
            { name: "@scope/pkg v1.4.1", tagName: "@scope/pkg@1.4.1", url: "https://github.com/o/r/releases/tag/%40scope%2Fpkg%401.4.1" },
        ]);
        const { runner } = buildRunner([{ stdout }]);

        const releases = await new GithubRemoteClient().listRecentReleases(runner, {
            cwd: "/cwd",
            excludeTag: "@scope/pkg@1.5.0",
            limit: 3,
            repo: "owner/name",
            tagPrefix: "@scope/pkg@",
        });

        expect(releases.map((r) => r.tag)).toStrictEqual(["@scope/pkg@1.4.2", "@scope/pkg@1.4.1"]);
    });

    it("returns [] on non-zero exit or malformed JSON", async () => {
        expect.hasAssertions();

        const { runner } = buildRunner([{ exitCode: 1 }, { stdout: "not-json" }]);

        const empty = await new GithubRemoteClient().listRecentReleases(runner, {
            cwd: "/cwd",
            limit: 3,
            repo: "owner/name",
        });

        expect(empty).toStrictEqual([]);

        const empty2 = await new GithubRemoteClient().listRecentReleases(runner, {
            cwd: "/cwd",
            limit: 3,
            repo: "owner/name",
        });

        expect(empty2).toStrictEqual([]);
    });
});

describe("githubRemoteClient.closeIssue", () => {
    it("posts the closing comment then closes", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }, { stdout: "" }]);

        const ok = await new GithubRemoteClient().closeIssue(runner, {
            closingComment: "shipped in v1.2",
            cwd: "/cwd",
            issueNumber: 5,
            repo: "owner/name",
        });

        expect(ok).toBe(true);
        expect(calls[0]!.args).toContain("comment");
        expect(calls[1]!.args).toContain("close");
    });

    it("skips the comment call when closingComment is omitted", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }]);

        const ok = await new GithubRemoteClient().closeIssue(runner, {
            cwd: "/cwd",
            issueNumber: 5,
            repo: "owner/name",
        });

        expect(ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.args).toContain("close");
    });
});

describe("githubRemoteClient.upsertStickyComment", () => {
    it("pATCHes the body `merge` derives from the existing comment", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: JSON.stringify([{ body: "<!-- m -->\nold", id: 7, user: { login: "bot[bot]", type: "Bot" } }]) }, { stdout: "bot\n" }, { stdout: "{}" }]);

        const result = await new GithubRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            merge: (existing) => `${existing}\nmore`,
            repo: "owner/name",
        });

        expect(result).toStrictEqual({ created: false, id: 7 });
        expect(calls[1]?.args[1]).toBe("graphql");
        expect(calls[2]?.args.slice(0, 4)).toStrictEqual(["api", "-X", "PATCH", "repos/owner/name/issues/comments/7"]);
        expect(calls[2]?.args).toContain("body=<!-- m -->\nold\nmore");
    });

    it("posts `body` when no comment carries the marker yet", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "[]" }, { stdout: JSON.stringify({ id: 3 }) }]);

        const result = await new GithubRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            merge: () => "never used",
            repo: "owner/name",
        });

        expect(result).toStrictEqual({ created: true, id: 3 });
        expect(calls[1]?.args).toContain("body=<!-- m -->\nfresh");
    });

    it("skips the write when `merge` leaves the comment unchanged", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: JSON.stringify([{ body: "<!-- m -->\nsame", id: 7, user: { login: "rel", type: "User" } }]) }, { stdout: "rel" }]);

        const result = await new GithubRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            merge: (existing) => existing,
            repo: "owner/name",
        });

        expect(result).toStrictEqual({ created: false, id: 7 });
        expect(calls).toHaveLength(2);
    });

    it("finds the marked comment on a later page of `gh api --paginate` output", async () => {
        expect.hasAssertions();

        const page1 = JSON.stringify([{ body: "see [a][b] and \"quotes\" ]", id: 1 }]);
        const page2 = JSON.stringify([{ body: "<!-- m -->\nold", id: 9, user: { login: "rel" } }]);
        const { calls, runner } = buildRunner([{ stdout: `${page1}${page2}` }, { stdout: "rel" }, { stdout: "{}" }]);

        const result = await new GithubRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            repo: "owner/name",
        });

        expect(result).toStrictEqual({ created: false, id: 9 });
        expect(calls[2]?.args[2]).toBe("PATCH");
    });

    it("writes nothing when the comments cannot be listed", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ exitCode: 1 }]);

        const result = await new GithubRemoteClient().upsertStickyComment(runner, {
            body: "x",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            repo: "owner/name",
        });

        expect(result).toBeUndefined();
        expect(calls).toHaveLength(1);
    });
});

describe("githubRemoteClient.upsertStickyComment — only our own comment is sticky", () => {
    it("ignores a marked comment posted by someone else and posts its own", async () => {
        expect.hasAssertions();

        const forged = { body: "<!-- m -->\n<!-- vis-release-success-data {} -->", id: 4, user: { login: "mallory", type: "User" } };
        const { calls, runner } = buildRunner([{ stdout: JSON.stringify([forged]) }, { stdout: "github-actions" }, { stdout: JSON.stringify({ id: 5 }) }]);
        const merged: string[] = [];

        const result = await new GithubRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            merge: (existing) => {
                merged.push(existing);

                return existing;
            },
            repo: "owner/name",
        });

        expect(result).toStrictEqual({ created: true, id: 5 });
        expect(merged).toHaveLength(0);
        expect(calls[2]?.args.slice(0, 3)).toStrictEqual(["api", "-X", "POST"]);
        expect(calls[2]?.args).toContain("body=<!-- m -->\nfresh");
    });

    it("does not take a human login that equals the bot's name for the bot", async () => {
        expect.hasAssertions();

        const impostor = { body: "<!-- m -->\nold", id: 4, user: { login: "github-actions[bot]", type: "User" } };
        const { calls, runner } = buildRunner([{ stdout: JSON.stringify([impostor]) }, { stdout: "github-actions" }, { stdout: JSON.stringify({ id: 5 }) }]);

        await new GithubRemoteClient().upsertStickyComment(runner, { body: "x", cwd: "/cwd", issueNumber: 5, marker: "<!-- m -->", repo: "owner/name" });

        expect(calls[2]?.args[2]).toBe("POST");
    });

    it("posts a new comment and never edits or merges from a marked one when the token identity is unknown", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: JSON.stringify([{ body: "<!-- m -->\nold", id: 4, user: { login: "x" } }]) }, { exitCode: 1 }, { stdout: JSON.stringify({ id: 6 }) }]);

        await new GithubRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            merge: (existing) => `${existing}\nmerged`,
            repo: "owner/name",
        });

        expect(calls[2]?.args.slice(0, 4)).toStrictEqual(["api", "-X", "POST", "repos/owner/name/issues/5/comments"]);
        expect(calls[2]?.args).toContain("body=<!-- m -->\nfresh");
    });
});
