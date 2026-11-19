/**
 * Buffer all of stdin as UTF-8. Only called when a command actually opts into
 * piped input, so ordinary CLI invocations never wait on the stream.
 */
export const readStdin = async (): Promise<string> => {
    const chunks: string[] = [];

    for await (const chunk of process.stdin) {
        chunks.push(String(chunk));
    }

    return chunks.join("");
};
