//! NAPI surface for the Windows file-access tracker — Windows-only.
//!
//! `trackWithIatHook(argv, dllPath, options, onStarted)`:
//! 1. `CreateProcessW` the target **suspended** (so nothing runs before the
//!    hooks are in place).
//! 2. Create the per-spawn named-pipe server `\\.\pipe\fspy-<childPid>`.
//! 3. Inject `fspy_windows.dll` via `VirtualAllocEx` + `WriteProcessMemory` +
//!    `CreateRemoteThread(LoadLibraryW)`; the DLL's `DllMain` connects the pipe
//!    (derived from its own PID) and installs the IAT hooks.
//! 4. Wait (bounded) for the DLL to connect to the pipe. If the injection fails,
//!    the DLL does not load, or it never connects, the suspended child is
//!    terminated before it runs and the call fails, so the caller can run the
//!    command untracked instead of hanging.
//! 5. Resume the main thread; drain `[mode][path]` messages off the pipe until
//!    the child exits.
//!
//! Pure Win32 (no Detours/vcpkg). IAT pointer-swapping in the DLL is
//! arch-independent, so the same path covers x64 and ARM64.
//!
//! v1 inherits the parent's stdio (no capture yet — the orchestrator's
//! fingerprinting needs the accesses + exit code; stdout/stderr capture is a
//! follow-up), so `stdout`/`stderr` come back empty.

#![cfg(target_os = "windows")]
#![allow(clippy::too_many_lines)]

use std::collections::HashMap;
use std::sync::mpsc;
use std::thread;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, FALSE, HANDLE, INVALID_HANDLE_VALUE, TRUE,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_INBOUND};
use windows_sys::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateProcessW, CreateRemoteThread, GetExitCodeProcess, GetExitCodeThread, ResumeThread,
    TerminateProcess, WaitForMultipleObjects, WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    INFINITE, LPTHREAD_START_ROUTINE, PROCESS_INFORMATION, STARTUPINFOW,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

/// How long `LoadLibraryW` may take in the suspended child before we give up.
const LOAD_TIMEOUT_MS: u32 = 10_000;

/// How long to wait for the DLL's pipe connection once `LoadLibraryW` has
/// returned. `DllMain` connects synchronously, so by then the connection either
/// exists or never will; the slack only covers scheduler lag.
const CONNECT_TIMEOUT_MS: u32 = 3_000;

/// One client per pipe: only the injected DLL of the one tracked process connects.
const PIPE_MAX_INSTANCES: u32 = 1;

/// In-buffer size of the pipe, in bytes. Outbound is 0 because the pipe is inbound only.
const PIPE_BUFFER_BYTES: u32 = 64 * 1024;

#[napi(object)]
pub struct WinFileAccess {
    pub path: String,
    pub kind: String,
}

#[napi(object)]
pub struct WinTrackingResult {
    pub accesses: Vec<WinFileAccess>,
    pub exit_code: i32,
    pub stdout: Buffer,
    pub stderr: Buffer,
}

#[napi(object)]
pub struct WinSpawnOptions {
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

/// `trackWithIatHook(argv, dllPath, options?, onStarted?)`. `argv` is a direct
/// binary invocation; the DLL at `dllPath` is injected and reports accesses.
#[napi(
    catch_unwind,
    ts_args_type = "argv: Array<string>, dllPath: string, options?: WinSpawnOptions | undefined | null, onStarted?: ((pid: number) => void) | undefined | null"
)]
pub async fn track_with_iat_hook(
    argv: Vec<String>,
    dll_path: String,
    options: Option<WinSpawnOptions>,
    on_started: Option<ThreadsafeFunction<u32, (), u32, Status, false>>,
) -> Result<WinTrackingResult> {
    if argv.is_empty() {
        return Err(Error::new(Status::InvalidArg, "argv must not be empty"));
    }

    let cwd = options.as_ref().and_then(|o| o.cwd.clone());
    let env = options.and_then(|o| o.env);

    let (pid_tx, pid_rx) = mpsc::sync_channel::<u32>(1);

    let work = tokio::task::spawn_blocking(move || run(argv, dll_path, cwd, env, pid_tx));

    if let Some(tsfn) = on_started {
        tokio::task::spawn_blocking(move || {
            if let Ok(pid) = pid_rx.recv() {
                tsfn.call(pid, ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
    }

    work.await
        .map_err(|e| Error::new(Status::GenericFailure, format!("windows tracker panicked: {e}")))?
        .map_err(|e| Error::new(Status::GenericFailure, format!("windows tracker failed: {e}")))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Quote one argv element per the `CommandLineToArgvW` rules so the child
/// re-parses the exact arguments.
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{0b}', '"']) {
        return arg.to_string();
    }

    let mut out = String::from('"');
    let mut backslashes = 0;

    for ch in arg.chars() {
        match ch {
            '\\' => {
                backslashes += 1;
            }
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                backslashes = 0;
                out.push(ch);
            }
        }
    }

    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// Build the `CREATE_UNICODE_ENVIRONMENT` block: `key=value\0…\0\0`. The
/// caller's overrides are merged on top of the current process environment.
fn build_env_block(overrides: &HashMap<String, String>) -> Vec<u16> {
    let mut merged: HashMap<String, String> = std::env::vars().collect();
    for (k, v) in overrides {
        merged.insert(k.clone(), v.clone());
    }

    let mut block: Vec<u16> = Vec::new();
    for (k, v) in &merged {
        block.extend(format!("{k}={v}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

fn close(handle: HANDLE) {
    if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
        // SAFETY: `handle` is a non-null, non-invalid handle this process owns and closes only here.
        unsafe { CloseHandle(handle) };
    }
}

fn run(
    argv: Vec<String>,
    dll_path: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    pid_tx: mpsc::SyncSender<u32>,
) -> std::io::Result<WinTrackingResult> {
    let command_line = argv.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ");
    let mut cmd_wide = wide(&command_line);

    let cwd_wide = cwd.as_deref().map(wide);
    let mut env_block = env.as_ref().map(build_env_block);

    // SAFETY: `STARTUPINFOW` is plain data for which all-zero is valid.
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;

    // SAFETY: `PROCESS_INFORMATION` is plain data for which all-zero is valid; `CreateProcessW` fills it.
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let creation_flags = CREATE_SUSPENDED | if env_block.is_some() { CREATE_UNICODE_ENVIRONMENT } else { 0 };

    // SAFETY: every pointer is null or points at a NUL-terminated buffer that outlives the call (`cmd_wide` is the mutable
    //     command line the API requires); `startup` and `info` are live and correctly sized.
    let ok = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmd_wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            FALSE,
            creation_flags,
            env_block.as_mut().map_or(std::ptr::null(), |b| b.as_mut_ptr().cast()),
            cwd_wide.as_ref().map_or(std::ptr::null(), |w| w.as_ptr()),
            &startup,
            &mut info,
        )
    };

    if ok == FALSE {
        // SAFETY: reads the calling thread's last-error value; nothing intervened since the failed call.
        return Err(std::io::Error::from_raw_os_error(unsafe { GetLastError() } as i32));
    }

    let child_pid = info.dwProcessId;
    let _ = pid_tx.send(child_pid);

    // Create the pipe server, inject the DLL and wait for it to connect, all
    // while the child is still suspended. Any failure means the child cannot be
    // tracked: terminate it before it runs a single instruction of its own and
    // report the error, so the caller can run the command untracked, once.
    let pipe = match attach_tracker(info.hProcess, child_pid, &dll_path) {
        Ok(pipe) => pipe,
        Err(error) => {
            // SAFETY: `info.hProcess` is the valid handle `CreateProcessW` just returned.
            unsafe { TerminateProcess(info.hProcess, 1) };
            close(info.hThread);
            close(info.hProcess);
            return Err(error);
        }
    };

    // Reader thread drains the pipe until the child closes its write end (EOF).
    let handle = pipe as isize;
    let reader = thread::spawn(move || drain_pipe(handle as HANDLE));

    // SAFETY: `info.hThread` is the valid, suspended primary thread handle from `CreateProcessW`.
    unsafe { ResumeThread(info.hThread) };
    // SAFETY: `info.hProcess` is the valid process handle from `CreateProcessW`.
    unsafe { WaitForSingleObject(info.hProcess, INFINITE) };

    let mut exit_code: u32 = 1;
    // SAFETY: `info.hProcess` is a valid handle and `exit_code` a live out-parameter.
    unsafe { GetExitCodeProcess(info.hProcess, &mut exit_code) };

    let accesses = reader.join().unwrap_or_default();

    close(info.hThread);
    close(info.hProcess);

    Ok(WinTrackingResult {
        accesses,
        exit_code: exit_code as i32,
        stdout: Buffer::from(Vec::new()),
        stderr: Buffer::from(Vec::new()),
    })
}

fn last_error(context: &str) -> std::io::Error {
    // SAFETY: reads the calling thread's last-error value.
    let code = unsafe { GetLastError() };
    let os = std::io::Error::from_raw_os_error(code as i32);

    std::io::Error::new(os.kind(), format!("{context}: {os}"))
}

fn failure(message: &str) -> std::io::Error {
    std::io::Error::other(message.to_string())
}

/// Create the per-spawn pipe server, inject the DLL and wait until it has
/// connected. Returns the connected (overlapped) pipe handle.
///
/// The server is created BEFORE injecting so the DLL's connect (on attach,
/// before resume) always finds it, and its connect is armed before injecting too,
/// so the wait below observes it. The connect is overlapped so it can be bounded
/// by a timeout and by the child exiting; a blocking `ConnectNamedPipe` hangs
/// forever when the DLL fails to load or never connects.
fn attach_tracker(process: HANDLE, child_pid: u32, dll_path: &str) -> std::io::Result<HANDLE> {
    let pipe_name = wide(&fspy_wire::pipe_name(child_pid));
    // SAFETY: `pipe_name` is NUL-terminated and outlives the call; the security attributes are null (defaults).
    let pipe = unsafe {
        CreateNamedPipeW(
            pipe_name.as_ptr(),
            PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
            PIPE_MAX_INSTANCES,
            0,
            PIPE_BUFFER_BYTES,
            0,
            std::ptr::null(),
        )
    };

    if pipe == INVALID_HANDLE_VALUE {
        return Err(last_error("CreateNamedPipeW failed"));
    }

    match inject_and_connect(pipe, process, dll_path) {
        Ok(()) => Ok(pipe),
        Err(error) => {
            close(pipe);
            Err(error)
        }
    }
}

fn inject_and_connect(pipe: HANDLE, process: HANDLE, dll_path: &str) -> std::io::Result<()> {
    // SAFETY: all arguments are null or constants; the returned handle is checked below.
    let event = unsafe { CreateEventW(std::ptr::null(), TRUE, FALSE, std::ptr::null()) };
    if event.is_null() {
        return Err(last_error("CreateEventW failed"));
    }

    // SAFETY: `OVERLAPPED` is plain data for which all-zero is valid.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.hEvent = event;

    let pending = match begin_connect(pipe, &mut overlapped) {
        Ok(pending) => pending,
        Err(error) => {
            close(event);
            return Err(error);
        }
    };

    let result =
        inject_dll(process, dll_path).and_then(|()| if pending { wait_connected(event, process) } else { Ok(()) });

    // A connect that is still outstanding must be cancelled and drained before
    // `overlapped` goes out of scope: the kernel writes to it on completion.
    if pending {
        finish_connect(pipe, &mut overlapped, result.is_err());
    }

    close(event);
    result
}

/// Arm an overlapped `ConnectNamedPipe`. `Ok(true)` when it is pending, `Ok(false)`
/// when the client had already connected.
fn begin_connect(pipe: HANDLE, overlapped: &mut OVERLAPPED) -> std::io::Result<bool> {
    // An overlapped connect normally returns FALSE and reports its state in the
    // last error; a TRUE return would mean it already completed.
    // SAFETY: `pipe` is the open server handle and `overlapped` lives in the caller's frame until the I/O completes
    //     (see `finish_connect`).
    if unsafe { ConnectNamedPipe(pipe, overlapped) } != FALSE {
        return Ok(false);
    }

    // SAFETY: reads the calling thread's last-error value; nothing intervened since `ConnectNamedPipe`.
    match unsafe { GetLastError() } {
        ERROR_IO_PENDING => Ok(true),
        ERROR_PIPE_CONNECTED => Ok(false),
        _ => Err(last_error("ConnectNamedPipe failed")),
    }
}

/// Wait until the connect completes, the child exits, or the timeout passes.
fn wait_connected(event: HANDLE, process: HANDLE) -> std::io::Result<()> {
    let handles = [event, process];
    // SAFETY: `handles` is a live array of two valid handles and the count passed is its length.
    let waited = unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), FALSE, CONNECT_TIMEOUT_MS) };

    match waited {
        WAIT_OBJECT_0 => Ok(()),
        w if w == WAIT_OBJECT_0 + 1 => Err(failure("the tracked process exited before the tracker DLL connected")),
        WAIT_TIMEOUT => Err(failure("the tracker DLL did not connect to the pipe in time")),
        _ => Err(last_error("waiting for the tracker DLL to connect failed")),
    }
}

/// Finish an armed overlapped connect so its `OVERLAPPED` can be dropped.
/// `cancel` aborts it first (the failure paths); otherwise it has completed.
fn finish_connect(pipe: HANDLE, overlapped: &mut OVERLAPPED, cancel: bool) {
    if cancel {
        // SAFETY: `pipe` is the open handle and `overlapped` the structure the pending I/O was started with.
        unsafe { CancelIoEx(pipe, overlapped) };
    }

    let mut transferred = 0u32;
    // SAFETY: `pipe` is the open handle and `overlapped` the structure the pending I/O was started with; it blocks until
    //     the (cancelled or finished) I/O completes, so the structure is no longer in use afterwards.
    unsafe { GetOverlappedResult(pipe, overlapped, &mut transferred, TRUE) };
}

/// `VirtualAllocEx` + `WriteProcessMemory` the wide DLL path into the child,
/// then `CreateRemoteThread(LoadLibraryW)` to load it. Succeeds only when
/// `LoadLibraryW` itself returned a module handle: it is the remote thread's
/// exit code, so zero means the DLL did not load (missing file or dependency, a
/// bitness mismatch, a failing `DllMain`).
fn inject_dll(process: HANDLE, dll_path: &str) -> std::io::Result<()> {
    let path_wide = wide(dll_path);
    let bytes = path_wide.len() * std::mem::size_of::<u16>();

    // SAFETY: `process` is a valid handle with the access `CreateProcess` grants its creator; the remote buffer is sized
    //     for `path_wide`, written once, and only freed after the remote thread has finished or on an error path.
    //     The `transmute` only changes the pointer-argument type of `LoadLibraryW`, which takes one pointer and returns a
    //     value that fits the thread-start signature.
    unsafe {
        let remote = VirtualAllocEx(process, std::ptr::null(), bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if remote.is_null() {
            return Err(last_error("VirtualAllocEx failed"));
        }

        let mut written = 0usize;
        let wrote = WriteProcessMemory(process, remote, path_wide.as_ptr().cast(), bytes, &mut written);
        if wrote == FALSE {
            let error = last_error("WriteProcessMemory failed");
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            return Err(error);
        }

        let kernel32 = GetModuleHandleW(wide("kernel32.dll").as_ptr());
        let load_library =
            if kernel32.is_null() { None } else { GetProcAddress(kernel32, c"LoadLibraryW".as_ptr().cast()) };
        let Some(load_library) = load_library else {
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            return Err(failure("could not resolve LoadLibraryW"));
        };

        // LoadLibraryW(LPCWSTR) matches the LPTHREAD_START_ROUTINE shape
        // (one pointer arg); the remote allocation is that arg.
        let start: LPTHREAD_START_ROUTINE = Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
        >(load_library));
        let thread = CreateRemoteThread(process, std::ptr::null(), 0, start, remote, 0, std::ptr::null_mut());

        if thread == INVALID_HANDLE_VALUE || thread.is_null() {
            let error = last_error("CreateRemoteThread failed");
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            return Err(error);
        }

        if WaitForSingleObject(thread, LOAD_TIMEOUT_MS) != WAIT_OBJECT_0 {
            // The thread may still be reading `remote`, so leave it allocated;
            // the caller terminates the process.
            close(thread);
            return Err(failure("LoadLibraryW did not return in time"));
        }

        let mut exit_code = 0u32;
        let got_exit_code = GetExitCodeThread(thread, &mut exit_code);
        close(thread);
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);

        if got_exit_code == FALSE {
            return Err(last_error("GetExitCodeThread failed"));
        }

        // `LoadLibraryW` returns the module handle, truncated to the thread's
        // 32-bit exit code; NULL (0) means it failed. A loaded module whose base
        // happens to have zero low 32 bits also reads as 0; that is a rare false
        // failure and only costs an untracked run.
        if exit_code == 0 {
            return Err(failure("LoadLibraryW failed to load the tracker DLL in the target process"));
        }

        Ok(())
    }
}

/// Read `[u8 mode][utf-8 path]` messages off the (already connected) pipe until
/// EOF, de-duplicating.
fn drain_pipe(pipe: HANDLE) -> Vec<WinFileAccess> {
    let mut seen = std::collections::HashSet::<(String, u8)>::new();
    let mut out = Vec::new();

    let mut buf = [0u8; fspy_wire::PIPE_MESSAGE_MAX];

    // The pipe is overlapped, so every read needs an OVERLAPPED; we block on it.
    // SAFETY: all arguments are null or constants; a null event ends the loop below.
    let event = unsafe { CreateEventW(std::ptr::null(), TRUE, FALSE, std::ptr::null()) };

    while !event.is_null() {
        // SAFETY: `OVERLAPPED` is plain data for which all-zero is valid.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event;

        let mut read: u32 = 0;
        // SAFETY: `pipe` is the open overlapped handle; `buf`, `read` and `overlapped` are live and outlive the I/O, which is
        //     awaited below before the next iteration.
        let started = unsafe { ReadFile(pipe, buf.as_mut_ptr().cast(), buf.len() as u32, &mut read, &mut overlapped) };

        // SAFETY: reads the calling thread's last-error value right after `ReadFile`.
        let finished = if started == FALSE && unsafe { GetLastError() } == ERROR_IO_PENDING {
            // SAFETY: waits for the read started above on the same `pipe` and `overlapped`.
            unsafe { GetOverlappedResult(pipe, &overlapped, &mut read, TRUE) }
        } else {
            started
        };

        if finished == FALSE || read == 0 {
            break; // pipe closed (child + DLL gone) or error.
        }

        let Some(frame) = fspy_wire::decode(&buf[..read as usize]) else {
            continue;
        };

        let path = String::from_utf8_lossy(frame.path).into_owned();

        if seen.insert((path.clone(), frame.op)) {
            out.push(WinFileAccess { path, kind: fspy_wire::kind_name(frame.op).to_string() });
        }
    }

    close(event);
    close(pipe);
    out
}
