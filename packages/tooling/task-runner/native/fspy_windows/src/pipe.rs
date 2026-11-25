//! Named-pipe IPC — DLL (client) side.
//!
//! One pipe per spawn, named `\\.\pipe\fspy-<pid>` where `<pid>` is the
//! tracked process's own PID. The parent creates the server before resuming
//! the suspended child, so the name is derivable on both ends with no env
//! plumbing. `PIPE_TYPE_MESSAGE` on the server means each `WriteFile` here is
//! delivered as one whole record (`[u8 mode][utf-8 path]`) — the supervisor
//! never has to reframe a byte stream.

#![cfg(windows)]

use std::sync::atomic::{AtomicIsize, Ordering};

use windows_sys::Win32::Foundation::{GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, WriteFile, OPEN_EXISTING};
use windows_sys::Win32::System::Pipes::{SetNamedPipeHandleState, WaitNamedPipeW, PIPE_READMODE_MESSAGE};

/// How long [`connect`] waits for a free pipe instance, in milliseconds.
const PIPE_WAIT_MS: u32 = 2000;

/// The connected write handle as `isize`, or `-1` when we never connected — in
/// which case [`send`] is a no-op and the tracked process runs untouched.
static PIPE: AtomicIsize = AtomicIsize::new(-1);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Connect to the parent's per-spawn pipe. Best-effort: returns `false` (and
/// leaves tracking disabled) if the server isn't there.
pub fn connect(pid: u32) -> bool {
    let name = wide(&fspy_wire::pipe_name(pid));

    // The parent creates the server before resuming us, but block briefly for a
    // free instance in case of a startup race.
    // SAFETY: `name` is NUL-terminated (`wide` appends it) and outlives the call.
    unsafe { WaitNamedPipeW(name.as_ptr(), PIPE_WAIT_MS) };

    // SAFETY: `name` is NUL-terminated and outlives the call; the security attributes and template handle are null.
    let handle = unsafe {
        CreateFileW(name.as_ptr(), GENERIC_WRITE, 0, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut())
    };

    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return false;
    }

    // Match the server's message mode so each WriteFile is one record.
    let read_mode = PIPE_READMODE_MESSAGE;
    // SAFETY: `handle` is the valid pipe handle opened above and `read_mode` outlives the call.
    unsafe { SetNamedPipeHandleState(handle, &read_mode, std::ptr::null(), std::ptr::null()) };

    PIPE.store(handle as isize, Ordering::Relaxed);

    true
}

/// Send one `[mode][path]` record. Never errors out the caller — a closed/full
/// pipe just drops the record.
pub fn send(mode: u8, path: &str) {
    let raw = PIPE.load(Ordering::Relaxed);

    if raw == -1 {
        return;
    }

    let handle = raw as HANDLE;

    let mut buf = vec![0_u8; fspy_wire::HEADER_LEN + path.len()];
    let len = fspy_wire::encode(&mut buf, mode, path.as_bytes());
    buf.truncate(len);

    let mut written: u32 = 0;
    // SAFETY: `handle` is the connected pipe handle stored by `connect`; `buf` is a live buffer of `buf.len()` bytes and
    //     `written` a valid out-parameter.
    unsafe {
        WriteFile(handle, buf.as_ptr(), buf.len() as u32, &mut written, std::ptr::null_mut());
    }
}
