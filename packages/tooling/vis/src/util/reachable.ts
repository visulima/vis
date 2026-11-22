/**
 * Every node reachable from `starts` by following one or more edges. A start
 * node is included only when a cycle leads back to it.
 */
export const reachableFrom = (starts: Iterable<string>, next: (node: string) => Iterable<string> | undefined): Set<string> => {
    const found = new Set<string>();
    const queue = [...starts].flatMap((start) => [...(next(start) ?? [])]);

    // An array iterator also visits elements pushed while it runs.
    for (const node of queue) {
        if (!found.has(node)) {
            found.add(node);
            queue.push(...(next(node) ?? []));
        }
    }

    return found;
};
