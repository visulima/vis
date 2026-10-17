export const DEFAULT_DEP_TYPES = ["dependencies", "devDependencies", "optionalDependencies"];

const VALID_DEP_TYPES = new Set([...DEFAULT_DEP_TYPES, "overrides", "peerDependencies", "pnpm.overrides", "resolutions"]);

export const parseCompositeCatalogName = (name: string): { depType: string; relativePath: string } | undefined => {
    const colonIndex = name.lastIndexOf(":");

    if (colonIndex === -1) {
        return undefined;
    }

    const depType = name.slice(colonIndex + 1);

    if (!VALID_DEP_TYPES.has(depType)) {
        return undefined;
    }

    return { depType, relativePath: name.slice(0, colonIndex) };
};
