/**
 * The colour environments the native-vs-Node parity tests run both sides in.
 *
 * pail (the Node CLI's logger) colours the header of its log lines where `@visulima/is-ansi-color-supported` says
 * so, and the native binary decides with the same rules (`piped_colour_level` in `native/cli/src/term.rs`). A test
 * that wants its output independent of the machine it runs on drops every variable in {@link COLOUR_VARIABLES}
 * from the environment it builds, then adds the one environment of the case. A CI runner sets several of them
 * (`GITHUB_ACTIONS`, `GITHUB_WORKFLOW`, `TERM`, ...), so leaving them in would colour every case.
 */

/** Every variable the colour detection reads, plus the ones it ignores that people expect it to (`CLICOLOR_FORCE`). */
export const COLOUR_VARIABLES = [
    "AGENT_NAME",
    "APPVEYOR",
    "BUILDKITE",
    "CIRCLECI",
    "CI_NAME",
    "CLICOLOR_FORCE",
    "COLORTERM",
    "DRONE",
    "FORCE_COLOR",
    "GITEA_ACTIONS",
    "GITHUB_ACTIONS",
    "GITHUB_WORKFLOW",
    "GITLAB_CI",
    "NODE_DISABLE_COLORS",
    "NO_COLOR",
    "PM2_HOME",
    "TEAMCITY_VERSION",
    "TERM",
    "TERMINAL_EMULATOR",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TF_BUILD",
    "TRAVIS",
    "pm_id",
] as const;

/** `env` without the variables the colour detection reads. */
export const withoutColour = <T extends Record<string, string | undefined>>(env: T): T =>
    Object.fromEntries(Object.entries(env).filter(([key]) => !(COLOUR_VARIABLES as ReadonlyArray<string>).includes(key))) as T;

/**
 * The environments pail's detection tells apart: CI providers (level 3 and level 1), every `FORCE_COLOR` level,
 * `NO_COLOR` against a provider, a dumb or colour `TERM`, and the variables it ignores. All of them need a CI
 * marker (`CI=1`) from the test, which is what turns the native path on.
 */
export const COLOUR_ENVIRONMENTS: Record<string, string>[] = [
    { GITHUB_ACTIONS: "true" },
    { COLUMNS: "50", GITHUB_ACTIONS: "true" },
    { GITLAB_CI: "true" },
    { CIRCLECI: "true" },
    { BUILDKITE: "true" },
    { FORCE_COLOR: "0" },
    { FORCE_COLOR: "1" },
    { FORCE_COLOR: "2" },
    { FORCE_COLOR: "3" },
    { FORCE_COLOR: "true" },
    { FORCE_COLOR: "false", GITHUB_ACTIONS: "true" },
    { GITHUB_ACTIONS: "true", NO_COLOR: "1" },
    { TERM: "xterm-256color" },
    { GITHUB_ACTIONS: "true", TERM: "dumb" },
    { COLORTERM: "truecolor" },
    { TERM_PROGRAM: "vscode" },
    { CLICOLOR_FORCE: "1" },
];

/** A subset for the slow suites (the secrets scan, the workflow generator): one of each kind. */
export const SHORT_COLOUR_ENVIRONMENTS: Record<string, string>[] = [
    { GITHUB_ACTIONS: "true" },
    { COLUMNS: "50", GITHUB_ACTIONS: "true" },
    { GITLAB_CI: "true" },
    { FORCE_COLOR: "0" },
    { FORCE_COLOR: "1" },
    { FORCE_COLOR: "3" },
    { GITHUB_ACTIONS: "true", NO_COLOR: "1" },
    { GITHUB_ACTIONS: "true", TERM: "dumb" },
    { TERM: "xterm-256color" },
    { TERM_PROGRAM: "vscode" },
];

/**
 * Environments the native path leaves to Node: the Node runtime warns on stderr, with its process id, when
 * `FORCE_COLOR` is set together with `NO_COLOR` or `NODE_DISABLE_COLORS`.
 */
export const DELEGATED_COLOUR_ENVIRONMENTS: Record<string, string>[] = [
    { FORCE_COLOR: "1", NO_COLOR: "1" },
    { FORCE_COLOR: "0", NO_COLOR: "" },
    { FORCE_COLOR: "1", NODE_DISABLE_COLORS: "1" },
];
