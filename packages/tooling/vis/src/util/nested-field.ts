/**
 * Sets `object[...path][key] = value` by dot path. Each missing or non-object
 * step (including the last `path` segment) is replaced with an empty object.
 */
export const setNestedField = (object: Record<string, unknown>, dotPath: string, key: string, value: string): void => {
    const parts = dotPath.split(".");
    let current: Record<string, unknown> = object;

    for (const part of parts.slice(0, -1)) {
        if (!current[part] || typeof current[part] !== "object") {
            current[part] = {};
        }

        current = current[part] as Record<string, unknown>;
    }

    const lastPart = parts.at(-1)!;

    if (!current[lastPart] || typeof current[lastPart] !== "object") {
        current[lastPart] = {};
    }

    (current[lastPart] as Record<string, string>)[key] = value;
};
