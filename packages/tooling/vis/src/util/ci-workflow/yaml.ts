/**
 * The YAML the CI renderers emit by hand (so the generated files keep their
 * comments and layout): double-quoted scalars, `|` blocks for multi-line
 * strings, and maps/lists nested four spaces deeper per level.
 */

/** Anything the config types hold: scalars, lists and maps (interfaces included) of them. */
export type YamlValue = boolean | number | object | string;

/** Quotes a scalar for YAML: a JSON string is a valid double-quoted YAML scalar. */
export const yamlString = (value: string): string => JSON.stringify(value);

const yamlKey = (key: string): string => (/^[\w.-]+$/u.test(key) ? key : yamlString(key));

/** A scalar value; a multi-line string becomes a `|` block indented at `blockIndent`. */
export const yamlScalar = (value: boolean | number | string, blockIndent: string): string => {
    if (typeof value !== "string") {
        return String(value);
    }

    return value.includes("\n") ? `|\n${value.replace(/\n$/u, "").split("\n").map((line) => `${blockIndent}${line}`).join("\n")}` : yamlString(value);
};

const isScalar = (value: unknown): value is boolean | number | string => typeof value === "boolean" || typeof value === "number" || typeof value === "string";

/** A map's members as `key: value` lines at `indent`, leaving out undefined ones. */
const mapEntries = (value: object, indent: string): string[] =>
    Object.entries(value).flatMap(([key, child]: [string, unknown]) => (isScalar(child) || (typeof child === "object" && child !== null) ? yamlEntry(key, child, indent) : []));

/** `key: value` lines at `indent`. Undefined map members are left out. */
export const yamlEntry = (key: string, value: YamlValue, indent: string): string[] => {
    const nested = `${indent}    `;

    if (typeof value !== "object") {
        return [`${indent}${yamlKey(key)}: ${yamlScalar(value, nested)}`];
    }

    if (!Array.isArray(value)) {
        return [`${indent}${yamlKey(key)}:`, ...mapEntries(value, nested)];
    }

    return [
        `${indent}${yamlKey(key)}:`,
        ...(value).flatMap((item) => {
            if (isScalar(item)) {
                return [`${nested}- ${yamlScalar(item, `${nested}    `)}`];
            }

            // A map item: its first line carries the `- `, the rest line up under it.
            const [first = "", ...rest] = typeof item === "object" && item !== null ? mapEntries(item, `${nested}  `) : [];

            return [`${nested}- ${first.trimStart()}`, ...rest];
        }),
    ];
};
