import type { DetectedTargets, Detector } from "../types";

export const rstestDetector: Detector = {
    configFiles: ["rstest.config.ts", "rstest.config.js", "rstest.config.mjs", "rstest.config.mts", "rstest.config.cjs"],
    detect: ({ hasConfigFile, matchedConfigs }) => {
        const configRef = matchedConfigs[0] ? `{projectRoot}/${matchedConfigs[0]}` : undefined;
        const targets: DetectedTargets["targets"] = {
            test: {
                command: "rstest run",
                description: "rstest run (inferred)",
                inputs: [
                    "{projectRoot}/src/**/*",
                    "{projectRoot}/__tests__/**/*",
                    "{projectRoot}/test/**/*",
                    "{projectRoot}/tests/**/*",
                    ...(configRef ? [configRef] : []),
                    "{projectRoot}/package.json",
                ],
                outputs: ["{projectRoot}/coverage"],
                type: "test",
            },
        };

        // Same rule as vitest: watch mode only when a config file exists, so a
        // dependency-only match does not add a long-running watcher.
        if (hasConfigFile) {
            targets["test:watch"] = {
                command: "rstest watch",
                description: "rstest watch mode (inferred)",
                preset: "server",
            };
        }

        return { targets };
    },
    fallbackDependency: "@rstest/core",
    name: "rstest",
};
