//! `fspy_windows` — Windows file-access tracker.
//!
//! An injected DLL that IAT-hooks the Win32 file API and streams each access
//! to the parent over a per-spawn named pipe. Pure Rust — no Microsoft Detours
//! and no vcpkg; IAT pointer-swapping is arch-independent so the same code
//! covers x64 and ARM64.
//!
//! The parent ([`native/src/windows.rs`]) creates the process suspended,
//! creates the `\\.\pipe\fspy-<childpid>` server, injects this DLL via
//! `CreateRemoteThread(LoadLibraryW)`, then resumes the child. On
//! `DLL_PROCESS_ATTACH` we connect to that pipe (derived from our own PID) and
//! install the hooks before the host program's `main` runs.

// Only the Win32 glue (hooks, pipe, `DllMain`) is Windows-specific. Pure logic
// (`path`, `pe`) builds on every host so `cargo test` covers it without a Windows
// runner.
#[cfg(windows)]
pub mod hooks;
pub mod path;
pub mod pe;
#[cfg(windows)]
pub mod pipe;

#[cfg(windows)]
use core::ffi::c_void;

#[cfg(windows)]
use windows_sys::Win32::Foundation::HINSTANCE;
#[cfg(windows)]
use windows_sys::Win32::System::LibraryLoader::DisableThreadLibraryCalls;
#[cfg(windows)]
use windows_sys::Win32::System::SystemServices::{DLL_PROCESS_ATTACH, DLL_PROCESS_DETACH};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::GetCurrentProcessId;

/// Wire opcodes — one byte prefix per pipe message. Shared with the parser in
/// `native/src/windows.rs` through `fspy_wire`.
pub use fspy_wire::op as mode;

/// `DllMain` — entrypoint the loader calls when the DLL attaches. On
/// `DLL_PROCESS_ATTACH` we drop thread-attach callbacks (we don't need them),
/// connect to the parent's pipe (named for our own PID), and install the IAT
/// hooks before the host runs. All best-effort: any failure leaves the host
/// running untracked rather than disturbing it. Returns `TRUE`.
#[cfg(windows)]
// `hinst` is the module handle the loader hands us; it is only passed back to the OS.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "system" fn DllMain(hinst: HINSTANCE, reason: u32, _reserved: *mut c_void) -> i32 {
    if reason == DLL_PROCESS_ATTACH {
        // SAFETY: `hinst` is the module handle the loader passed to `DllMain`; the calls below only hand it, or this process's
        //     own id, back to the OS, and run before the host's `main` on the loader thread.
        unsafe {
            DisableThreadLibraryCalls(hinst);
            // Record our own base so install_all skips our module (never hook
            // our own pipe IPC).
            hooks::set_self_base(hinst as usize);
            let pid = GetCurrentProcessId();
            // A panic must not unwind out of `DllMain` into the loader.
            let _ = std::panic::catch_unwind(|| {
                if pipe::connect(pid) {
                    let _ = hooks::install_all();
                }
            });
        }
    } else if reason == DLL_PROCESS_DETACH {
        // Hooks live for the process lifetime; nothing to unwind here. The pipe
        // closes when the process exits, which the supervisor reads as EOF.
    }

    1
}
