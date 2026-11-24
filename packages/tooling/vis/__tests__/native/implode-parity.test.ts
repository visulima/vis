import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SHORT_COLOUR_ENVIRONMENTS } from "./colour-environments";
import type { Files, Result } from "./workspace-parity-harness";
import { binary, Harness, nodeEntry, workspaceFiles } from "./workspace-parity-harness";

/**
 * `vis implode` exists twice: the Node handler (`src/commands/implode/handler.ts`) and the native path
 * (`native/cli/src/implode.rs`). It deletes `~/.vis` and edits shell profiles, so every case runs both sides on
 * identical, throwaway `HOME` directories and compares stdout, stderr, the exit status AND the whole state left on
 * disk (every path of the home and the workspace with its type, mode and content). A run the binary declines must
 * hand the call to Node before it prints or changes anything: with no Node entry it then exits 70, leaves both
 * trees as they were, and the delegated run matches Node.
 */

const harness = new Harness(["implode"]);

const ZSHRC = ["export A=1", 'export PATH="$HOME/.vis/bin:$PATH"', "# vis shell integration", "export B=2", ""].join("\n");

/** The files of a home that vis was installed into. */
const installed = (extra: Files = {}): Files => {
    return {
        ".vis/bin/vis": "#!/bin/sh\n",
        ".vis/cache/ai/entry.json": "{}",
        ".vis/state/tips.json": "{}",
        ".zshrc": ZSHRC,
        ...extra,
    };
};

/** Every path under `root` with its type, mode and content, so a changed mode or a leftover directory shows. */
const tree = (root: string): Record<string, string> => {
    const out: Record<string, string> = {};

    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        const path = join(entry.parentPath, entry.name);
        const stats = lstatSync(path);
        // eslint-disable-next-line no-bitwise -- the permission bits of the mode
        const mode = (stats.mode & 0o7777).toString(8);

        if (stats.isSymbolicLink()) {
            out[relative(root, path)] = `link ${readlinkSync(path)}`;
        } else if (stats.isDirectory()) {
            out[relative(root, path)] = `dir ${mode}`;
        } else {
            out[relative(root, path)] = `file ${mode} ${readFileSync(path).toString("hex")}`;
        }
    }

    return out;
};

interface Side {
    home: string;
    workspace: string;
}

const sides = (home: Files, cwd = ""): { native: Side; node: Side } => {
    const [nodeWorkspace, nativeWorkspace] = harness.pair(workspaceFiles({ "packages/app/package.json": '{"name":"app"}\n' }));
    const [nodeHome, nativeHome] = harness.pair(home);

    return {
        native: { home: nativeHome, workspace: join(nativeWorkspace, cwd) },
        node: { home: nodeHome, workspace: join(nodeWorkspace, cwd) },
    };
};

const snapshot = (side: Side): Record<string, Record<string, string>> => {
    return { home: tree(side.home), workspace: tree(side.workspace) };
};

/** The two homes and workspaces differ only in a directory name of the same length; the Node runtime's warnings carry a pid. */
const normalized = (result: Result, side: Side): Result => {
    const replace = (text: string): string => Harness.normalize(text, side.workspace).replaceAll(side.home, "<HOME>");

    return { status: result.status, stderr: replace(result.stderr), stdout: replace(result.stdout) };
};

const environmentOf = (side: Side, extra: Record<string, string> = {}): Record<string, string> => {
    return { HOME: side.home, ...extra };
};

/** The native side must answer, and leave the same disk and output as Node. */
const expectParity = (home: Files, args: string[], extra: Record<string, string> = {}, cwd = ""): Result => {
    const { native, node } = sides(home, cwd);
    const nodeResult = harness.runNode(args, node.workspace, environmentOf(node, extra));
    const nativeResult = harness.runNative(args, native.workspace, environmentOf(native, extra));

    expect(nativeResult.status, `native stderr: ${nativeResult.stderr}`).not.toBe(70);
    expect(normalized(nativeResult, native)).toStrictEqual(normalized(nodeResult, node));
    expect(snapshot(native)).toStrictEqual(snapshot(node));

    return nativeResult;
};

/** The native side must decline before it prints or changes anything, and the hand-off must match Node. */
const expectDelegation = (home: Files, args: string[], extra: Record<string, string> = {}, ci = true, prepare?: (side: Side) => void): Result => {
    const { native, node } = sides(home);
    const probe = sides(home).native;

    for (const side of [native, node, probe]) {
        prepare?.(side);
    }

    const before = snapshot(probe);
    const declined = harness.runNative(args, probe.workspace, environmentOf(probe, extra), ci);

    expect(declined.status, `stdout: ${declined.stdout}`).toBe(70);
    expect(declined.stdout, "a declined run prints nothing").toBe("");
    expect(snapshot(probe), "a declined run must not touch the disk").toStrictEqual(before);

    const nodeResult = harness.runNode(args, node.workspace, environmentOf(node, extra), ci);
    const delegated = harness.runNative(args, native.workspace, environmentOf(native, { ...extra, VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath }), ci);

    expect(normalized(delegated, native)).toStrictEqual(normalized(nodeResult, node));
    expect(snapshot(native)).toStrictEqual(snapshot(node));

    return delegated;
};

const replaceWithLink = (root: string, name: string, target: string): void => {
    const path = join(root, name);

    // Remove what the harness wrote at the path, then link it to the target.
    rmSync(path, { force: true, recursive: true });
    symlinkSync(join(root, target), path);
};

describe.skipIf(!binary || process.platform === "win32" || !existsSync(nodeEntry))("vis implode: native vs Node", () => {
    beforeAll(() => {
        harness.setup("vis-implode-parity-");
    });

    afterAll(() => {
        harness.teardown();
    });

    describe("answered natively", () => {
        it.each(["--yes", "-y"])("removes ~/.vis and cleans the profile with %s", (flag) => {
            expect.hasAssertions();

            const result = expectParity(installed(), [flag]);

            expect(result.stdout).toContain("vis has been uninstalled.");
        });

        it("leaves nothing of ~/.vis behind and rewrites the profile without the vis lines", () => {
            expect.hasAssertions();

            const { native } = sides(installed());
            const result = harness.runNative(["--yes"], native.workspace, environmentOf(native));

            expect(result.status).toBe(0);
            expect(existsSync(join(native.home, ".vis"))).toBe(false);
            expect(readFileSync(join(native.home, ".zshrc"), "utf8")).toBe("export A=1\nexport B=2\n");
        });

        it("lists a profile that mentions .vis without cleaning it, and cleans one that only names VIS_HOME", () => {
            expect.hasAssertions();

            expectParity(
                installed({
                    ".bash_profile": "source ~/.vis/env\n",
                    ".bashrc": "export VIS_HOME=/x\nexport C=3",
                    ".config/fish/config.fish": "set -x PATH $HOME/.vis/bin $PATH\nset -x D 4\n",
                    ".profile": "# vis start\n# vis end\n",
                    ".zshenv": "echo nothing to do\n",
                }),
                ["--yes"],
            );
        });

        it("handles CRLF, a missing final newline and an emptied file, and writes the profile with the default mode", () => {
            expect.hasAssertions();

            expectParity(
                installed({
                    ".bashrc": "alias a=b\r\nexport PATH=$HOME/.vis/bin:$PATH\r\nalias c=d\r\n",
                    ".profile": "export PATH=$HOME/.vis/bin:$PATH",
                }),
                ["--yes"],
            );

            const { native, node } = sides(installed());

            for (const side of [native, node]) {
                chmodSync(join(side.home, ".zshrc"), 0o600);
            }

            harness.runNode(["--yes"], node.workspace, environmentOf(node));
            harness.runNative(["--yes"], native.workspace, environmentOf(native));

            expect(tree(native.home)).toStrictEqual(tree(node.home));
            // `writeFileSync` of `@visulima/fs` gives the rewritten file the default mode, not the one it replaced.
            expect(tree(native.home)[".zshrc"]).toMatch(/^file 644 /);
        });

        it("keeps non-ASCII text and a byte order mark", () => {
            expect.hasAssertions();

            expectParity(installed({ ".bashrc": "﻿# héllo ✓\nexport PATH=$HOME/.vis/bin:$PATH\n" }), ["--yes"]);
        });

        it("answers from a directory below the workspace root", () => {
            expect.hasAssertions();

            expectParity(installed(), ["--yes"], {}, "packages/app");
        });

        it("has nothing to do when ~/.vis is absent, with or without --yes", () => {
            expect.hasAssertions();

            for (const args of [["--yes"], ["-y"], []]) {
                const result = expectParity({ ".zshrc": ZSHRC }, args);

                expect(result.stdout).toBe("vis is not installed (no ~/.vis directory found).\n");
            }
        });

        it("removes an installation that holds nothing but the directory, and a home without profiles", () => {
            expect.hasAssertions();

            expectParity({ ".vis/bin/vis": "x" }, ["--yes"]);
            expectParity({ ".vis/state/a/b/c/d": "x" }, ["--yes"]);
        });

        it.each(SHORT_COLOUR_ENVIRONMENTS)("prints the same in %j", (environment) => {
            expect.hasAssertions();

            expectParity(installed(), ["--yes"], environment);
        });
    });

    describe("handed to Node", () => {
        it("without --yes on a stdin that is not a terminal", () => {
            expect.hasAssertions();

            const result = expectDelegation(installed(), []);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain("Non-interactive terminal. Use --yes to confirm.");
        });

        it.each([[["--yes", "--yes"]], [["--yes", "-y"]], [["--yes=true"]], [["--force"]], [["--yes", "extra"]], [["extra"]], [["--no-yes"]], [["-y", "--json"]]])("with the arguments %j", (args: string[]) => {
            expect.hasAssertions();

            expectDelegation(installed(), args);
        });

        it("outside CI", () => {
            expect.hasAssertions();

            expectDelegation(installed(), ["--yes"], { VIS_CLI_TEST: "1" }, false);
        });

        it.each([{ DEBUG: "1" }, { CEREBRO_OUTPUT_LEVEL: "64" }, { NODE_ENV: "test" }, { PAIL_LOG_LEVEL: "debug" }, { FORCE_COLOR: "1", NO_COLOR: "1" }])("with %j in the environment", (environment) => {
            expect.hasAssertions();

            expectDelegation(installed(), ["--yes"], environment);
        });

        it("when the workspace has a vis.config", () => {
            expect.hasAssertions();

            expectDelegation(installed(), ["--yes"], {}, true, (side) => {
                writeFileSync(join(side.workspace, "vis.config.json"), "{}\n");
            });
        });

        it.each([["with a trailing slash", (home: string) => `${home}/`], ["with a dot segment", (home: string) => `${home}/./`], ["with a double slash", (home: string) => home.replace("/vis-implode-parity-", "//vis-implode-parity-")]])(
            "when HOME is written %s",
            (_name, spell) => {
                expect.hasAssertions();

                const { native, node } = sides(installed());
                const spelled = (side: Side): Record<string, string> => environmentOf({ ...side, home: spell(side.home) });
                const probeBefore = snapshot(native);
                const declined = harness.runNative(["--yes"], native.workspace, spelled(native));

                expect(declined.status).toBe(70);
                expect(snapshot(native)).toStrictEqual(probeBefore);

                const nodeResult = harness.runNode(["--yes"], node.workspace, spelled(node));
                const delegated = harness.runNative(["--yes"], native.workspace, { ...spelled(native), VIS_FALLBACK_ENTRY: nodeEntry, VIS_NODE: process.execPath });

                expect(normalized(delegated, native)).toStrictEqual(normalized(nodeResult, node));
                expect(snapshot(native)).toStrictEqual(snapshot(node));
            },
        );

        it("when a profile is a symbolic link", () => {
            expect.hasAssertions();

            expectDelegation(installed({ "dotfiles/zshrc": ZSHRC }), ["--yes"], {}, true, (side) => {
                replaceWithLink(side.home, ".zshrc", "dotfiles/zshrc");
            });
        });

        it("when a profile is a directory", () => {
            expect.hasAssertions();

            expectDelegation(installed({ ".bashrc/inner": "x" }), ["--yes"]);
        });

        it("when a profile is not UTF-8", () => {
            expect.hasAssertions();

            expectDelegation(installed({ ".bashrc": Buffer.from([0x65, 0x78, 0xff, 0x0a, ...Buffer.from("export PATH=$HOME/.vis/bin\n")]) }), ["--yes"]);
        });

        it("when ~/.vis is a symbolic link", () => {
            expect.hasAssertions();

            expectDelegation({ ".zshrc": ZSHRC, "elsewhere/bin/vis": "x" }, ["--yes"], {}, true, (side) => {
                replaceWithLink(side.home, ".vis", "elsewhere");
            });
        });

        it("when ~/.vis is a file", () => {
            expect.hasAssertions();

            expectDelegation({ ".vis": "not a directory", ".zshrc": ZSHRC }, ["--yes"]);
        });

        it("when a directory below ~/.vis cannot be removed", () => {
            expect.hasAssertions();

            const locked: string[] = [];

            try {
                // The only entry of ~/.vis, because Node removes siblings in no fixed order and a failed removal leaves a varying remainder.
                expectDelegation({ ".vis/locked/file": "x", ".zshrc": ZSHRC }, ["--yes"], {}, true, (side) => {
                    locked.push(join(side.home, ".vis", "locked"));
                    chmodSync(join(side.home, ".vis", "locked"), 0o555);
                });
            } finally {
                for (const directory of locked) {
                    if (existsSync(directory)) {
                        chmodSync(directory, 0o755);
                    }
                }
            }
        });

        it("when the directory of a profile cannot take a new file", () => {
            expect.hasAssertions();

            const locked: string[] = [];

            try {
                expectDelegation(installed({ ".config/fish/config.fish": "export PATH=$HOME/.vis/bin\n" }), ["--yes"], {}, true, (side) => {
                    locked.push(join(side.home, ".config", "fish"));
                    chmodSync(join(side.home, ".config", "fish"), 0o555);
                });
            } finally {
                for (const directory of locked) {
                    chmodSync(directory, 0o755);
                }
            }
        });
    });
});
