import { describe, expect, it } from "vitest";

import { pnpmForwardedScript, withoutForwardingScripts } from "../../src/config/root-forwarding-scripts";

describe(pnpmForwardedScript, () => {
    it.each([
        ["pnpm --filter @org/e2e e2e", "e2e"],
        ["pnpm --filter \"@org/e2e\" run e2e:examples", "e2e:examples"],
        ["pnpm -F=@org/a lint:oxfmt", "lint:oxfmt"],
        ["pnpm --dir apps/docs dev", "dev"],
        ["pnpm -r --if-present run lint", "lint"],
        ["pnpm --filter \"@org/a b\" test", "test"],
    ])("reads %j as forwarding %j", (command, script) => {
        expect.assertions(1);

        expect(pnpmForwardedScript(command)).toBe(script);
    });

    it.each([
        ["pnpm --filter a e2e -- --headed", "passes arguments on"],
        ["pnpm --filter a eslint .", "passes arguments on"],
        ["pnpm --filter a build && pnpm --filter a test", "is compound"],
        ["pnpm --filter a exec tsc", "uses exec"],
        ["pnpm --workspace-concurrency 1 --filter a up", "has an unknown flag"],
        ["pnpm run lint", "selects no project"],
        ["npm run lint -w a", "is not pnpm"],
        ["pnpm --filter \"a lint", "has an unterminated quote"],
    ])("does not read %j as a forward: it %s", (command) => {
        expect.assertions(1);

        expect(pnpmForwardedScript(command)).toBeUndefined();
    });
});

describe(withoutForwardingScripts, () => {
    it("drops a vis run of the script's own name, and a pnpm forward only when another project has the target", () => {
        expect.assertions(1);

        const scripts = withoutForwardingScripts(
            {
                build: "vis run build",
                e2e: "pnpm --filter e2e e2e",
                outdated: "pnpm -r outdated",
                test: "vis run test:unit",
            },
            new Set(["e2e", "test:unit"]),
        );

        expect(Object.keys(scripts ?? {})).toStrictEqual(["outdated", "test"]);
    });
});
