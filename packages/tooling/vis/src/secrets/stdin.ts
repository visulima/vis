/** What reading standard input for a scan produced. */
export type StdinContent = { kind: "ok"; text: string } | { kind: "too-large" };

/**
 * Read a whole stream as UTF-8 text, giving up once it holds more than
 * `maxBytes` so an endless pipe can't exhaust memory. The scanner applies the
 * same cap to files (`--max-size`) and git blobs.
 */
export const readStdinText = async (stream: AsyncIterable<Buffer | string>, maxBytes: number): Promise<StdinContent> => {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of stream) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;

        size += buffer.length;

        if (size > maxBytes) {
            return { kind: "too-large" };
        }

        chunks.push(buffer);
    }

    return { kind: "ok", text: Buffer.concat(chunks).toString("utf8") };
};
