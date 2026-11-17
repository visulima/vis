import { closeSync, openSync, readSync } from "node:fs";

const MAGIC_BYTES = 4;

// Mach-O (thin, both byte orders, 32/64-bit) and universal (fat) binaries, ELF, and PE ("MZ").
const MACH_O_AND_ELF_MAGICS = new Set(["7f454c46", "cafebabe", "cefaedfe", "cffaedfe", "feedface", "feedfacf"]);

/**
 * True when `filePath` starts with an executable-format magic number, i.e. it is
 * a native binary that must be spawned directly instead of through Node. Any
 * read failure counts as "not native" so callers fall back to the Node launcher.
 */
export const isNativeExecutable = (filePath: string): boolean => {
    let descriptor: number | undefined;

    try {
        descriptor = openSync(filePath, "r");

        const buffer = Buffer.alloc(MAGIC_BYTES);
        const bytesRead = readSync(descriptor, buffer, 0, MAGIC_BYTES, 0);

        if (bytesRead >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
            return true;
        }

        return bytesRead === MAGIC_BYTES && MACH_O_AND_ELF_MAGICS.has(buffer.toString("hex"));
    } catch {
        return false;
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
    }
};

/**
 * Command, argv and default environment used to run the vis CLI at `visBin`.
 *
 * A native binary is spawned directly, so the Node launcher never runs to set
 * `VIS_NODE`; the binary would then look `node` up on `PATH`, which an MCP
 * server may not have. Default it to the Node running this server.
 */
export const visCommand = (visBin: string, args: ReadonlyArray<string>): { args: string[]; command: string; env: Record<string, string> } => {
    if (isNativeExecutable(visBin)) {
        return { args: [...args], command: visBin, env: { VIS_NODE: process.execPath } };
    }

    return { args: [visBin, ...args], command: process.execPath, env: {} };
};
