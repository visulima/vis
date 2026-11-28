//! The plain renderer of `vis staged` (`src/staged/renderer/plain.ts`): one line per event on stderr.
//!
//! Node picks it for every run the binary answers (CI is set and stderr is not a terminal). Each line is written the
//! moment it happens, as Node writes it, so a run that is cut short has printed what it got to.

use std::io::Write;

use super::Pattern;

/// What became of a task or a pattern.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Status {
    Failed,
    Skipped,
    Success,
}

/// The renderer of one run.
pub(super) struct Renderer {
    quiet: bool,
    verbose: bool,
    colour: bool,
    /// `TERM` is not `linux`, so the glyphs are the Unicode ones (`src/tui/symbols.ts`).
    unicode: bool,
}

/// `colorize`'s styling of `text`: nothing for an empty text, the close code of the style met inside the text
/// turned back into its open code, and the style closed and reopened around every line break, so no line ends styled.
fn paint(open: u8, close: u8, text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }

    let open = format!("\x1b[{open}m");
    let close = format!("\x1b[{close}m");
    let text = if text.contains('\x1b') { text.replace(&close, &open) } else { text.to_owned() };
    let bytes = text.as_bytes();
    let mut styled = String::with_capacity(text.len() + 16);
    let mut start = 0;
    let mut index = 0;

    styled.push_str(&open);

    while index < bytes.len() {
        if bytes[index] != b'\r' && bytes[index] != b'\n' {
            index += 1;

            continue;
        }

        // `(\r*\n)`: a run of carriage returns that a line feed ends. A run that does not end in one is plain text.
        let mut end = index;

        while end < bytes.len() && bytes[end] == b'\r' {
            end += 1;
        }

        if end < bytes.len() && bytes[end] == b'\n' {
            styled.push_str(&text[start..index]);
            styled.push_str(&close);
            styled.push_str(&text[index..=end]);
            styled.push_str(&open);

            start = end + 1;
            index = end + 1;
        } else {
            index = end;
        }
    }

    styled.push_str(&text[start..]);
    styled.push_str(&close);

    styled
}

impl Renderer {
    pub(super) fn new(quiet: bool, verbose: bool, colour: bool) -> Self {
        let unicode = std::env::var_os("TERM").is_none_or(|term| term != "linux");

        Self { quiet, verbose, colour, unicode }
    }

    fn style(&self, open: u8, close: u8, text: &str) -> String {
        if self.colour {
            paint(open, close, text)
        } else {
            text.to_owned()
        }
    }

    fn dim(&self, text: &str) -> String {
        self.style(2, 22, text)
    }

    fn cyan(&self, text: &str) -> String {
        self.style(36, 39, text)
    }

    fn write(text: &str) {
        let mut stderr = std::io::stderr().lock();

        // A closed stderr ends nothing here: Node ignores the failure as well.
        let _ = stderr.write_all(text.as_bytes());
        let _ = stderr.flush();
    }

    /// `print`: a line on stderr unless `--quiet`.
    fn print(&self, message: &str) {
        if !self.quiet {
            Self::write(&format!("{message}\n"));
        }
    }

    fn icon(&self, status: Status) -> String {
        match status {
            Status::Failed => self.style(31, 39, if self.unicode { "\u{2716}" } else { "\u{d7}" }),
            Status::Skipped => self.style(33, 39, if self.unicode { "\u{2014}" } else { "-" }),
            Status::Success => self.style(32, 39, if self.unicode { "\u{2713}" } else { "\u{221a}" }),
        }
    }

    pub(super) fn info(&self, message: &str) {
        self.print(&self.dim(message));
    }

    pub(super) fn warn(&self, message: &str) {
        self.print(&self.style(33, 39, message));
    }

    /// `error` for a failure that carries no stack here: the message in red, on stderr even under `--quiet`.
    pub(super) fn error(&self, message: &str) {
        Self::write(&format!("{}\n", self.style(31, 39, message)));
    }

    pub(super) fn start(&self, patterns: &[Pattern]) {
        if patterns.is_empty() {
            self.print(&self.dim("No staged files matched any pattern."));

            return;
        }

        let mut files: Vec<&String> = patterns.iter().flat_map(|pattern| &pattern.files).collect();

        files.sort_unstable();
        files.dedup();

        let count = files.len();
        let total = patterns.len();

        self.print(&format!(
            "{} Running staged tasks on {count} file{} across {total} pattern{}",
            self.cyan(">"),
            if count == 1 { "" } else { "s" },
            if total == 1 { "" } else { "s" },
        ));
    }

    pub(super) fn pattern_start(&self, title: &str) {
        self.print(&format!("{} {title}", self.cyan(">")));
    }

    pub(super) fn pattern_end(&self, title: &str, status: Status) {
        self.print(&format!("{} {title}", self.icon(status)));
    }

    pub(super) fn command_start(&self, title: &str) {
        if self.verbose {
            self.print(&format!("  {} {title}", self.dim("\u{2026}")));
        }
    }

    /// A finished command: its line, and for a failure (or `--verbose`) the output indented below it.
    pub(super) fn command_end(
        &self,
        title: &str,
        status: Status,
        duration_ms: u128,
        error: Option<&str>,
        output: Option<&str>,
    ) {
        let duration = self.dim(&format!("({duration_ms}ms)"));

        self.print(&format!("  {} {title} {duration}", self.icon(status)));

        if status == Status::Failed {
            if let Some(message) = error {
                self.print(&self.dim(message));
            }
        }

        if let Some(output) = output {
            if (status == Status::Failed || self.verbose) && !crate::js::trim(output).is_empty() {
                for line in output.split('\n') {
                    let line = line.strip_suffix('\r').unwrap_or(line);

                    self.print(&format!("    {}", self.dim(line)));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_style_is_closed_and_reopened_around_each_line() {
        assert_eq!(paint(2, 22, "a"), "\x1b[2ma\x1b[22m");
        assert_eq!(paint(2, 22, ""), "");
        assert_eq!(paint(2, 22, "a\nb"), "\x1b[2ma\x1b[22m\n\x1b[2mb\x1b[22m");
        assert_eq!(paint(2, 22, "a\r\nb\n"), "\x1b[2ma\x1b[22m\r\n\x1b[2mb\x1b[22m\n\x1b[2m\x1b[22m");
        assert_eq!(paint(2, 22, "a\rb"), "\x1b[2ma\rb\x1b[22m");
        assert_eq!(paint(31, 39, "x\x1b[39my"), "\x1b[31mx\x1b[31my\x1b[39m");
    }

    #[test]
    fn plain_text_has_no_codes() {
        let renderer = Renderer::new(false, false, false);

        assert_eq!(renderer.dim("a\nb"), "a\nb");
        assert_eq!(renderer.icon(Status::Success), "\u{2713}");
    }
}
