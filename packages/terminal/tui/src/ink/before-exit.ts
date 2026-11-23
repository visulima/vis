import process from "node:process";

type ExitWaiter = { unmount: () => void };

// Instances waiting for the event loop to drain share one process listener, so many live instances do not trip the max-listeners warning.
const waiters = new Set<ExitWaiter>();

const onBeforeExit = (): void => {
    for (const waiter of waiters) {
        waiter.unmount();
    }
};

export const trackBeforeExit = (waiter: ExitWaiter): void => {
    if (waiters.size === 0) {
        process.on("beforeExit", onBeforeExit);
    }

    waiters.add(waiter);
};

export const untrackBeforeExit = (waiter: ExitWaiter): void => {
    if (waiters.delete(waiter) && waiters.size === 0) {
        process.off("beforeExit", onBeforeExit);
    }
};
