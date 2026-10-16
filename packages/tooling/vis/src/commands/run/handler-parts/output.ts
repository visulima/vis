/**
 * Maximum output buffer size per task (256 KB).
 */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Ring buffer that keeps the last `maxBytes` of appended text.
 * Avoids unbounded memory growth for long-running dev servers.
 */
export class OutputRingBuffer {
    readonly #maxBytes: number;

    #buffer = "";

    #truncated = false;

    constructor(maxBytes: number) {
        this.#maxBytes = maxBytes;
    }

    append(text: string): void {
        this.#buffer += text;

        if (this.#buffer.length > this.#maxBytes) {
            this.#buffer = this.#buffer.slice(-this.#maxBytes);
            this.#truncated = true;
        }
    }

    toString(): string {
        if (this.#truncated) {
            return `[...output truncated, showing last ${Math.round(this.#maxBytes / 1024)}KB...]\n${this.#buffer}`;
        }

        return this.#buffer;
    }
}
