import { createInterface } from "node:readline";

import type { OutdatedEntry } from "./types";

export const promptPackageSelection = async (outdated: OutdatedEntry[]): Promise<OutdatedEntry[]> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const ask = (question: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(question, (answer) => {
                resolve(answer.trim());
            });
        });

    process.stdout.write("\nOutdated catalog dependencies:\n");

    for (const [index, element] of outdated.entries()) {
        if (!element) {
            continue;
        }

        process.stdout.write(`  ${String(index + 1)}. ${element.packageName}: ${element.currentRange} → ${element.newRange} (${element.updateType})\n`);
    }

    process.stdout.write("\n");

    const answer = await ask("Apply updates? [a]ll / [n]one / [s]elect: ");

    if (answer.toLowerCase() === "a" || answer.toLowerCase() === "all") {
        rl.close();

        return outdated;
    }

    if (answer.toLowerCase() === "n" || answer.toLowerCase() === "none") {
        rl.close();

        return [];
    }

    if (answer.toLowerCase() === "s" || answer.toLowerCase() === "select") {
        const selection = await ask("Enter numbers to apply (comma-separated): ");

        rl.close();

        const indices = selection
            .split(",")
            .map((s) => Number.parseInt(s.trim(), 10) - 1)
            .filter((i) => i >= 0 && i < outdated.length);

        return indices.map((i) => outdated[i]).filter((entry): entry is OutdatedEntry => entry !== undefined);
    }

    // Unrecognized input — default to no updates for safety
    rl.close();

    return [];
};
