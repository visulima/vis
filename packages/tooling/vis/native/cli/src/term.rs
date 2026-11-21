//! Terminal facts the help output depends on: colour on/off and width, and the
//! Windows console mode that lets the colour codes render.

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

/// `ENABLE_VIRTUAL_TERMINAL_PROCESSING`: the console interprets ANSI escape sequences.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;

/// `mode` with ANSI escape processing switched on, every other flag untouched.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn with_virtual_terminal(mode: u32) -> u32 {
    mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING
}

/// Make a Windows console render the ANSI codes the native output prints (colour, styling).
/// A legacy console prints them as literal `←[1m` text until this flag is set on the screen
/// buffer. Handles that are not a console (a pipe, a file) are left alone, and a console too
/// old to know the flag keeps its mode, which is the state before this call. No-op elsewhere.
pub fn enable_virtual_terminal() {
    #[cfg(windows)]
    windows_console::enable();
}

#[cfg(windows)]
mod windows_console {
    use super::with_virtual_terminal;

    type Handle = *mut std::ffi::c_void;

    const STD_OUTPUT_HANDLE: u32 = -11_i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12_i32 as u32;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(which: u32) -> Handle;
        fn GetConsoleMode(console: Handle, mode: *mut u32) -> i32;
        fn SetConsoleMode(console: Handle, mode: u32) -> i32;
    }

    pub fn enable() {
        for which in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            // SAFETY: the handle comes from `GetStdHandle` and is only passed to console
            // calls that report failure through their return value; `mode` outlives the call.
            unsafe {
                let handle = GetStdHandle(which);
                let mut mode = 0_u32;

                // Fails for an invalid handle or a non-console one: nothing to switch on.
                if handle.is_null() || GetConsoleMode(handle, &mut mode) == 0 {
                    continue;
                }

                SetConsoleMode(handle, with_virtual_terminal(mode));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_terminal_flag_is_added_and_nothing_else_changes() {
        // ENABLE_PROCESSED_OUTPUT | ENABLE_WRAP_AT_EOL_OUTPUT, the usual legacy mode.
        assert_eq!(with_virtual_terminal(0x0003), 0x0007);
        assert_eq!(with_virtual_terminal(0), 0x0004);
    }

    #[test]
    fn virtual_terminal_flag_is_idempotent() {
        let once = with_virtual_terminal(0x0003);

        assert_eq!(with_virtual_terminal(once), once);
    }

    #[test]
    fn enabling_on_a_non_console_does_not_panic() {
        // Test output is captured through pipes on every platform, so this takes the no-console path.
        enable_virtual_terminal();
    }
}
