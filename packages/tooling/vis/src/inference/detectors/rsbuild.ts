import type { Detector } from "../types";

export const rsbuildDetector: Detector = {
    configFiles: ["rsbuild.config.ts", "rsbuild.config.js", "rsbuild.config.mjs", "rsbuild.config.mts", "rsbuild.config.cjs", "rsbuild.config.cts"],
    // No `fallbackDependency`, same as rspack: a root-level `rsbuild.config.*` is the
    // signal that the project builds itself with Rsbuild.
    detect: ({ matchedConfigs }) => {
        return {
            targets: {
                build: {
                    command: "rsbuild build",
                    description: "rsbuild production build (inferred)",
                    inputs: ["{projectRoot}/src/**/*", `{projectRoot}/${matchedConfigs[0]!}`, "{projectRoot}/package.json"],
                    outputs: ["{projectRoot}/dist"],
                    type: "build",
                },
                dev: {
                    command: "rsbuild dev",
                    description: "rsbuild dev server (inferred)",
                    preset: "server",
                },
                preview: {
                    command: "rsbuild preview",
                    description: "rsbuild preview server (inferred)",
                    preset: "server",
                },
            },
        };
    },
    name: "rsbuild",
};
