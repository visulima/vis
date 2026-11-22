//! pail's plain (non-terminal, uncoloured) line layout, shared by the commands that print pail
//! blocks natively (`clean`, `secrets`, `cache hash`, `install`).
//!
//! A block is a header with the local time and the level label, filled with dots to the line
//! width, a blank line, then the message word-wrapped to the same width. The callers only use it
//! where Node's output is provably plain: no terminal, no colour, ASCII text.

use std::env;

/// pail's default line width when `COLUMNS` is unset (stdout is not a terminal).
const DEFAULT_WIDTH: usize = 80;

/// Below this width pail's header cannot hold its label, so Node stays in charge.
const MIN_WIDTH: usize = 40;

/// pail's width: `COLUMNS` when set (it must parse, and be wide enough), else 80.
pub(crate) fn pail_width() -> Option<usize> {
    match env::var("COLUMNS") {
        Err(env::VarError::NotPresent) => Some(DEFAULT_WIDTH),
        Ok(text) => text.trim().parse::<usize>().ok().filter(|&width| width >= MIN_WIDTH),
        Err(env::VarError::NotUnicode(_)) => None,
    }
}

/// One pail block as pail prints it: the header, a blank line, then the wrapped message, each line
/// ending in a newline.
pub(crate) fn block(width: usize, label: &str, message: &str) -> String {
    let limit = width - 3;
    let head = format!("{} {label} ", clock());
    let mut text = String::new();

    text.push_str(&head);
    text.push_str(&".".repeat(limit.saturating_sub(head.len())));
    text.push_str("\n\n");

    for line in wrap(message, limit) {
        text.push_str(&line);
        text.push('\n');
    }

    text
}

/// pail's PRESERVE_WORDS wrap, with `trim: false`: the message splits into words and single
/// spaces, a token that would overflow starts a new line without being consumed, and a space
/// that does not fit therefore leads the next line. Widths are byte counts, which is exact for
/// the ASCII the gate lets through.
pub(crate) fn wrap(message: &str, limit: usize) -> Vec<String> {
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
    let mut width = 0;
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens[index];

        if token.is_empty() {
            index += 1;
            continue;
        }

        if width + token.len() > limit && width > 0 {
            lines.push(std::mem::take(&mut current));
            width = 0;
            continue;
        }

        current.push_str(token);
        width += token.len();
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
    use super::{block, wrap};

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
        let text = block(80, "INFO", "hello");
        let lines: Vec<&str> = text.split('\n').collect();

        assert!(lines[0].contains(" INFO ......"));
        assert_eq!(lines[0].len(), 77);
        assert_eq!(&lines[1..], ["", "hello", ""]);
    }
}
