import type { CerebroFs } from "@visulima/cerebro";
import { dirname, join } from "@visulima/path";

/** A file a `vis sync` kind renders. */
export interface GeneratedFile {
    content: string;
    /** Workspace-root-relative output path. */
    path: string;
}

export interface SyncGeneratedFilesOptions {
    fs: CerebroFs;
    /**
     * Whether the file on disk already matches the rendered content. Defaults
     * to comparing the text with surrounding whitespace trimmed.
     */
    isCurrent?: (existing: string, generated: string) => boolean;
    logger: Pick<Console, "error" | "info">;
    /** `write` writes every file; `check` only reports the stale ones. */
    mode: "check" | "write";
    /** Command named in the "is out of date" message. */
    regenerateCommand: string;
    root: string;
}

const readIfExists = async (fs: CerebroFs, path: string): Promise<string> => {
    try {
        return await fs.readFile(path, "utf8");
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "";
        }

        throw error;
    }
};

/**
 * Writes generated files, or in check mode logs each one whose on-disk copy
 * is stale. Returns the stale paths (always empty in write mode); the caller
 * decides the exit code.
 */
export const syncGeneratedFiles = async (
    files: ReadonlyArray<GeneratedFile>,
    { fs, isCurrent = (existing, generated) => existing.trim() === generated.trim(), logger, mode, regenerateCommand, root }: SyncGeneratedFilesOptions,
): Promise<{ stale: string[] }> => {
    const stale: string[] = [];

    for (const file of files) {
        const outPath = join(root, file.path);

        if (mode === "write") {
            await fs.mkdir(dirname(outPath), { recursive: true });
            await fs.writeFile(outPath, file.content);
            logger.info(`Wrote ${file.path}`);

            continue;
        }

        if (!isCurrent(await readIfExists(fs, outPath), file.content)) {
            logger.error(`${file.path} is out of date. Run \`${regenerateCommand}\` to update it.`);
            stale.push(file.path);
        }
    }

    return { stale };
};
