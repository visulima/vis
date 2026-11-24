//! pail's log-line layout, shared by every command that prints pail blocks natively (`clean`, `secrets`, `install`,
//! `sbom`, `optimize`, `ignore`, the `cache` subcommands, `replay`, `run`, `sort-package-json`, ...).
//!
//! A block is a header with the local time and the level label, filled with dots to the line
//! width, a blank line, then the message word-wrapped to the same width. When pail's colour
//! detection (see [`crate::term::piped_colour_level`]) turns colour on, the clock and the dots
//! are grey and the label has the colour of its level, each in its own escape pair; the message
//! stays plain. Every level above zero uses the same sixteen-colour codes, so the output only
//! depends on whether colour is on.
//!
//! The contract with the callers: the layout is only proven for ASCII text without a terminal. A caller builds
//! a [`Layout`] with [`Layout::detect`], which answers `None` where Node's pail would lay a line out another
//! way (a width, a terminal, a colour flag); gates every message on [`printable`] (or [`plain`] for a word such
//! as a path or an id; [`Layout::block_fitting`] checks the two symbols the optimizer prints itself); and hands
//! the run to Node when a check fails, before anything is printed. A message the gate lets through that this
//! layout cannot wrap exactly (a character that is one column and several bytes) is the caller's to refuse.

use std::env;

use crate::term::Style;

/// pail's default line width when `COLUMNS` is unset (stdout is not a terminal).
const DEFAULT_WIDTH: usize = 80;

/// Below this width pail's header cannot hold its label, so Node stays in charge.
const MIN_WIDTH: usize = 40;

/// Whether pail prints `text` exactly as it is laid out here: printable ASCII, spaces included (the bytes
/// `padEnd` and the wrap treat as one column each). The callers of [`Layout::block`] gate their messages on
/// this or on [`plain`] and hand the run to Node when the gate fails.
pub(crate) fn printable(text: &str) -> bool {
    text.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

/// A string pail and `padEnd` handle exactly as a single word: printable ASCII, no space.
pub(crate) fn plain(text: &str) -> bool {
    text.bytes().all(|byte| byte.is_ascii_graphic())
}

/// [`plain`] for a path: ASCII, no spaces, no control characters.
pub(crate) fn plain_path(path: &std::path::Path) -> bool {
    path.to_str().is_some_and(plain)
}

/// The width of pail's longest level label (`EMERGENCY`): the label is padded with dots to it.
const LABEL_FIELD: usize = 9;

/// A log level a native command prints, with the label and colour pail gives it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Level {
    Error,
    Info,
    Notice,
    Success,
    Warning,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Self::Error => "ERROR",
            Self::Info => "INFO",
            Self::Notice => "NOTICE",
            Self::Success => "SUCCESS",
            Self::Warning => "WARNING",
        }
    }

    /// The SGR foreground code of the level's colour (`red`, `blueBright`, `magentaBright`, `green`, `yellow`).
    fn colour(self) -> u8 {
        match self {
            Self::Error => 31,
            Self::Info => 94,
            Self::Notice => 95,
            Self::Success => 32,
            Self::Warning => 33,
        }
    }

    /// pail prints the warning and error levels on stderr and every other level on stdout.
    pub(crate) fn to_stderr(self) -> bool {
        matches!(self, Self::Error | Self::Warning)
    }
}

/// How pail lays out a line in this process: its width, and whether it colours the header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Layout {
    pub(crate) width: usize,
    pub(crate) colour: bool,
}

impl Layout {
    /// The layout Node's pail would use, or `None` when this cannot be proven (a width pail would
    /// compute differently, a terminal, a colour flag, Windows) and Node has to answer.
    pub(crate) fn detect(args: &[String]) -> Option<Self> {
        let colour = crate::term::piped_colour_level(args)? > 0;

        Some(Self { width: pail_width()?, colour })
    }

    /// One pail block as pail prints it: the header, a blank line, then the wrapped message, each
    /// line ending in a newline.
    pub(crate) fn block(self, level: Level, message: &str) -> String {
        let limit = self.width - 3;
        let mut text = self.header(level);

        for line in wrap(message, limit) {
            text.push_str(&line);
            text.push('\n');
        }

        text
    }

    /// A block whose message may hold line breaks and the two symbols the optimizer prints (`→`, `⚙`), as pail
    /// prints it: the header, a blank line, the message with each of its lines wrapped on its own by display
    /// width (both symbols are two columns wide there), a newline. `None` for any other non-ASCII character
    /// and for a control character other than the line break: Node answers those.
    pub(crate) fn block_fitting(self, level: Level, message: &str) -> Option<String> {
        let limit = self.width - 3;
        let mut lines = Vec::new();

        for line in message.split('\n') {
            if !line.chars().all(|character| matches!(character, ' '..='~' | '\u{2192}' | '\u{2699}')) {
                return None;
            }

            lines.extend(wrap_with(line, limit, display_width));

            // `Vr` returns no line for an empty one, and the join of the lines puts the line break back.
            if line.is_empty() {
                lines.push(String::new());
            }
        }

        let mut text = self.header(level);

        text.push_str(&lines.join("\n"));
        text.push('\n');

        Some(text)
    }

    /// The header line of a block and the blank line after it.
    fn header(self, level: Level) -> String {
        let limit = self.width - 3;
        let label = level.label();
        let clock = clock();
        let head = format!("{clock} {label} ");
        let padding = LABEL_FIELD.saturating_sub(label.len());
        let dots = limit.saturating_sub(head.len());
        let mut text = String::new();

        if self.colour {
            // pail wraps the clock, the label and each run of dots on its own: the label's padding
            // is a run of its own, and an empty run is dropped.
            text.push_str(&paint(90, &clock));
            text.push(' ');
            text.push_str(&paint(level.colour(), label));
            text.push(' ');
            text.push_str(&paint(90, &".".repeat(padding.min(dots))));
            text.push_str(&paint(90, &".".repeat(dots.saturating_sub(padding))));
        } else {
            text.push_str(&head);
            text.push_str(&".".repeat(dots));
        }

        text.push_str("\n\n");

        text
    }
}

/// `text` inside the SGR pair of a foreground colour, or nothing for an empty string (pail's colour functions
/// return an empty string for one).
fn paint(code: u8, text: &str) -> String {
    Style { colour: true }.paint(code, 39, text)
}

/// `TERM` values whose terminfo entry is 80 columns by 24 lines: the size pail's width lookup (`tput`) treats as "no
/// answer", so the width then comes from `COLUMNS`, else 80. Other entries (the `-w` wide variants, 132 columns, and
/// many older terminals) give another width, which this crate cannot look up.
const TERMS_WITH_DEFAULT_SIZE: [&str; 26] = [
    "alacritty",
    "ansi",
    "dumb",
    "foot",
    "ghostty",
    "kitty",
    "linux",
    "rxvt",
    "rxvt-256color",
    "rxvt-unicode",
    "rxvt-unicode-256color",
    "screen",
    "screen-256color",
    "screen-bce",
    "tmux",
    "tmux-256color",
    "vt100",
    "vt220",
    "wezterm",
    "xterm",
    "xterm-16color",
    "xterm-256color",
    "xterm-color",
    "xterm-direct",
    "xterm-ghostty",
    "xterm-kitty",
];

/// Whether pail's width comes from the environment alone. Its lookup tries the size of the stream, then
/// `COLUMNS` and `LINES` together, then the controlling terminal (`/dev/tty`), then `tput` under the inherited
/// `TERM`. A process with a controlling terminal, or a `TERM` outside [`TERMS_WITH_DEFAULT_SIZE`], can therefore
/// get a width from outside the environment even when both streams are redirected.
pub(crate) fn environment_decides_width() -> bool {
    #[cfg(unix)]
    if std::fs::File::open("/dev/tty").is_ok() {
        return false;
    }

    match env::var("TERM") {
        Err(env::VarError::NotPresent) => true,
        Ok(term) => TERMS_WITH_DEFAULT_SIZE.contains(&term.as_str()),
        Err(env::VarError::NotUnicode(_)) => false,
    }
}

/// pail's width: `COLUMNS` when set (it must parse, and be wide enough), else 80. `None` when the width could come
/// from somewhere else (see [`environment_decides_width`]).
pub(crate) fn pail_width() -> Option<usize> {
    if !environment_decides_width() {
        return None;
    }

    match env::var("COLUMNS") {
        Err(env::VarError::NotPresent) => Some(DEFAULT_WIDTH),
        Ok(text) => text.trim().parse::<usize>().ok().filter(|&width| width >= MIN_WIDTH),
        Err(env::VarError::NotUnicode(_)) => None,
    }
}

/// pail's PRESERVE_WORDS wrap, with `trim: false`: the message splits into words and single
/// spaces, a token that would overflow starts a new line without being consumed, and a space
/// that does not fit therefore leads the next line. Widths are byte counts, which is exact for
/// the ASCII the gate lets through.
pub(crate) fn wrap(message: &str, limit: usize) -> Vec<String> {
    wrap_with(message, limit, str::len)
}

/// The display width of a token of ASCII text and the two symbols `block_fitting` takes: both symbols are two
/// columns wide in pail's measure (`→` is East Asian ambiguous, `⚙` an emoji).
fn display_width(token: &str) -> usize {
    token.chars().map(|character| if matches!(character, '\u{2192}' | '\u{2699}') { 2 } else { 1 }).sum()
}

/// [`wrap`] with the width of a token given by `width`.
fn wrap_with(message: &str, limit: usize, width: fn(&str) -> usize) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut start = 0;

    for (index, byte) in message.bytes().enumerate() {
        if byte == b' ' {
            tokens.push(&message[start..index]);
            tokens.push(" ");
            start = index + 1;
        }
    }

    tokens.push(&message[start..]);

    let mut lines = Vec::new();
    let mut current = String::new();
    let mut used = 0;
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens[index];

        if token.is_empty() {
            index += 1;
            continue;
        }

        if used + width(token) > limit && used > 0 {
            lines.push(std::mem::take(&mut current));
            used = 0;
            continue;
        }

        current.push_str(token);
        used += width(token);
        index += 1;
    }

    if !current.is_empty() {
        lines.push(current);
    }

    lines
}

/// Local wall-clock time as `HH:MM:SS`, the format pail's header uses.
#[cfg(unix)]
pub(crate) fn clock() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs());

    let Ok(seconds) = libc::time_t::try_from(now) else {
        return "00:00:00".to_owned();
    };

    // SAFETY: `localtime_r` only writes the `tm` it is given, and `seconds` outlives the call.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };

    if unsafe { libc::localtime_r(&seconds, &mut tm) }.is_null() {
        return "00:00:00".to_owned();
    }

    format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
}

/// Only reached on unix: `plan` delegates everywhere else.
#[cfg(not(unix))]
pub(crate) fn clock() -> String {
    "00:00:00".to_owned()
}

#[cfg(test)]
mod tests {
    use super::{wrap, Layout, Level};

    const PLAIN: Layout = Layout { width: 80, colour: false };
    const COLOUR: Layout = Layout { width: 80, colour: true };

    #[test]
    fn a_long_path_breaks_after_the_label_and_keeps_its_space() {
        let path = format!("/{}/node_modules", "p".repeat(90));

        assert_eq!(wrap(&format!("Removed {path}"), 77), vec!["Removed ".to_owned(), path]);
    }

    #[test]
    fn a_space_that_does_not_fit_leads_the_next_line() {
        let path = format!("/{}/node_modules:", "p".repeat(80));

        assert_eq!(wrap(&format!("{path} Permission denied"), 77), vec![path, " Permission denied".to_owned()]);
    }

    #[test]
    fn a_short_message_stays_on_one_line() {
        assert_eq!(wrap("Removed /a/node_modules", 77), vec!["Removed /a/node_modules".to_owned()]);
    }

    #[test]
    fn a_block_is_a_dotted_header_a_blank_line_and_the_message() {
        let text = PLAIN.block(Level::Info, "hello");
        let lines: Vec<&str> = text.split('\n').collect();

        assert!(lines[0].contains(" INFO ......"));
        assert_eq!(lines[0].len(), 77);
        assert_eq!(&lines[1..], ["", "hello", ""]);
    }

    /// The header of a coloured block, with the clock replaced.
    fn header(level: Level) -> String {
        let text = COLOUR.block(level, "hello");
        let first = text.split('\n').next().unwrap().to_owned();

        first.replacen(&first[5..13], "HH:MM:SS", 1)
    }

    #[test]
    fn a_coloured_header_wraps_the_clock_label_and_each_run_of_dots() {
        let dots = |count: usize| ".".repeat(count);

        assert_eq!(
            header(Level::Info),
            format!(
                "\x1b[90mHH:MM:SS\x1b[39m \x1b[94mINFO\x1b[39m \x1b[90m{}\x1b[39m\x1b[90m{}\x1b[39m",
                dots(5),
                dots(58)
            )
        );
        assert_eq!(
            header(Level::Success),
            format!(
                "\x1b[90mHH:MM:SS\x1b[39m \x1b[32mSUCCESS\x1b[39m \x1b[90m{}\x1b[39m\x1b[90m{}\x1b[39m",
                dots(2),
                dots(58)
            )
        );
        assert_eq!(
            header(Level::Error),
            format!(
                "\x1b[90mHH:MM:SS\x1b[39m \x1b[31mERROR\x1b[39m \x1b[90m{}\x1b[39m\x1b[90m{}\x1b[39m",
                dots(4),
                dots(58)
            )
        );
        assert_eq!(
            header(Level::Notice),
            format!(
                "\x1b[90mHH:MM:SS\x1b[39m \x1b[95mNOTICE\x1b[39m \x1b[90m{}\x1b[39m\x1b[90m{}\x1b[39m",
                dots(3),
                dots(58)
            )
        );
        assert_eq!(
            header(Level::Warning),
            format!(
                "\x1b[90mHH:MM:SS\x1b[39m \x1b[33mWARNING\x1b[39m \x1b[90m{}\x1b[39m\x1b[90m{}\x1b[39m",
                dots(2),
                dots(58)
            )
        );
    }

    #[test]
    fn a_coloured_block_keeps_its_message_plain() {
        let text = COLOUR.block(Level::Info, "hello");

        assert!(text.ends_with("\n\nhello\n"));
    }

    #[test]
    fn the_listed_terms_are_sorted_and_eighty_columns_wide() {
        let mut sorted = super::TERMS_WITH_DEFAULT_SIZE;

        sorted.sort_unstable();

        assert_eq!(sorted, super::TERMS_WITH_DEFAULT_SIZE);
        assert!(!super::TERMS_WITH_DEFAULT_SIZE.iter().any(|term| term.ends_with("-w")));
    }

    #[test]
    fn only_the_warning_and_error_levels_go_to_stderr() {
        assert!(Level::Error.to_stderr() && Level::Warning.to_stderr());
        assert!(!Level::Info.to_stderr() && !Level::Success.to_stderr() && !Level::Notice.to_stderr());
    }

    /// What Node's pail printed (columns, message, output with the clock replaced) for lines holding `→` and `⚙`,
    /// both two columns wide there. The cases sit on both sides of the wrap point.
    const WIDE: &[(usize, &str, &str)] = &[
        (80, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO ...............................................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y\n"),
        (80, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO ...............................................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y\n"),
        (80, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO ...............................................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y\n"),
        (80, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO ...............................................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → \ny\n"),
        (80, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO ...............................................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx →\n y\n"),
        (60, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO ...........................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y\n"),
        (60, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO ...........................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y\n"),
        (60, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO ...........................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y\n"),
        (60, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO ...........................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → \ny\n"),
        (50, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y", "HH:MM:SS INFO .................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → y\n"),
        (80, "  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", "HH:MM:SS INFO ...............................................................\n\n  ⚙ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → \nrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr\n"),
        (80, "\nTotal: 12 optimizations available (⚙ = codemod available).", "HH:MM:SS INFO ...............................................................\n\n\nTotal: 12 optimizations available (⚙ = codemod available).\n"),
        (40, "\nTotal: 12 optimizations available (⚙ = codemod available).", "HH:MM:SS INFO .......................\n\n\nTotal: 12 optimizations available (⚙\n = codemod available).\n"),
    ];

    #[test]
    fn wide_symbols_wrap_where_pail_wraps() {
        for (columns, message, expected) in WIDE {
            let text = Layout { width: *columns, colour: false }.block_fitting(Level::Info, message).unwrap();

            assert_eq!(format!("HH:MM:SS{}", &text[8..]), *expected, "{columns} columns: {message:?}");
        }
    }

    #[test]
    fn other_characters_are_not_fitted() {
        let layout = Layout { width: 80, colour: false };

        assert!(layout.block_fitting(Level::Info, "caf\u{e9}").is_none());
        assert!(layout.block_fitting(Level::Info, "tab\there").is_none());
        assert!(layout.block_fitting(Level::Info, "line\nbreak").is_some());
    }
}
