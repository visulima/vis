//! Terminal facts the help output depends on: colour on/off and width, and the
//! Windows console mode that lets the colour codes render.

use std::env;
use std::io::IsTerminal;

use crate::js::parse_int;

/// A standard stream the help text can be written to.
#[derive(Clone, Copy)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// SGR styling that turns itself off when colour is disabled. Like `colorize`, a style re-opens itself after the
/// close of an inner style that ends with the same code (`red a {green b} c` keeps `c` red).
#[derive(Clone, Copy)]
pub struct Style {
    pub colour: bool,
}

impl Style {
    pub fn paint(self, open: u8, close: u8, text: &str) -> String {
        if !self.colour || text.is_empty() {
            return text.to_owned();
        }

        let text = if text.contains('\x1b') {
            text.replace(&format!("\x1b[{close}m"), &format!("\x1b[{open}m"))
        } else {
            text.to_owned()
        };

        format!("\x1b[{open}m{text}\x1b[{close}m")
    }

    pub fn bold(self, text: &str) -> String {
        self.paint(1, 22, text)
    }

    pub fn dim(self, text: &str) -> String {
        self.paint(2, 22, text)
    }

    pub fn underline(self, text: &str) -> String {
        self.paint(4, 24, text)
    }

    pub fn red(self, text: &str) -> String {
        self.paint(31, 39, text)
    }

    pub fn green(self, text: &str) -> String {
        self.paint(32, 39, text)
    }

    pub fn yellow(self, text: &str) -> String {
        self.paint(33, 39, text)
    }

    pub fn cyan(self, text: &str) -> String {
        self.paint(36, 39, text)
    }
}

/// What a standard stream is on Windows. Every other platform has no console to switch on, and its
/// streams count as [`Console::Redirected`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
enum Console {
    /// A pipe, a file, or no handle: the codes are written as they are.
    Redirected,
    /// A console that interprets ANSI codes (virtual-terminal processing is on).
    Ansi,
    /// A console too old to switch virtual-terminal processing on; it prints the codes as text.
    Legacy,
}

/// Whether ANSI codes written to a stream in this state arrive as colour: only a legacy console prints them as text.
fn shows_ansi(console: Console) -> bool {
    console != Console::Legacy
}

/// Whether ANSI codes written to `stream` show as colour. Always true outside Windows. On Windows this is
/// the state recorded once by [`enable_virtual_terminal`] (not verified on a Windows machine).
fn stream_shows_ansi(stream: Stream) -> bool {
    #[cfg(windows)]
    {
        shows_ansi(windows_console::state()[stream as usize])
    }

    #[cfg(not(windows))]
    {
        let _ = stream;

        shows_ansi(Console::Redirected)
    }
}

/// A colour flag on the command line, as `@visulima/is-ansi-color-supported` reads it from `argv`: `^-{1,2}(...)$`
/// over the names below. [`ColourFlag::Other`] is any other argument that looks like one (`--color=banana`,
/// `--colorful`), which only Node can interpret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColourFlag {
    None,
    Ansi256,
    TrueColor,
    On,
    Other,
}

impl ColourFlag {
    pub fn parse(argument: &str) -> Option<Self> {
        let name = argument.strip_prefix("--").or_else(|| argument.strip_prefix('-'));

        match name {
            Some("no-color" | "no-colors" | "color=false" | "color=never") => Some(Self::None),
            Some("color=256") => Some(Self::Ansi256),
            Some("color=16m" | "color=full" | "color=truecolor") => Some(Self::TrueColor),
            Some("color" | "colors" | "color=true" | "color=always") => Some(Self::On),
            _ => {
                let name = argument.trim_start_matches('-');

                (argument.starts_with('-') && (name.starts_with("color") || name.starts_with("no-color")))
                    .then_some(Self::Other)
            }
        }
    }

    /// The two colour flags the Node CLI declares as global options (`--color`, `--no-color`), which a command
    /// may follow like any other valueless global flag. The spellings [`ColourFlag::parse`] also reads
    /// (`-color`, `--colors`, `--color=256`, ...) are not global options and leave the call to Node.
    pub fn is_global_option(argument: &str) -> bool {
        matches!(argument, "--no-color" | "--color")
    }
}

/// The colour flags up to the first `--`, in the order the detection tries them: no colour, 256 colours, true
/// colour, colour.
#[derive(Clone, Copy, Default)]
struct ColourFlags {
    none: bool,
    ansi256: bool,
    truecolor: bool,
    on: bool,
}

impl ColourFlags {
    fn from_args(args: &[String]) -> Self {
        let mut flags = Self::default();

        for argument in args.iter().take_while(|argument| argument.as_str() != "--") {
            match ColourFlag::parse(argument) {
                Some(ColourFlag::None) => flags.none = true,
                Some(ColourFlag::Ansi256) => flags.ansi256 = true,
                Some(ColourFlag::TrueColor) => flags.truecolor = true,
                Some(ColourFlag::On) => flags.on = true,
                Some(ColourFlag::Other) | None => {}
            }
        }

        flags
    }
}

/// Whether the help text written to `destination` carries colour codes, decided as the Node CLI decides it:
/// by the level `@visulima/is-ansi-color-supported` reports for **stdout** (the environment, the flags, then
/// whether stdout is a terminal), wherever the text goes. The listing of the bare `vis cache` goes to stderr
/// but is coloured by stdout's state. `None` when only Node can tell: see [`colour_from`].
pub fn help_colour(args: &[String], destination: Stream) -> Option<bool> {
    let colour = colour_from(
        args,
        &|name| env::var_os(name).map(|value| value.to_string_lossy().into_owned()),
        std::io::stdout().is_terminal(),
        cfg!(windows),
    )?;

    // Node's console layer paints codes for a legacy Windows console; this binary cannot.
    (!colour || stream_shows_ansi(destination)).then_some(colour)
}

/// [`help_colour`] over an environment and stdout's terminal state. `None` is what the binary leaves to
/// Node: the Node runtime warning on stderr about the colour variables, and the cases [`detect_level`]
/// cannot decide.
fn colour_from(
    args: &[String],
    get: &dyn Fn(&str) -> Option<String>,
    stdout_is_terminal: bool,
    windows: bool,
) -> Option<bool> {
    // `bin.ts` turns this exact argument, anywhere in argv, into `NO_COLOR=1` and `FORCE_COLOR=0`, after the
    // runtime has checked the variables it started with.
    if args.iter().any(|argument| argument == "--no-color") {
        return (!colour_variables_conflict(&|name| get(name).is_some())).then_some(false);
    }

    detect_level(get, ColourFlags::from_args(args), stdout_is_terminal, windows).map(|level| level > 0)
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
/// colour) reports for a process whose stdout is not a terminal, read from `get` (the environment): see
/// [`detect_level`].
fn level_from(get: &dyn Fn(&str) -> Option<String>) -> Option<u8> {
    detect_level(get, ColourFlags::default(), false, false)
}

/// `/^screen|^tmux|^xterm|^vt[1-5]\d\d|^ansi|color|mintty|rxvt|cygwin|linux/i`: the `TERM` values that make a
/// terminal show colour.
fn term_shows_colour(term: &str) -> bool {
    let lower = term.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let vt = bytes.len() >= 5
        && lower.starts_with("vt")
        && (b'1'..=b'5').contains(&bytes[2])
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit();

    ["screen", "tmux", "xterm", "ansi"].iter().any(|prefix| lower.starts_with(prefix))
        || vt
        || ["color", "mintty", "rxvt", "cygwin", "linux"].iter().any(|part| lower.contains(part))
}

/// The colour level of stdout in the process `get` describes, by the rules of `createIsColorSupported`, in
/// its order: `FORCE_COLOR`, `NO_COLOR` and the flags, a dumb or mono `TERM`, Windows, the CI providers, then
/// the terminal hints, the last of which asks whether stdout is a terminal (`stdout_is_terminal`). `None` is a
/// case it cannot decide here and Node has to answer: a PM2 process (Node treats it as a terminal), the
/// Windows build-number rule, and the case where the Node runtime itself warns on stderr, with its process
/// id in the text: `FORCE_COLOR` together with `NO_COLOR` or `NODE_DISABLE_COLORS`.
fn detect_level(
    get: &dyn Fn(&str) -> Option<String>,
    flags: ColourFlags,
    stdout_is_terminal: bool,
    windows: bool,
) -> Option<u8> {
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

    if (force.is_some() && forced == Some(0)) || flags.none || (!force_true && has("NO_COLOR")) {
        return Some(0);
    }

    if flags.ansi256 {
        return Some(2);
    }

    if flags.truecolor {
        return Some(3);
    }

    if flags.on {
        return Some(1);
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

    if windows {
        if has("WT_SESSION") {
            return Some(3);
        }

        if has("ANSICON") {
            return Some(1);
        }

        // The rest is a rule on the Windows build number, which is not read here.
        return None;
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

    // Node counts a PM2 process as a terminal, which the check below would then ask `TERM` about.
    if has("PM2_HOME") && has("pm_id") {
        return None;
    }

    if stdout_is_terminal && term.as_deref().is_some_and(term_shows_colour) {
        return Some(1);
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
        || args.iter().any(|argument| ColourFlag::parse(argument).is_some())
    {
        return None;
    }

    level_from(&|name| env::var_os(name).map(|value| value.to_string_lossy().into_owned()))
}

/// Cerebro's terminal width, in the order of its lookup: `CEREBRO_TERMINAL_WIDTH` (`parseInt`, positive), the size
/// of stdout, the size of stderr (each needs both columns and rows), `COLUMNS` when `LINES` is set too, and then
/// the controlling terminal (`/dev/tty`) and `tput`, which fall back to 80. `None` when the answer would come
/// from a place this process cannot read the way Node does: the `COLUMNS` or `LINES` text that is no clean
/// number, `tput` (which honours a `COLUMNS` of its own) and a controlling terminal.
pub fn terminal_width() -> Option<usize> {
    width_from(
        &|name| env::var_os(name).map(|value| value.to_string_lossy().into_owned()),
        size_of(terminal_size::terminal_size_of(std::io::stdout())),
        size_of(terminal_size::terminal_size_of(std::io::stderr())),
        crate::pail::environment_decides_width,
    )
}

/// A terminal size as `(columns, rows)`.
fn size_of(size: Option<(terminal_size::Width, terminal_size::Height)>) -> Option<(u16, u16)> {
    size.map(|(terminal_size::Width(columns), terminal_size::Height(rows))| (columns, rows))
}

fn width_from(
    get: &dyn Fn(&str) -> Option<String>,
    stdout: Option<(u16, u16)>,
    stderr: Option<(u16, u16)>,
    default_size_environment: fn() -> bool,
) -> Option<usize> {
    if let Some(width) = get("CEREBRO_TERMINAL_WIDTH").and_then(|text| parse_int(&text)).filter(|&width| width > 0) {
        return usize::try_from(width).ok();
    }

    if let Some((columns, _)) = [stdout, stderr].into_iter().flatten().find(|&(columns, rows)| columns > 0 && rows > 0)
    {
        return Some(usize::from(columns));
    }

    let columns = get("COLUMNS").filter(|text| !text.is_empty());
    let lines = get("LINES").filter(|text| !text.is_empty());

    if let (Some(columns), Some(_)) = (&columns, &lines) {
        return parse_int(columns).filter(|&width| width > 0).and_then(|width| usize::try_from(width).ok());
    }

    // `tput` answers from its own `COLUMNS`; without one, only a terminal could say, and then the default size is 80.
    (get("COLUMNS").is_none() && default_size_environment()).then_some(80)
}

/// Make a Windows console render the ANSI codes the native output prints (colour, styling).
/// A legacy console prints them as literal `←[1m` text until `ENABLE_VIRTUAL_TERMINAL_PROCESSING`
/// is set on the screen buffer. Handles that are not a console (a pipe, a file) are left alone,
/// and a console too old to know the flag keeps its mode. The state of each stream is recorded
/// here once and read by [`help_colour`]; outside Windows there is nothing to do.
pub fn enable_virtual_terminal() {
    #[cfg(windows)]
    let _ = windows_console::state();
}

#[cfg(windows)]
mod windows_console {
    use std::sync::OnceLock;

    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_ERROR_HANDLE,
        STD_OUTPUT_HANDLE,
    };

    use super::Console;

    /// What stdout and stderr are, in the order of [`super::Stream`]; the flag is switched on by the first call.
    pub fn state() -> &'static [Console; 2] {
        static STATE: OnceLock<[Console; 2]> = OnceLock::new();

        STATE.get_or_init(|| [probe(STD_OUTPUT_HANDLE), probe(STD_ERROR_HANDLE)])
    }

    fn probe(which: u32) -> Console {
        // SAFETY: the handle comes from `GetStdHandle` and is only passed to console
        // calls that report failure through their return value; `mode` outlives the call.
        unsafe {
            let handle = GetStdHandle(which);
            let mut mode = 0_u32;

            // Fails for an invalid handle or a non-console one: nothing to switch on.
            if handle.is_null() || GetConsoleMode(handle, &mut mode) == 0 {
                Console::Redirected
            } else if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0
                || SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0
            {
                Console::Ansi
            } else {
                Console::Legacy
            }
        }
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
    fn one_parser_reads_every_spelling_of_a_colour_flag() {
        assert_eq!(ColourFlag::parse("--no-color"), Some(ColourFlag::None));
        assert_eq!(ColourFlag::parse("-color=256"), Some(ColourFlag::Ansi256));
        assert_eq!(ColourFlag::parse("--colors"), Some(ColourFlag::On));
        assert_eq!(ColourFlag::parse("--color=banana"), Some(ColourFlag::Other));
        assert_eq!(ColourFlag::parse("color"), None);
        // Only the two declared options may sit before a command, as the surface sees them.
        assert!(ColourFlag::is_global_option("--color") && ColourFlag::is_global_option("--no-color"));
        assert!(!ColourFlag::is_global_option("--colors") && !ColourFlag::is_global_option("-color"));
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
            assert!(ColourFlag::parse(flag).is_some(), "{flag}");
        }

        for flag in ["colour", "--cwd", "--format", "color"] {
            assert!(ColourFlag::parse(flag).is_none(), "{flag}");
        }
    }

    #[test]
    fn enabling_on_a_non_console_does_not_panic() {
        // Test output is captured through pipes on every platform, so this takes the no-console path.
        enable_virtual_terminal();
    }

    fn get(pairs: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        let pairs = pairs.to_vec();

        move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
    }

    fn arguments(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    /// The colour of help for `words` in an environment, with stdout a terminal or not, not on Windows.
    fn colour(words: &[&str], pairs: &[(&'static str, &'static str)], terminal: bool) -> Option<bool> {
        colour_from(&arguments(words), &get(pairs), terminal, false)
    }

    #[test]
    fn a_ci_provider_colours_help_without_a_terminal() {
        assert_eq!(colour(&["--help"], &[("CI", "1"), ("GITHUB_ACTIONS", "1")], false), Some(true));
        assert_eq!(colour(&["--help"], &[("COLORTERM", "truecolor")], false), Some(true));
        assert_eq!(colour(&["--help"], &[("TERM", "xterm-256color")], false), Some(true));
        assert_eq!(colour(&["--help"], &[("TERM_PROGRAM", "iTerm.app")], false), Some(true));
        assert_eq!(colour(&["--help"], &[], false), Some(false));
    }

    #[test]
    fn the_terminal_rule_applies_only_to_a_terminal_with_a_colour_term() {
        assert_eq!(colour(&["--help"], &[("TERM", "xterm")], false), Some(false));
        assert_eq!(colour(&["--help"], &[("TERM", "xterm")], true), Some(true));
        assert_eq!(colour(&["--help"], &[("TERM", "vt100")], true), Some(true));
        assert_eq!(colour(&["--help"], &[("TERM", "Screen")], true), Some(true));
        assert_eq!(colour(&["--help"], &[("TERM", "foo")], true), Some(false));
        assert_eq!(colour(&["--help"], &[("TERM", "foo"), ("COLORTERM", "1")], true), Some(true));
        assert_eq!(colour(&["--help"], &[("TERM", "foo"), ("COLORTERM", "1")], false), Some(true));
        assert_eq!(colour(&["--help"], &[], true), Some(false));
        assert_eq!(colour(&["--help"], &[("TERM", "dumb")], true), Some(false));
    }

    #[test]
    fn term_values_that_show_colour() {
        for term in [
            "screen",
            "tmux-256color",
            "xterm",
            "vt100",
            "vt520",
            "ansi",
            "rxvt-unicode",
            "linux",
            "foo-color",
            "MINTTY",
            "cygwin",
        ] {
            assert!(term_shows_colour(term), "{term}");
        }

        for term in ["", "dumb", "vt600", "vt1", "foo", "alacritty"] {
            assert!(!term_shows_colour(term), "{term}");
        }
    }

    #[test]
    fn force_color_and_no_color_beat_the_colour_flags_the_way_the_detection_orders_them() {
        // A numeric `FORCE_COLOR` answers before any flag is read; `NO_COLOR` (even empty) beats `--color`.
        assert_eq!(colour(&["--help", "--color"], &[("FORCE_COLOR", "0")], false), Some(false));
        assert_eq!(colour(&["--help", "--color"], &[("FORCE_COLOR", "-1")], false), Some(false));
        assert_eq!(colour(&["--help", "--color"], &[("NO_COLOR", "")], false), Some(false));
        assert_eq!(colour(&["--help", "--color"], &[("NO_COLOR", "1")], false), Some(false));
        // `FORCE_COLOR` that is no number leaves the decision to what follows it.
        assert_eq!(colour(&["--help"], &[("FORCE_COLOR", "abc")], false), Some(false));
        assert_eq!(colour(&["--help"], &[("FORCE_COLOR", "abc"), ("COLORTERM", "truecolor")], false), Some(true));
        assert_eq!(colour(&["--help"], &[("FORCE_COLOR", "")], false), Some(true));
        assert_eq!(colour(&["--help"], &[("FORCE_COLOR", "-1")], false), Some(false));
        // The flag counts when no variable has spoken, and no-colour is the strongest.
        assert_eq!(colour(&["--help", "--color"], &[], false), Some(true));
        assert_eq!(colour(&["--help", "--color", "--no-color"], &[], false), Some(false));
        assert_eq!(colour(&["--help", "--color=256"], &[], false), Some(true));
        assert_eq!(colour(&["--help", "-color"], &[], false), Some(true));
        assert_eq!(colour(&["--help", "--color=never"], &[("FORCE_COLOR", "abc")], false), Some(false));
        // The flags are read up to `--`, but `bin.ts` reads the literal `--no-color` everywhere.
        assert_eq!(colour(&["--help", "--", "--color"], &[], false), Some(false));
        assert_eq!(colour(&["--help", "--", "--no-color"], &[("FORCE_COLOR", "1")], false), Some(false));
        assert_eq!(colour(&["--help", "--no-color"], &[("CI", "1"), ("GITHUB_ACTIONS", "1")], true), Some(false));
    }

    #[test]
    fn the_runtime_warning_cases_are_left_to_node() {
        assert_eq!(colour(&["--help"], &[("FORCE_COLOR", "1"), ("NO_COLOR", "1")], false), None);
        assert_eq!(colour(&["--help", "--no-color"], &[("FORCE_COLOR", "1"), ("NO_COLOR", "1")], false), None);
        assert_eq!(colour(&["--help"], &[("FORCE_COLOR", "1"), ("NODE_DISABLE_COLORS", "1")], false), None);
        assert_eq!(colour(&["--help"], &[("PM2_HOME", "/x"), ("pm_id", "0")], false), None);
    }

    #[test]
    fn colour_flag_shapes() {
        let flags = |words: &[&str]| ColourFlags::from_args(&arguments(words));

        assert!(flags(&["--no-colors"]).none);
        assert!(flags(&["-no-color"]).none);
        assert!(flags(&["--color=truecolor"]).truecolor);
        assert!(flags(&["--color=full"]).truecolor);
        assert!(flags(&["--color=256"]).ansi256);
        assert!(flags(&["--colors"]).on);
        assert!(flags(&["--color=always"]).on);
        assert!(!flags(&["---color"]).on);
        assert!(!flags(&["--color=2"]).on);
        assert!(!flags(&["color"]).on);
        assert!(!flags(&["--", "--color"]).on);
    }

    #[test]
    fn windows_decides_from_the_environment_or_leaves_the_build_number_to_node() {
        let on_windows =
            |pairs: &[(&'static str, &'static str)]| detect_level(&get(pairs), ColourFlags::default(), true, true);

        assert_eq!(on_windows(&[("WT_SESSION", "x")]), Some(3));
        assert_eq!(on_windows(&[("ANSICON", "1")]), Some(1));
        assert_eq!(on_windows(&[("FORCE_COLOR", "2")]), Some(2));
        assert_eq!(on_windows(&[("TERM", "dumb")]), Some(0));
        assert_eq!(on_windows(&[]), None);
        // The CI rules sit behind the Windows rule.
        assert_eq!(on_windows(&[("CI", "1"), ("GITHUB_ACTIONS", "1")]), None);
    }

    #[test]
    fn a_legacy_console_is_the_only_stream_state_that_cannot_show_ansi() {
        assert!(shows_ansi(Console::Ansi));
        assert!(shows_ansi(Console::Redirected));
        assert!(!shows_ansi(Console::Legacy));
    }

    fn width(
        pairs: &[(&'static str, &'static str)],
        stdout: Option<(u16, u16)>,
        stderr: Option<(u16, u16)>,
        default_environment: bool,
    ) -> Option<usize> {
        fn yes() -> bool {
            true
        }

        fn no() -> bool {
            false
        }

        width_from(&get(pairs), stdout, stderr, if default_environment { yes } else { no })
    }

    #[test]
    fn cerebro_terminal_width_reads_like_parse_int() {
        for (text, expected) in [("100px", Some(100)), (" 90", Some(90)), ("+66", Some(66)), ("12.5", Some(12))] {
            assert_eq!(width(&[("CEREBRO_TERMINAL_WIDTH", text)], None, None, false), expected, "{text:?}");
        }

        // No positive number: the lookup goes on, here to a terminal that this test says cannot be asked.
        for text in ["abc", "0", "-5", ""] {
            assert_eq!(width(&[("CEREBRO_TERMINAL_WIDTH", text)], None, None, false), None, "{text:?}");
        }

        assert_eq!(width(&[("CEREBRO_TERMINAL_WIDTH", "70")], Some((200, 50)), None, false), Some(70));
    }

    #[test]
    fn the_stream_sizes_come_before_the_environment_and_need_both_columns_and_rows() {
        assert_eq!(width(&[("COLUMNS", "90"), ("LINES", "30")], Some((200, 50)), None, false), Some(200));
        assert_eq!(width(&[], None, Some((150, 40)), false), Some(150));
        assert_eq!(width(&[], Some((200, 50)), Some((150, 40)), false), Some(200));
        assert_eq!(width(&[("COLUMNS", "90"), ("LINES", "30")], Some((200, 0)), Some((0, 40)), false), Some(90));
    }

    #[test]
    fn columns_count_only_with_lines() {
        assert_eq!(width(&[("COLUMNS", "120"), ("LINES", "30")], None, None, false), Some(120));
        assert_eq!(width(&[("COLUMNS", " 120x"), ("LINES", "1")], None, None, false), Some(120));
        // Without `LINES` the answer is `tput`'s, which Node reads and this process does not.
        assert_eq!(width(&[("COLUMNS", "120")], None, None, true), None);
        assert_eq!(width(&[("COLUMNS", "120"), ("LINES", "")], None, None, true), None);
        // `COLUMNS` or `LINES` that is no clean number is Node's.
        assert_eq!(width(&[("COLUMNS", "abc"), ("LINES", "30")], None, None, true), None);
        assert_eq!(width(&[("COLUMNS", "0"), ("LINES", "30")], None, None, true), None);
    }

    #[test]
    fn without_a_size_only_an_environment_with_nothing_to_ask_gives_eighty() {
        assert_eq!(width(&[], None, None, true), Some(80));
        assert_eq!(width(&[("LINES", "30")], None, None, true), Some(80));
        assert_eq!(width(&[], None, None, false), None);
    }
}
