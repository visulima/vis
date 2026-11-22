//! Terminal facts the help output depends on: colour on/off and width, and the
//! Windows console mode that lets the colour codes render.

use std::env;
use std::io::IsTerminal;

/// What the colour flags and variables say, before looking at a terminal: the Node CLI's precedence
/// order is an explicit `--color` / `--no-color` flag, then `FORCE_COLOR`, then `NO_COLOR`.
fn colour_requested(args: &[String]) -> Option<bool> {
    for argument in args {
        match argument.as_str() {
            "--" => break,
            "--no-color" | "--no-colors" | "--color=false" | "--color=never" => return Some(false),
            "--color" | "--colors" | "--color=true" | "--color=always" => return Some(true),
            _ => {}
        }
    }

    if let Ok(force) = env::var("FORCE_COLOR") {
        return Some(!matches!(force.as_str(), "0" | "false"));
    }

    if env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty()) {
        return Some(false);
    }

    None
}

/// Whether a terminal that can show colour is behind the stream. On Windows the console only shows
/// colour once virtual-terminal processing is on.
fn can_show_colour(is_terminal: bool) -> bool {
    is_terminal && env::var("TERM").map_or(true, |term| term != "dumb") && enable_virtual_terminal()
}

/// Whether colour codes should be emitted on stdout: the flags and variables, then whether stdout is
/// a terminal that can show colour.
pub fn color_enabled(args: &[String]) -> bool {
    colour_requested(args).unwrap_or_else(|| can_show_colour(std::io::stdout().is_terminal()))
}

/// Like [`color_enabled`], for output that goes to stderr: `vis cache 2>log` must not write colour
/// codes into the log, nor lose them on a terminal when stdout is piped.
pub fn color_enabled_stderr(args: &[String]) -> bool {
    colour_requested(args).unwrap_or_else(|| can_show_colour(std::io::stderr().is_terminal()))
}

/// An argument the colour detection of the Node CLI reads from `argv` (`--color`, `--no-color`,
/// `--color=256`, ...). `bin.ts` also turns `--no-color` into `NO_COLOR` / `FORCE_COLOR` for the process.
fn is_colour_flag(argument: &str) -> bool {
    let name = argument.trim_start_matches('-');

    argument.starts_with('-') && (name.starts_with("color") || name.starts_with("no-color"))
}

/// JavaScript's `Number.parseInt(text, 10)`: optional leading whitespace, optional sign, then the
/// leading digits. `None` is `NaN`.
fn parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let end = digits.bytes().position(|byte| !byte.is_ascii_digit()).unwrap_or(digits.len());

    if end == 0 {
        return None;
    }

    let magnitude = digits[..end].parse::<i64>().unwrap_or(i64::MAX);

    Some(if negative { -magnitude } else { magnitude })
}

/// `/^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/`: the TeamCity versions that print colour.
fn teamcity_colours(version: &str) -> bool {
    let digits = version.bytes().take_while(u8::is_ascii_digit).count();

    if digits >= 2 && version.as_bytes().get(digits) == Some(&b'.') {
        return true;
    }

    version.strip_prefix("9.").is_some_and(|rest| {
        let run = rest.bytes().take_while(u8::is_ascii_digit).count();

        rest.as_bytes().get(run) == Some(&b'.') && rest[..run].bytes().any(|byte| byte != b'0')
    })
}

/// Whether the Node runtime warns on stderr about the colour variables, with its process id in the text:
/// `FORCE_COLOR` is set together with `NO_COLOR` or `NODE_DISABLE_COLORS`. Native commands that print no colour
/// themselves still leave such a run to Node, because the warning is part of its output.
pub(crate) fn node_warns_about_colour() -> bool {
    colour_variables_conflict(&|name| env::var_os(name).is_some())
}

fn colour_variables_conflict(has: &dyn Fn(&str) -> bool) -> bool {
    has("FORCE_COLOR") && (has("NO_COLOR") || has("NODE_DISABLE_COLORS"))
}

/// The colour level `@visulima/is-ansi-color-supported` (0 none, 1 sixteen colours, 2 256, 3 true
/// colour) reports for a process that is not on a Windows machine and whose streams are not
/// terminals, read from `get` (the environment). The rules are those of its `createIsColorSupported`,
/// in order: `FORCE_COLOR`, `NO_COLOR`, a dumb or mono `TERM`, the CI providers, then the terminal
/// hints. `None` is a case it cannot decide without a terminal (a PM2 process, which Node treats as
/// one) and the case where the Node runtime itself warns on stderr, with its process id in the
/// text: `FORCE_COLOR` together with `NO_COLOR` or `NODE_DISABLE_COLORS`.
fn level_from(get: &dyn Fn(&str) -> Option<String>) -> Option<u8> {
    let has = |name: &str| get(name).is_some();

    if colour_variables_conflict(&has) {
        return None;
    }

    let force = get("FORCE_COLOR");
    let forced = match force.as_deref() {
        Some("true") => Some(1),
        Some("false") => Some(0),
        Some("") => Some(1),
        Some(text) => parse_int(text).map(|number| number.clamp(0, 3) as u8),
        None => None,
    };

    // A numeric `FORCE_COLOR` (and the empty one) is the answer, before any other variable is read.
    if !matches!(force.as_deref(), Some("true" | "false")) {
        if let Some(level) = forced {
            return Some(level);
        }
    }

    let force_true = force.as_deref() == Some("true");

    if (force.is_some() && forced == Some(0)) || (!force_true && has("NO_COLOR")) {
        return Some(0);
    }

    let fallback = forced.unwrap_or(0);
    let term = get("TERM").filter(|term| !term.is_empty());

    if has("TF_BUILD") && has("AGENT_NAME") {
        return Some(1);
    }

    if let Some(term) = &term {
        let lower = term.to_ascii_lowercase();

        if lower.contains("-mono") || lower.contains("dumb") {
            return Some(fallback);
        }
    }

    if has("CI") {
        if ["GITEA_ACTIONS", "CIRCLECI", "GITHUB_WORKFLOW", "GITHUB_ACTIONS"].iter().any(|name| has(name)) {
            return Some(3);
        }

        if ["TRAVIS", "APPVEYOR", "GITLAB_CI", "BUILDKITE", "DRONE"].iter().any(|name| has(name))
            || get("CI_NAME").as_deref() == Some("codeship")
        {
            return Some(1);
        }

        return Some(fallback);
    }

    if get("TERMINAL_EMULATOR").is_some_and(|value| value.contains("JediTerm")) {
        return Some(3);
    }

    if let Some(version) = get("TEAMCITY_VERSION") {
        return Some(u8::from(teamcity_colours(&version)));
    }

    if get("COLORTERM").as_deref() == Some("truecolor")
        || matches!(get("TERM").as_deref(), Some("xterm-kitty" | "xterm-ghostty" | "wezterm"))
    {
        return Some(3);
    }

    if has("TERM_PROGRAM") {
        let major =
            get("TERM_PROGRAM_VERSION").and_then(|version| parse_int(version.split('.').next().unwrap_or_default()));

        match get("TERM_PROGRAM").as_deref() {
            Some("iTerm.app") => return Some(if major.is_some_and(|major| major >= 3) { 3 } else { 2 }),
            Some("Apple_Terminal") => return Some(2),
            _ => {}
        }
    }

    // `/-256(color)?$/i`
    if term.as_deref().is_some_and(|term| {
        let lower = term.to_ascii_lowercase();

        lower.ends_with("-256") || lower.ends_with("-256color")
    }) {
        return Some(2);
    }

    // Node counts a PM2 process as a terminal, which the checks below would then ask `TERM` about.
    if has("PM2_HOME") && has("pm_id") {
        return None;
    }

    Some(if has("COLORTERM") { 1 } else { fallback })
}

/// The colour level pail's output carries when neither stream is a terminal, or `None` when the
/// native path cannot tell and Node has to answer: a terminal, Windows, a colour flag among the
/// arguments, or a PM2 process. Level 0 is plain text, every other level makes pail wrap the same
/// sixteen-colour codes around the header of its log lines.
pub fn piped_colour_level(args: &[String]) -> Option<u8> {
    if cfg!(windows)
        || std::io::stdout().is_terminal()
        || std::io::stderr().is_terminal()
        || args.iter().any(|argument| is_colour_flag(argument))
    {
        return None;
    }

    level_from(&|name| env::var_os(name).map(|value| value.to_string_lossy().into_owned()))
}

fn positive(value: Option<String>) -> Option<usize> {
    value.and_then(|text| text.trim().parse::<usize>().ok()).filter(|&number| number > 0)
}

/// Terminal width: `CEREBRO_TERMINAL_WIDTH`, else the tty size, else `COLUMNS`, else 80.
pub fn terminal_width() -> usize {
    if let Some(width) = positive(env::var("CEREBRO_TERMINAL_WIDTH").ok()) {
        return width;
    }

    // stdout first, then stderr, as the Node CLI does (stdin is not consulted).
    let size = terminal_size::terminal_size_of(std::io::stdout())
        .or_else(|| terminal_size::terminal_size_of(std::io::stderr()));

    if let Some((terminal_size::Width(columns), _)) = size {
        if columns > 0 {
            return usize::from(columns);
        }
    }

    positive(env::var("COLUMNS").ok()).unwrap_or(80)
}

/// Make a Windows console render the ANSI codes the native output prints (colour, styling).
/// A legacy console prints them as literal `←[1m` text until `ENABLE_VIRTUAL_TERMINAL_PROCESSING`
/// is set on the screen buffer. Handles that are not a console (a pipe, a file) are left alone,
/// and a console too old to know the flag keeps its mode, which is the state before this call.
/// Returns whether stdout ends up able to interpret ANSI codes: always `true` outside Windows.
pub fn enable_virtual_terminal() -> bool {
    #[cfg(windows)]
    {
        windows_console::enable()
    }

    #[cfg(not(windows))]
    {
        true
    }
}

#[cfg(windows)]
mod windows_console {
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_ERROR_HANDLE,
        STD_OUTPUT_HANDLE,
    };

    /// Switch the flag on for stdout and stderr; the result is stdout's final state.
    pub fn enable() -> bool {
        let mut stdout_ready = false;

        for which in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            // SAFETY: the handle comes from `GetStdHandle` and is only passed to console
            // calls that report failure through their return value; `mode` outlives the call.
            let ready = unsafe {
                let handle = GetStdHandle(which);
                let mut mode = 0_u32;

                // Fails for an invalid handle or a non-console one: nothing to switch on.
                !handle.is_null()
                    && GetConsoleMode(handle, &mut mode) != 0
                    && (mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0
                        || SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0)
            };

            if which == STD_OUTPUT_HANDLE {
                stdout_ready = ready;
            }
        }

        stdout_ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(pairs: &[(&str, &str)]) -> Option<u8> {
        level_from(&|name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned()))
    }

    #[test]
    fn a_plain_environment_has_no_colour() {
        assert_eq!(level(&[]), Some(0));
        assert_eq!(level(&[("CI", "1")]), Some(0));
    }

    #[test]
    fn the_ci_providers_set_their_level() {
        assert_eq!(level(&[("CI", "1"), ("GITHUB_ACTIONS", "true")]), Some(3));
        assert_eq!(level(&[("CI", "1"), ("GITHUB_WORKFLOW", "x")]), Some(3));
        assert_eq!(level(&[("CI", "1"), ("CIRCLECI", "true")]), Some(3));
        assert_eq!(level(&[("CI", "1"), ("GITLAB_CI", "true")]), Some(1));
        assert_eq!(level(&[("CI", "1"), ("BUILDKITE", "true")]), Some(1));
        assert_eq!(level(&[("CI", "1"), ("CI_NAME", "codeship")]), Some(1));
        assert_eq!(level(&[("CI", "1"), ("CI_NAME", "other")]), Some(0));
        // The provider rules sit behind `CI`, and `CI=0` still counts as set.
        assert_eq!(level(&[("GITHUB_ACTIONS", "true")]), Some(0));
        assert_eq!(level(&[("CI", "0"), ("GITHUB_ACTIONS", "true")]), Some(3));
    }

    #[test]
    fn force_color_wins_and_clamps() {
        for (value, expected) in
            [("0", 0), ("1", 1), ("2", 2), ("3", 3), ("7", 3), ("-2", 0), ("", 1), ("2x", 2), (" 1", 1)]
        {
            assert_eq!(
                level(&[("FORCE_COLOR", value), ("CI", "1"), ("GITLAB_CI", "1")]),
                Some(expected),
                "FORCE_COLOR={value:?}"
            );
        }

        assert_eq!(level(&[("FORCE_COLOR", "true")]), Some(1));
        // Node warns on stderr (with its pid) when both are set, so the native path never answers.
        assert_eq!(level(&[("FORCE_COLOR", "true"), ("NO_COLOR", "1")]), None);
        assert_eq!(level(&[("FORCE_COLOR", "0"), ("NO_COLOR", "")]), None);
        assert_eq!(level(&[("FORCE_COLOR", "1"), ("NODE_DISABLE_COLORS", "1")]), None);
        // `NODE_DISABLE_COLORS` alone is not read by the detection.
        assert_eq!(level(&[("NODE_DISABLE_COLORS", "1"), ("CI", "1"), ("GITHUB_ACTIONS", "1")]), Some(3));
        assert_eq!(level(&[("FORCE_COLOR", "false"), ("GITHUB_ACTIONS", "1"), ("CI", "1")]), Some(0));
        assert_eq!(level(&[("FORCE_COLOR", "abc"), ("CI", "1"), ("GITHUB_ACTIONS", "1")]), Some(3));
    }

    #[test]
    fn no_color_beats_the_ci_providers_even_when_empty() {
        assert_eq!(level(&[("NO_COLOR", ""), ("CI", "1"), ("GITHUB_ACTIONS", "1")]), Some(0));
        assert_eq!(level(&[("NO_COLOR", "1"), ("CI", "1"), ("GITLAB_CI", "1")]), Some(0));
    }

    #[test]
    fn a_dumb_or_mono_term_falls_back_to_force_color_only() {
        assert_eq!(level(&[("TERM", "dumb"), ("CI", "1"), ("GITHUB_ACTIONS", "1")]), Some(0));
        assert_eq!(level(&[("TERM", "xterm-mono"), ("CI", "1"), ("GITHUB_ACTIONS", "1")]), Some(0));
        // `mono` alone (no dash) is not the pattern.
        assert_eq!(level(&[("TERM", "mono"), ("CI", "1"), ("GITHUB_ACTIONS", "1")]), Some(3));
    }

    #[test]
    fn terminal_hints_outside_ci() {
        assert_eq!(level(&[("COLORTERM", "truecolor")]), Some(3));
        assert_eq!(level(&[("COLORTERM", "yes")]), Some(1));
        assert_eq!(level(&[("TERM", "xterm-256color")]), Some(2));
        assert_eq!(level(&[("TERM", "xterm")]), Some(0));
        assert_eq!(level(&[("TERM", "xterm-kitty")]), Some(3));
        assert_eq!(level(&[("TERM_PROGRAM", "iTerm.app"), ("TERM_PROGRAM_VERSION", "3.4.1")]), Some(3));
        assert_eq!(level(&[("TERM_PROGRAM", "iTerm.app"), ("TERM_PROGRAM_VERSION", "2.9")]), Some(2));
        assert_eq!(level(&[("TERM_PROGRAM", "Apple_Terminal")]), Some(2));
        assert_eq!(level(&[("TERM_PROGRAM", "vscode")]), Some(0));
        assert_eq!(level(&[("TERMINAL_EMULATOR", "JetBrains-JediTerm")]), Some(3));
        assert_eq!(level(&[("TF_BUILD", "True"), ("AGENT_NAME", "a")]), Some(1));
    }

    #[test]
    fn teamcity_versions() {
        assert_eq!(level(&[("TEAMCITY_VERSION", "9.1.7")]), Some(1));
        assert_eq!(level(&[("TEAMCITY_VERSION", "9.0.7")]), Some(0));
        assert_eq!(level(&[("TEAMCITY_VERSION", "10.0.1")]), Some(1));
        assert_eq!(level(&[("TEAMCITY_VERSION", "8.1.5")]), Some(0));
    }

    #[test]
    fn a_pm2_process_is_left_to_node() {
        assert_eq!(level(&[("PM2_HOME", "/x"), ("pm_id", "0")]), None);
        assert_eq!(level(&[("PM2_HOME", "/x")]), Some(0));
        // The CI providers are checked first, so a CI marker settles the level.
        assert_eq!(level(&[("CI", "1"), ("PM2_HOME", "/x"), ("pm_id", "0")]), Some(0));
        assert_eq!(level(&[("CI", "1"), ("GITHUB_ACTIONS", "1"), ("PM2_HOME", "/x"), ("pm_id", "0")]), Some(3));
    }

    #[test]
    fn colour_flags_are_recognised() {
        for flag in ["--color", "--no-color", "--colors", "--color=256", "--no-colors", "-color"] {
            assert!(is_colour_flag(flag), "{flag}");
        }

        for flag in ["colour", "--cwd", "--format", "color"] {
            assert!(!is_colour_flag(flag), "{flag}");
        }
    }

    #[test]
    fn enabling_on_a_non_console_does_not_panic() {
        // Test output is captured through pipes on every platform, so this takes the no-console path.
        let _ = enable_virtual_terminal();
    }
}
