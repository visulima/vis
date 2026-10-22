import { TOOL_SIGNATURES } from "../../util/tool-signatures";
import type { Detector } from "../types";

// No `fallbackDependency`: rslint exits with "no rslint config found" when there is no
// config, so a dependency alone would synthesize a lint target that always fails.
export const rslintDetector: Detector = {
    configFiles: TOOL_SIGNATURES.rslint.configFiles,
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
    name: "rslint",
};
