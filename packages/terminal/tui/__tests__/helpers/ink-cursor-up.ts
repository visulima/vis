/* eslint-disable no-control-regex, sonarjs/no-control-regex -- the escape byte is what is being parsed */

const token = /\u001B\[([\d;?]*)([A-Za-z])|[^\u001B]+/gu;

// Escape sequences that leave the cursor's row alone, so a run of upward moves continues across them.
const keepsRow = new Set(["G", "h", "K", "l", "m"]);

/**
 * The most rows the cursor is moved up in one run: cursor-up sequences, and the one-row moves inside an erase,
 * count together until text is written or the cursor moves some other way.
 * @param writes Everything the renderer wrote.
 * @returns The longest run of upward moves.
 */
const longestUpRun = (writes: string[]): number => {
    let longest = 0;

    for (const write of writes) {
        let run = 0;

        for (const [, parameters, final] of write.matchAll(token)) {
            if (final === "A") {
                run += parameters === "" ? 1 : Number(parameters);
                longest = Math.max(longest, run);
            } else if (final === undefined || !keepsRow.has(final)) {
                run = 0;
            }
        }
    }

    return longest;
};

export default longestUpRun;
