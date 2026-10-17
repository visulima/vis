import { deleteEntry } from "../../services/registry";
import { cleanupEphemeralServices } from "./persistent-tasks";
import type { ServiceEventBridge } from "./service-event-bridge";

/**
 * SIGTERM the ephemeral service group + drop the scratch dir exactly
 * once. Run from the run-block's `finally`, AND from a Ctrl+C/SIGTERM
 * listener so children don't outlive the run when the dynamic TUI's
 * own `process.exit(1)` short-circuits the normal exit path.
 */
export const createRunCleanup = ({
    ephemeralPidFiles,
    registryStartedIds,
    registryStartedPids,
    serviceEventBridge,
    serviceRunDir,
    stopServicesOnExit,
    workspaceRoot,
}: {
    ephemeralPidFiles: string[];
    registryStartedIds: string[];
    registryStartedPids: Map<string, number>;
    serviceEventBridge: ServiceEventBridge | null;
    serviceRunDir: string | undefined;
    stopServicesOnExit: boolean | undefined;
    workspaceRoot: string;
}) => {
    let cleanupRan = false;
    const runCleanupOnce = (): void => {
        if (cleanupRan) {
            return;
        }

        cleanupRan = true;

        if (serviceEventBridge) {
            serviceEventBridge.dispose().catch(() => {});
        }

        // When --stop-services is set, also kill the registry-mode services
        // this run started. Their pids are captured by the bridge `started`
        // sink. Registry entries point at dead pids after this; `vis
        // service list` / `pruneDead` cleans them up later.
        const extraPids = stopServicesOnExit ? [...registryStartedPids.values()] : undefined;

        cleanupEphemeralServices({ extraPids, pidFiles: ephemeralPidFiles, runDir: serviceRunDir });
    };
    const onCleanupSignal = (): void => {
        runCleanupOnce();
    };
    const hasCleanupWork = ephemeralPidFiles.length > 0 || serviceRunDir !== undefined || (stopServicesOnExit && registryStartedIds.length > 0);

    return {
        /** Runs cleanup once, removes the signal listeners and deletes the registry entries this run stopped. */
        finish: async (): Promise<void> => {
            runCleanupOnce();

            if (hasCleanupWork) {
                process.off("SIGINT", onCleanupSignal);
                process.off("SIGTERM", onCleanupSignal);
            }

            // Clean exit path: also delete the registry entries for services
            // we just stopped so `vis service list` doesn't show stale rows.
            // The signal-handler path skips this — sync FS work in a SIGINT
            // handler is risky, and `pruneDead` reconciles dead entries on
            // demand anyway.
            if (stopServicesOnExit && registryStartedIds.length > 0) {
                await Promise.all(
                    registryStartedIds.map(async (id) => {
                        try {
                            await deleteEntry(workspaceRoot, id);
                        } catch {
                            // Best-effort — entry may already be gone.
                        }
                    }),
                );
            }
        },
        /** Installs the Ctrl+C/SIGTERM listeners when there is something to clean up. */
        install: (): void => {
            if (hasCleanupWork) {
                process.on("SIGINT", onCleanupSignal);
                process.on("SIGTERM", onCleanupSignal);
            }
        },
    };
};
