/**
 * True when `pid` names a live process this user can signal. Signal 0 sends
 * nothing; it only checks that the process exists and is reachable.
 */
export const isPidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};
