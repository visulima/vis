import { afterEach, describe, expect, it } from "vitest";

import type { CommandRunner } from "../../../src/release/core/package-managers/interface";
import { GitlabRemoteClient } from "../../../src/release/core/remote/gitlab";

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

describe("gitlabRemoteClient.detectRepoSlug", () => {
    afterEach(() => {
        delete process.env.CI_PROJECT_PATH;
    });

    it("prefers CI_PROJECT_PATH over the git remote", async () => {
        expect.hasAssertions();

        process.env.CI_PROJECT_PATH = "group/sub/proj";

        const { calls, runner } = buildRunner([]);
        const client = new GitlabRemoteClient();
        const slug = await client.detectRepoSlug("/cwd", runner);

        expect(slug).toBe("group/sub/proj");
        expect(calls).toHaveLength(0);
    });

    it("parses HTTPS gitlab remotes", async () => {
        expect.hasAssertions();

        const { runner } = buildRunner([{ stdout: "https://gitlab.com/group/sub/proj.git\n" }]);

        const slug = await new GitlabRemoteClient().detectRepoSlug("/cwd", runner);

        expect(slug).toBe("group/sub/proj");
    });

    it("parses SSH gitlab remotes", async () => {
        expect.hasAssertions();

        const { runner } = buildRunner([{ stdout: "git@gitlab.example.com:org/repo.git\n" }]);

        const slug = await new GitlabRemoteClient().detectRepoSlug("/cwd", runner);

        expect(slug).toBe("org/repo");
    });
});

describe("gitlabRemoteClient.detectPullRequestNumber", () => {
    it("reads CI_MERGE_REQUEST_IID", () => {
        expect.hasAssertions();

        const result = new GitlabRemoteClient().detectPullRequestNumber({ CI_MERGE_REQUEST_IID: "42" });

        expect(result).toBe(42);
    });

    it("falls back to VIS_MR_NUMBER", () => {
        expect.hasAssertions();

        const result = new GitlabRemoteClient().detectPullRequestNumber({ VIS_MR_NUMBER: "7" });

        expect(result).toBe(7);
    });

    it("returns undefined when neither is set", () => {
        expect.hasAssertions();

        const result = new GitlabRemoteClient().detectPullRequestNumber({});

        expect(result).toBeUndefined();
    });
});

describe("gitlabRemoteClient.upsertStickyComment", () => {
    it("creates a new note when no marker match exists", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            { stdout: JSON.stringify([{ body: "unrelated", id: 1, system: false }]) },
            { stdout: JSON.stringify({ id: 99 }) },
        ]);

        const result = await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "hello",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- vis-marker -->",
            repo: "group/sub/proj",
        });

        expect(result).toStrictEqual({ created: true, id: 99 });
        // Project path is URL-encoded.
        expect(calls[0]?.args).toContain("projects/group%2Fsub%2Fproj/merge_requests/5/notes");
        // POST when no match.
        expect(calls[1]?.args[1]).toBe("-X");
        expect(calls[1]?.args[2]).toBe("POST");
    });

    it("pUTs the existing note when a marker match exists", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            { stdout: JSON.stringify([{ author: { username: "rel" }, body: "<!-- vis-marker -->\n stale", id: 7, system: false }]) },
            { stdout: JSON.stringify({ username: "rel" }) },
            { stdout: "{}" },
        ]);

        const result = await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "<!-- vis-marker -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- vis-marker -->",
            repo: "group/proj",
        });

        expect(result).toStrictEqual({ created: false, id: 7 });
        expect(calls[2]?.args[1]).toBe("-X");
        expect(calls[2]?.args[2]).toBe("PUT");
        expect(calls[2]?.args[3]).toContain("/notes/7");
    });

    it("filters out system-generated notes when scanning for the marker", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            {
                stdout: JSON.stringify([
                    { body: "<!-- vis-marker -->", id: 1, system: true },
                    { body: "human note", id: 2 },
                ]),
            },
            { stdout: JSON.stringify({ id: 3 }) },
        ]);

        // System note carries the marker; we should ignore it and POST a new one.
        const result = await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "ok",
            cwd: "/cwd",
            issueNumber: 1,
            marker: "<!-- vis-marker -->",
            repo: "g/p",
        });

        expect(result?.created).toBe(true);
        expect(calls[1]?.args[2]).toBe("POST");
    });
});

describe("gitlabRemoteClient.createRelease", () => {
    it("emits structured assets — uploads files and registers link-only entries", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            { stdout: "" }, // glab release create
            { stdout: "" }, // glab release upload
            { stdout: "" }, // glab api … assets/links
            { stdout: JSON.stringify({ _links: { self: "https://gitlab.com/.../release" } }) },
        ]);

        const result = await new GitlabRemoteClient().createRelease(runner, {
            assets: ["/tmp/pkg-1.0.0.tgz", { label: "Container", linkUrl: "https://images.example/repo:1.0.0", type: "image" }],
            body: "release notes",
            cwd: "/cwd",
            milestones: ["v1.0.0"],
            repo: "g/p",
            tag: "v1.0.0",
            title: "v1.0.0",
        });

        expect(result?.url).toBe("https://gitlab.com/.../release");
        // Milestone wired via repeated --milestone flags.
        expect(calls[0]?.args).toContain("--milestone");
        expect(calls[0]?.args).toContain("v1.0.0");
        // Upload args include the tgz.
        expect(calls[1]?.args).toContain("/tmp/pkg-1.0.0.tgz");
        // Link-only asset goes through the assets/links endpoint.
        expect(calls[2]?.args.join(" ")).toContain("assets/links");
        expect(calls[2]?.args).toContain("name=Container");
        expect(calls[2]?.args).toContain("link_type=image");
    });
});

describe("gitlabRemoteClient — self-hosted host", () => {
    it("threads GITLAB_HOST through every runner invocation", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "[]" }, { stdout: JSON.stringify({ id: 1 }) }]);

        await new GitlabRemoteClient({ host: "gitlab.example.com" }).upsertStickyComment(runner, {
            body: "x",
            cwd: "/cwd",
            issueNumber: 1,
            marker: "<!-- m -->",
            repo: "g/p",
        });

        expect(calls.map((call) => call.env?.GITLAB_HOST)).toStrictEqual(["gitlab.example.com", "gitlab.example.com"]);
    });

    it("threads GITLAB_HOST through addLabels", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "{}" }]);

        await new GitlabRemoteClient({ host: "gitlab.example.com" }).addLabels(runner, {
            cwd: "/cwd",
            issueNumber: 4,
            labels: ["released"],
            repo: "g/p",
            target: "merge_request",
        });

        expect(calls[0]?.env?.GITLAB_HOST).toBe("gitlab.example.com");
    });

    it("omits GITLAB_HOST when host is not configured", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "[]" }, { stdout: JSON.stringify({ id: 1 }) }]);

        await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "x",
            cwd: "/cwd",
            issueNumber: 1,
            marker: "<!-- m -->",
            repo: "g/p",
        });

        expect(calls).toHaveLength(2);
    });
});

describe("gitlabRemoteClient.createRelease — generic-package assets", () => {
    it("uploads files to the Generic Package Registry then registers links", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            { stdout: "" }, // glab release create
            { stdout: "{\"message\": \"201 Created\"}" }, // PUT generic upload
            { stdout: "{\"name\": \"pkg.tgz\"}" }, // POST assets/links
            { stdout: JSON.stringify({ _links: { self: "https://gitlab.example.com/release" } }) },
        ]);

        const result = await new GitlabRemoteClient({ host: "gitlab.example.com" }).createRelease(runner, {
            assets: [
                {
                    label: "Bundle",
                    packageName: "myproj",
                    path: "/tmp/pkg.tgz",
                    target: "generic_package",
                    type: "package",
                },
            ],
            body: "release notes",
            cwd: "/cwd",
            repo: "group/proj",
            tag: "v1.0.0",
            title: "v1.0.0",
        });

        expect(result?.url).toBe("https://gitlab.example.com/release");

        // Generic package upload — PUT to packages/generic/<name>/<version>/<filename>.
        const uploadCall = calls.find((c) => c.args.includes("PUT") && c.args.some((a) => a.includes("packages/generic")));

        expect(uploadCall).toBeDefined();
        expect(uploadCall?.args.some((a) => a.includes("packages/generic/myproj/1.0.0/pkg.tgz"))).toBe(true);

        // Followed by an assets/links POST on the release.
        const linkCall = calls.find((c) => c.args.some((a) => a.includes("assets/links")));

        expect(linkCall).toBeDefined();
        expect(linkCall?.args).toContain("name=Bundle");
        expect(linkCall?.args).toContain("link_type=package");
    });

    it("derives package name from repo + version from tag (with leading-v stripped)", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            { stdout: "" },
            { stdout: "{}" },
            { stdout: "{}" },
            { stdout: JSON.stringify({ _links: { self: "https://x" } }) },
        ]);

        await new GitlabRemoteClient().createRelease(runner, {
            assets: [{ path: "/tmp/x.tgz", target: "generic_package" }],
            body: "",
            cwd: "/cwd",
            repo: "group/myproj",
            tag: "v2.5.1",
            title: "v2.5.1",
        });

        const uploadCall = calls.find((c) => c.args.some((a) => a.includes("packages/generic")));

        expect(uploadCall?.args.some((a) => a.includes("packages/generic/myproj/2.5.1/x.tgz"))).toBe(true);
    });
});

describe("gitlabRemoteClient.upsertIssue", () => {
    it("pUTs the existing issue when one matches the marker", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            { stdout: JSON.stringify([{ iid: 11, title: "[release-failed] v1.0", web_url: "https://x" }]) },
            { stdout: "{}" },
        ]);

        const result = await new GitlabRemoteClient().upsertIssue(runner, {
            body: "updated",
            cwd: "/cwd",
            labels: ["release-bot"],
            marker: "[release-failed]",
            repo: "g/p",
            title: "[release-failed] v1.0",
        });

        expect(result).toStrictEqual({ created: false, number: 11, url: "https://x" });
        expect(calls[1]?.args).toContain("add_labels=release-bot");
    });

    it("creates a new issue when none match", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "[]" }, { stdout: "https://gitlab.com/g/p/-/issues/42" }]);

        const result = await new GitlabRemoteClient().upsertIssue(runner, {
            body: "fresh",
            cwd: "/cwd",
            labels: ["release-bot"],
            marker: "[release-failed]",
            repo: "g/p",
            title: "[release-failed] v1.1",
        });

        expect(result?.number).toBe(42);
        expect(result?.created).toBe(true);
        expect(calls[1]?.args).toContain("issue");
        expect(calls[1]?.args).toContain("create");
    });
});

describe("gitlabRemoteClient.closeIssue", () => {
    it("posts the closing comment then closes", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }, { stdout: "" }]);

        const ok = await new GitlabRemoteClient().closeIssue(runner, {
            closingComment: "shipped in v1.2",
            cwd: "/cwd",
            issueNumber: 5,
            repo: "g/p",
        });

        expect(ok).toBe(true);
        expect(calls[0]?.args.join(" ")).toContain("/issues/5/notes");
        expect(calls[1]?.args).toContain("close");
    });

    it("skips the comment call when closingComment is omitted", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "" }]);

        const ok = await new GitlabRemoteClient().closeIssue(runner, {
            cwd: "/cwd",
            issueNumber: 5,
            repo: "g/p",
        });

        expect(ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).toContain("close");
    });
});

describe("gitlabRemoteClient — issue vs merge request targets", () => {
    it("writes the sticky note on the issue when `target: \"issue\"`", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "[]" }, { stdout: JSON.stringify({ id: 2 }) }]);

        await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "x",
            cwd: "/cwd",
            issueNumber: 3,
            marker: "<!-- m -->",
            repo: "g/p",
            target: "issue",
        });

        expect(calls[0]?.args[1]).toBe("projects/g%2Fp/issues/3/notes");
        expect(calls[1]?.args[3]).toBe("projects/g%2Fp/issues/3/notes");
    });

    it("labels the merge request when `target: \"merge_request\"`", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "{}" }]);

        await new GitlabRemoteClient().addLabels(runner, { cwd: "/cwd", issueNumber: 8, labels: ["released"], repo: "g/p", target: "merge_request" });

        expect(calls[0]?.args.slice(0, 4)).toStrictEqual(["api", "-X", "PUT", "projects/g%2Fp/merge_requests/8"]);
    });

    it("keeps labelling the issue by default", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: "{}" }]);

        await new GitlabRemoteClient().addLabels(runner, { cwd: "/cwd", issueNumber: 8, labels: ["released"], repo: "g/p" });

        expect(calls[0]?.args[3]).toBe("projects/g%2Fp/issues/8");
    });
});

describe("gitlabRemoteClient.upsertStickyComment — merge + pagination", () => {
    it("pUTs the body `merge` derives from the existing note", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            { stdout: JSON.stringify([{ author: { username: "rel" }, body: "<!-- m -->\nold", id: 7 }]) },
            { stdout: JSON.stringify({ username: "rel" }) },
            { stdout: "{}" },
        ]);

        await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            merge: (existing) => `${existing}\nmore`,
            repo: "g/p",
        });

        expect(calls[2]?.args).toContain("body=<!-- m -->\nold\nmore");
    });

    it("skips the write when `merge` leaves the note unchanged", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ stdout: JSON.stringify([{ author: { username: "rel" }, body: "<!-- m -->\nsame", id: 7 }]) }, { stdout: JSON.stringify({ username: "rel" }) }]);

        const result = await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            merge: (existing) => existing,
            repo: "g/p",
        });

        expect(result).toStrictEqual({ created: false, id: 7 });
        expect(calls).toHaveLength(2);
    });

    it("finds the marked note on a later page of concatenated `--paginate` output", async () => {
        expect.hasAssertions();

        const page1 = JSON.stringify([{ body: "first [x][y] page", id: 1 }]);
        const page2 = JSON.stringify([{ author: { username: "rel" }, body: "<!-- m -->\nold", id: 9 }]);
        const { calls, runner } = buildRunner([{ stdout: `${page1}\n${page2}` }, { stdout: JSON.stringify({ username: "rel" }) }, { stdout: "{}" }]);

        const result = await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            repo: "g/p",
        });

        expect(result).toStrictEqual({ created: false, id: 9 });
        expect(calls[2]?.args[2]).toBe("PUT");
    });

    it("writes nothing when the notes cannot be listed", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([{ exitCode: 1 }]);

        const result = await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "x",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            repo: "g/p",
        });

        expect(result).toBeUndefined();
        expect(calls).toHaveLength(1);
    });
});

describe("gitlabRemoteClient.upsertStickyComment — only our own note is sticky", () => {
    it("ignores a marked note authored by someone else", async () => {
        expect.hasAssertions();

        const forged = { author: { username: "mallory" }, body: "<!-- m -->\nforged", id: 4 };
        const { calls, runner } = buildRunner([{ stdout: JSON.stringify([forged]) }, { stdout: JSON.stringify({ username: "release-bot" }) }, { stdout: JSON.stringify({ id: 5 }) }]);

        const result = await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            merge: (existing) => `${existing}\nmerged`,
            repo: "g/p",
        });

        expect(result).toStrictEqual({ created: true, id: 5 });
        expect(calls[1]?.args).toStrictEqual(["api", "user"]);
        expect(calls[2]?.args).toContain("body=<!-- m -->\nfresh");
    });
});

describe("gitlabRemoteClient.upsertStickyComment — unknown token identity", () => {
    it("posts a new note and never edits or merges from a marked one", async () => {
        expect.hasAssertions();

        const { calls, runner } = buildRunner([
            { stdout: JSON.stringify([{ author: { username: "someone" }, body: "<!-- m -->\nold", id: 4 }]) },
            { exitCode: 1 },
            { stdout: JSON.stringify({ id: 6 }) },
        ]);

        const result = await new GitlabRemoteClient().upsertStickyComment(runner, {
            body: "<!-- m -->\nfresh",
            cwd: "/cwd",
            issueNumber: 5,
            marker: "<!-- m -->",
            merge: (existing) => `${existing}\nmerged`,
            repo: "g/p",
        });

        expect(result).toStrictEqual({ created: true, id: 6 });
        expect(calls[2]?.args.slice(0, 4)).toStrictEqual(["api", "-X", "POST", "projects/g%2Fp/merge_requests/5/notes"]);
        expect(calls[2]?.args).toContain("body=<!-- m -->\nfresh");
    });
});
