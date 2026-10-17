import type { Detector } from "../types";

export const rslintDetector: Detector = {
    configFiles: ["rslint.config.ts", "rslint.config.js", "rslint.config.mjs"],
    detect: ({ matchedConfigs }) => {
        return {
            targets: {
                lint: {
                    command: "rslint .",
                    description: "rslint . (inferred)",
                    inputs: [
                        "{projectRoot}/src/**/*",
                        "{projectRoot}/__tests__/**/*",
                        "{projectRoot}/test/**/*",
                        "{projectRoot}/tests/**/*",
                        ...matchedConfigs.map((file) => `{projectRoot}/${file}`),
                        "{projectRoot}/package.json",
                    ],
                    // Rslint emits diagnostics, not files, so the result is cacheable on input hash.
                    outputs: [],
                    type: "build",
                },
            },
        };
    },
    fallbackDependency: "@rslint/core",
    name: "rslint",
};
