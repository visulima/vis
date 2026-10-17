import type { Detector } from "../types";

export const rspackDetector: Detector = {
    configFiles: ["rspack.config.ts", "rspack.config.js", "rspack.config.mjs", "rspack.config.mts", "rspack.config.cjs", "rspack.config.cts"],
    // No `fallbackDependency`, same as vite: @rspack/core is pulled in by other
    // toolchains. A root-level `rspack.config.*` is the signal that the project
    // builds itself with Rspack.
    detect: ({ matchedConfigs }) => {
        return {
            targets: {
                build: {
                    command: "rspack build",
                    description: "rspack production build (inferred)",
                    inputs: ["{projectRoot}/src/**/*", `{projectRoot}/${matchedConfigs[0]!}`, "{projectRoot}/package.json"],
                    outputs: ["{projectRoot}/dist"],
                    type: "build",
                },
                dev: {
                    command: "rspack serve",
                    description: "rspack dev server (inferred)",
                    preset: "server",
                },
                preview: {
                    command: "rspack preview",
                    description: "rspack preview server (inferred)",
                    preset: "server",
                },
            },
        };
    },
    name: "rspack",
};
