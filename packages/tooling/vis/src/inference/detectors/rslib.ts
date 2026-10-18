import type { Detector } from "../types";

export const rslibDetector: Detector = {
    configFiles: ["rslib.config.ts", "rslib.config.js", "rslib.config.mjs", "rslib.config.mts", "rslib.config.cjs", "rslib.config.cts"],
    // Library builds (Rslib) have no dev server; `dev` is the watch build, which
    // runs until stopped, so it is marked as a server preset.
    detect: ({ matchedConfigs }) => {
        return {
            targets: {
                build: {
                    command: "rslib build",
                    description: "rslib library build (inferred)",
                    inputs: ["{projectRoot}/src/**/*", `{projectRoot}/${matchedConfigs[0]!}`, "{projectRoot}/package.json", "{projectRoot}/tsconfig.json"],
                    outputs: ["{projectRoot}/dist"],
                    type: "build",
                },
                dev: {
                    command: "rslib build --watch",
                    description: "rslib watch build (inferred)",
                    preset: "server",
                },
                // `pack` is the library build for `vis pack`. `build` stays for `vis build`.
                pack: {
                    command: "rslib build",
                    description: "rslib library build (inferred)",
                    inputs: ["{projectRoot}/src/**/*", `{projectRoot}/${matchedConfigs[0]!}`, "{projectRoot}/package.json", "{projectRoot}/tsconfig.json"],
                    outputs: ["{projectRoot}/dist"],
                    type: "build",
                },
            },
        };
    },
    name: "rslib",
};
