/**
 * Which implementation `runConcurrently` runs commands on.
 *
 * The native runner is the default. `VIS_CONCURRENT_RUNNER=js` selects the TypeScript spawner
 * (`runConcurrentFallback`) instead. That switch is an escape hatch for one release: it is
 * removed together with the spawner in the next release.
 */

type ConcurrentRunnerKind = "js" | "native";

const ENVIRONMENT_VARIABLE = "VIS_CONCURRENT_RUNNER";

const LEGACY_RUNNER_NOTICE = `@visulima/task-runner: using the legacy JS runner (${ENVIRONMENT_VARIABLE}=js); it is removed in the next release.`;

let noticeShown = false;
let unknownValueShown: string | undefined;

/**
 * Reads `VIS_CONCURRENT_RUNNER`: `js` selects the TypeScript spawner; unset, empty or `native`
 * selects the native runner. Any other value is a typo, so it is reported once on stderr and the
 * native runner (the default) is used, rather than failing every run over an environment variable.
 */
const resolveConcurrentRunner = (): ConcurrentRunnerKind => {
    const value = process.env[ENVIRONMENT_VARIABLE]?.trim().toLowerCase();

    if (value === "js") {
        if (!noticeShown) {
            noticeShown = true;
            process.stderr.write(`${LEGACY_RUNNER_NOTICE}\n`);
        }

        return "js";
    }

    if (value && value !== "native" && unknownValueShown !== value) {
        unknownValueShown = value;
        process.stderr.write(`@visulima/task-runner: ignoring ${ENVIRONMENT_VARIABLE}=${value}; expected "js" or "native". Using the native runner.\n`);
    }

    return "native";
};

export type { ConcurrentRunnerKind };
export { ENVIRONMENT_VARIABLE, LEGACY_RUNNER_NOTICE, resolveConcurrentRunner };
