//! Terminal facts the help output depends on: colour on/off and width.

use std::env;
use std::io::IsTerminal;

/// Whether colour codes should be emitted, in the Node CLI's precedence order:
/// an explicit `--color` / `--no-color` flag, then `FORCE_COLOR`, then
/// `NO_COLOR`, then whether stdout is a terminal that can show colour.
pub fn color_enabled(args: &[String]) -> bool {
    for argument in args {
        match argument.as_str() {
            "--" => break,
            "--no-color" | "--no-colors" | "--color=false" | "--color=never" => return false,
            "--color" | "--colors" | "--color=true" | "--color=always" => return true,
            _ => {}
        }
    }

    if let Ok(force) = env::var("FORCE_COLOR") {
        return !matches!(force.as_str(), "0" | "false");
    }

    if env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty()) {
        return false;
    }

    std::io::stdout().is_terminal() && env::var("TERM").map_or(true, |term| term != "dumb")
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
