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

    #[test]
    fn enabling_on_a_non_console_does_not_panic() {
        // Test output is captured through pipes on every platform, so this takes the no-console path.
        let _ = enable_virtual_terminal();
    }
}
