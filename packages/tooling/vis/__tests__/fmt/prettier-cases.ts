/**
 * Prettier configs shared by the mapper tests and the oracle test, which feeds the same
 * files to `oxfmt --migrate prettier` and compares the result with the mapper's.
 */
export interface PrettierCase {
    /** Files written into the project root, keyed by name. */
    files: Record<string, string>;
    name: string;
}

const json = (value: unknown): string => JSON.stringify(value);

export const PRETTIER_CASES: ReadonlyArray<PrettierCase> = [
    { files: { ".prettierrc.json": json({}) }, name: "empty" },
    { files: { ".prettierrc.json": json({ printWidth: 100, semi: false, singleQuote: true, tabWidth: 4 }) }, name: "common-options" },
    {
        files: {
            ".prettierrc.json": json({
                arrowParens: "avoid",
                bracketSameLine: true,
                bracketSpacing: false,
                embeddedLanguageFormatting: "off",
                endOfLine: "crlf",
                experimentalOperatorPosition: "start",
                htmlWhitespaceSensitivity: "ignore",
                jsxSingleQuote: true,
                objectWrap: "collapse",
                proseWrap: "never",
                quoteProps: "consistent",
                singleAttributePerLine: true,
                trailingComma: "es5",
                useTabs: true,
                vueIndentScriptAndStyle: true,
            }),
        },
        name: "every-copied-option",
    },
    {
        files: {
            ".prettierrc.json": json({
                $schema: "https://json.schemastore.org/prettierrc",
                endOfLine: "auto",
                experimentalTernaries: true,
                foo: 1,
                insertPragma: true,
                requirePragma: true,
                semi: false,
            }),
        },
        name: "dropped-options",
    },
    { files: { ".prettierrc": json({ semi: false }) }, name: "extensionless-json" },
    { files: { "package.json": json({ name: "x", prettier: { singleQuote: true } }) }, name: "package-json-key" },
    { files: { "prettier.config.mjs": "export default { semi: false, trailingComma: 'none' };\n" }, name: "esm-config" },
    { files: { "prettier.config.cjs": "module.exports = { semi: false, tabWidth: 8 };\n" }, name: "cjs-config" },
    {
        files: { ".prettierrc.json": json({ plugins: ["prettier-plugin-packagejson"] }) },
        name: "packagejson-plugin",
    },
    {
        files: {
            ".prettierrc.json": json({
                plugins: ["prettier-plugin-tailwindcss"],
                tailwindAttributes: ["x", "/^data-/"],
                tailwindConfig: "./tw.config.js",
                tailwindFunctions: ["cn", "/^tw/"],
                tailwindPreserveDuplicates: true,
                tailwindPreserveWhitespace: true,
                tailwindStylesheet: "./app.css",
            }),
        },
        name: "tailwind-plugin",
    },
    { files: { ".prettierrc.json": json({ plugins: ["prettier-plugin-tailwindcss"] }) }, name: "tailwind-plugin-without-options" },
    {
        files: {
            ".prettierrc.json": json({
                astroAllowShorthand: false,
                astroCompressHTML: true,
                astroSkipFrontmatter: true,
                plugins: ["prettier-plugin-svelte", "prettier-plugin-astro"],
                svelteAllowShorthand: false,
                svelteIndentScriptAndStyle: false,
                svelteSortOrder: "scripts-markup-options-styles",
            }),
        },
        name: "svelte-and-astro-plugins",
    },
    {
        files: { ".prettierrc.json": json({ astroCompressHTML: false, plugins: ["prettier-plugin-astro"] }) },
        name: "astro-compress-html-false",
    },
    {
        files: { ".prettierrc.json": json({ plugins: ["prettier-plugin-organize-imports", "prettier-plugin-jsdoc"], semi: false, svelteSortOrder: "none" }) },
        name: "unknown-plugins",
    },
    {
        files: {
            ".prettierrc.json": json({
                overrides: [
                    { files: "*.md", options: { printWidth: 60, proseWrap: "always" } },
                    { excludeFiles: "c.js", files: ["a.js", "b.js"], options: { semi: true } },
                    { files: "*.json", options: { parser: "json5" } },
                    { files: "*.weird", options: { parser: "my-parser" } },
                    { files: "*.empty", options: {} },
                    { files: "*.nooptions" },
                    { files: "*.mixed", options: { parser: "babel", semi: false, unknown: 1 } },
                ],
                plugins: ["prettier-plugin-tailwindcss"],
            }),
        },
        name: "overrides",
    },
    {
        files: {
            ".prettierignore": "dist\n# comment\n\n  foo/*.js  \n!keep.js\n",
            ".prettierrc.json": json({ semi: false }),
        },
        name: "prettierignore",
    },
];

/** Cases the oracle cannot run: it rejects these config formats, so only the readers are tested. */
export const UNSUPPORTED_BY_MIGRATE: ReadonlyArray<PrettierCase & { expected: Record<string, unknown> }> = [
    { expected: { printWidth: 90, semi: false }, files: { ".prettierrc.yaml": "semi: false\nprintWidth: 90\n" }, name: "yaml" },
    { expected: { printWidth: 80, semi: false }, files: { ".prettierrc.yml": "semi: false\n" }, name: "yml" },
    { expected: { printWidth: 80, tabWidth: 3 }, files: { ".prettierrc.toml": "tabWidth = 3\n" }, name: "toml" },
    { expected: { printWidth: 80, semi: false }, files: { ".prettierrc.json5": "{ semi: false, // comment\n}\n" }, name: "json5" },
    { expected: { printWidth: 80, semi: false }, files: { ".prettierrc": "semi: false\n" }, name: "extensionless-yaml" },
];
