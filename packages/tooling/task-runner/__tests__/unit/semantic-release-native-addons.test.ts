import { describe, expect, it } from "vitest";

// eslint-disable-next-line import/no-relative-packages -- workspace release script, not a package entry point
import { isAlreadyPublishedError } from "../../../../../scripts/semantic-release-native-addons.mjs";

const publishError = (properties: { message?: string; stderr?: string; stdout?: string }): Error =>
    Object.assign(new Error(properties.message ?? "Command failed: pnpm publish"), properties);

describe(isAlreadyPublishedError, () => {
    it("detects the rejection when pnpm writes it to stdout", () => {
        expect.assertions(1);

        // pnpm 11 prints the registry report on stdout and leaves stderr empty,
        // so the message alone never contains the E403 text.
        const error = publishError({
            message: "Command failed: pnpm publish /repo/packages/pkg/npm/darwin-arm64 --tag latest --access public --no-git-checks\n",
            stderr: "",
            stdout: [
                "📦 @visulima/task-runner-binding-darwin-arm64@3.0.1 → https://registry.npmjs.org/",
                "[E403] 403 Forbidden - PUT https://registry.npmjs.org/@visulima%2ftask-runner-binding-darwin-arm64 - You cannot publish over the previously published versions: 3.0.1.",
            ].join("\n"),
        });

        expect(isAlreadyPublishedError(error)).toBe(true);
    });

    it("detects the rejection when it reaches the message", () => {
        expect.assertions(1);

        const error = publishError({
            message: "Command failed: npm publish\nnpm ERR! You cannot publish over the previously published versions: 3.0.1.",
        });

        expect(isAlreadyPublishedError(error)).toBe(true);
    });

    it("detects the npm legacy conflict code", () => {
        expect.assertions(1);

        expect(isAlreadyPublishedError(publishError({ message: "npm ERR! code EPUBLISHCONFLICT" }))).toBe(true);
    });

    it("does not treat an unrelated publish failure as already published", () => {
        expect.assertions(1);

        const error = publishError({
            message: "Command failed: pnpm publish",
            stderr: "[E401] 401 Unauthorized - PUT https://registry.npmjs.org/@visulima%2fvis - authentication token not found.",
            stdout: "",
        });

        expect(isAlreadyPublishedError(error)).toBe(false);
    });

    it("handles a non-Error rejection", () => {
        expect.assertions(2);

        expect(isAlreadyPublishedError("403 Forbidden: You cannot publish over the previously published versions")).toBe(true);
        expect(isAlreadyPublishedError(undefined)).toBe(false);
    });
});
