//! A ConPTY terminal whose command starts suspended, so it can be put in its Job Object before it runs.
//!
//! `portable-pty` creates a ConPTY command with fixed creation flags and keeps the primary thread
//! handle to itself, so the command is already running when the runner assigns it to its job. A
//! wrapper such as `cmd.exe` that starts a grandchild in that instant leaves the grandchild outside
//! the job, and a kill does not reach it. This module does what `portable-pty`'s ConPTY does (the
//! pseudo console, its two pipes, the process creation) with `CREATE_SUSPENDED` added, and puts the
//! result behind the same `MasterPty` and `Child` traits, so the rest of the runner is unchanged.
//!
//! The command line is built the way `portable-pty` builds it (executable search over `PATH` and
//! `PATHEXT`, MSVC argument quoting), so a command behaves the same on either path.

use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::mem;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::ptr;
use std::sync::{Arc, Mutex};

use portable_pty::{Child, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE, WAIT_FAILED};
use windows_sys::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use super::process_group::{self, JobObject};

/// `PSEUDOCONSOLE_INHERIT_CURSOR`, `PSEUDOCONSOLE_RESIZE_QUIRK` and `PSEUDOCONSOLE_WIN32_INPUT_MODE`: the
/// flags `portable-pty` creates its pseudo console with.
const PSEUDOCONSOLE_FLAGS: u32 = 0x1 | 0x2 | 0x4;

/// A terminal with its command running on it.
pub(crate) struct Started {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) child: Box<dyn Child + Send + Sync>,
    pub(crate) pid: u32,
}

/// Open a terminal of `size`, start `builder`'s command on it suspended, assign it to `job` and let it run.
pub(crate) fn start(builder: &CommandBuilder, size: PtySize, job: Option<&JobObject>) -> io::Result<Started> {
    let (input_read, input_write) = pipe()?;
    let (output_read, output_write) = pipe()?;

    let mut console: HPCON = 0;
    let coord = COORD { X: size.cols as i16, Y: size.rows as i16 };
    // SAFETY: both handles are open pipe ends this function owns, and `console` is a valid out pointer.
    let result = unsafe {
        CreatePseudoConsole(
            coord,
            input_read.as_raw_handle() as HANDLE,
            output_write.as_raw_handle() as HANDLE,
            PSEUDOCONSOLE_FLAGS,
            &mut console,
        )
    };

    if result != 0 {
        return Err(io::Error::other(format!("failed to create a pseudo console: HRESULT {result}")));
    }

    // The console host has its own duplicates of these two ends; keeping ours would stop the output
    // from ever reporting its end.
    drop(input_read);
    drop(output_write);

    let master = Master {
        inner: Arc::new(Mutex::new(Inner {
            console: Console(console),
            readable: File::from(output_read),
            writable: Some(File::from(input_write)),
            size,
        })),
    };

    let (process, pid) = spawn_suspended(builder, console)?;

    // The command has not run a single instruction yet, so nothing it starts can be outside the job.
    if let Err(error) = process_group::assign_and_resume(job, pid) {
        // SAFETY: `process` is the open process handle `CreateProcessW` returned.
        unsafe { TerminateProcess(process.as_raw_handle() as HANDLE, 1) };

        return Err(error);
    }

    Ok(Started { master: Box::new(master), child: Box::new(WinChild { process, pid }), pid })
}

/// An anonymous pipe: its read end and its write end.
fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write): (HANDLE, HANDLE) = (ptr::null_mut(), ptr::null_mut());

    // SAFETY: both out pointers are valid; a null security descriptor means the defaults.
    if unsafe { CreatePipe(&mut read, &mut write, ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: `CreatePipe` returned two new handles that nothing else owns.
    Ok(unsafe { (OwnedHandle::from_raw_handle(read), OwnedHandle::from_raw_handle(write)) })
}

/// `CreateProcessW` for `builder`'s command on `console`, with the primary thread suspended: the
/// process handle and the process id.
fn spawn_suspended(builder: &CommandBuilder, console: HPCON) -> io::Result<(OwnedHandle, u32)> {
    let argv = builder.get_argv();

    let program = argv.first().ok_or_else(|| io::Error::other("no program to start"))?;
    let executable = search_path(builder, program);

    let mut command_line: Vec<u16> = Vec::new();

    append_quoted(&executable, &mut command_line);

    for argument in argv.iter().skip(1) {
        if argument.encode_wide().any(|unit| unit == 0) {
            return Err(io::Error::other(format!("invalid encoding for command line argument {argument:?}")));
        }

        command_line.push(u16::from(b' '));
        append_quoted(argument, &mut command_line);
    }

    command_line.push(0);

    let mut application: Vec<u16> = executable.encode_wide().collect();

    application.push(0);

    let environment = environment_block(builder);
    let directory = current_directory(builder);

    let mut attributes = AttributeList::with_pseudo_console(console)?;

    // SAFETY: an all-zero STARTUPINFOEXW is a valid starting value.
    let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() };

    startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
    // The standard handles are invalid on purpose: left alone, the command could inherit this
    // process's redirected output instead of using the terminal.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    startup.lpAttributeList = attributes.as_mut_ptr();

    // SAFETY: an all-zero PROCESS_INFORMATION is a valid out value.
    let mut information: PROCESS_INFORMATION = unsafe { mem::zeroed() };

    // SAFETY: every buffer is NUL-terminated and outlives the call, `startup` carries a valid
    // attribute list, and `information` is a valid out pointer.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            environment.as_ptr().cast(),
            directory.as_ref().map_or(ptr::null(), |directory| directory.as_ptr()),
            &startup.StartupInfo,
            &mut information,
        )
    };

    if created == 0 {
        let error = io::Error::last_os_error();
        let shown = String::from_utf16_lossy(command_line.strip_suffix(&[0]).unwrap_or(&command_line));

        return Err(io::Error::new(error.kind(), format!("CreateProcessW `{shown}` failed: {error}")));
    }

    // SAFETY: the thread handle is owned by nobody else and is not needed.
    unsafe { CloseHandle(information.hThread) };

    // SAFETY: `CreateProcessW` returned a new process handle.
    Ok((unsafe { OwnedHandle::from_raw_handle(information.hProcess) }, information.dwProcessId))
}

/// The executable `program` names: searched over `PATH` and `PATHEXT` as `portable-pty` does.
fn search_path(builder: &CommandBuilder, program: &OsStr) -> OsString {
    if let Some(path) = builder.get_env("PATH") {
        let extensions = builder.get_env("PATHEXT").unwrap_or(OsStr::new(".EXE"));

        for directory in std::env::split_paths(path) {
            let candidate = directory.join(program);

            if candidate.exists() {
                return candidate.into_os_string();
            }

            for extension in std::env::split_paths(extensions) {
                let Some(extension) = extension.to_str().and_then(|extension| extension.strip_prefix('.')) else {
                    continue;
                };

                let candidate = directory.join(program).with_extension(extension);

                if candidate.exists() {
                    return candidate.into_os_string();
                }
            }
        }
    }

    program.to_owned()
}

/// Append `argument` to `command_line`, quoted for the Microsoft C runtime's argument parsing.
fn append_quoted(argument: &OsStr, command_line: &mut Vec<u16>) {
    let units: Vec<u16> = argument.encode_wide().collect();
    let plain = !units.is_empty()
        && !units.iter().any(|&unit| {
            unit == u16::from(b' ')
                || unit == u16::from(b'\t')
                || unit == u16::from(b'\n')
                || unit == 0x0b
                || unit == u16::from(b'"')
        });

    if plain {
        command_line.extend(units);
        return;
    }

    command_line.push(u16::from(b'"'));

    let mut index = 0;

    while index < units.len() {
        let mut backslashes = 0;

        while index < units.len() && units[index] == u16::from(b'\\') {
            index += 1;
            backslashes += 1;
        }

        if index == units.len() {
            command_line.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2));
            break;
        }

        if units[index] == u16::from(b'"') {
            command_line.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2 + 1));
        } else {
            command_line.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
        }

        command_line.push(units[index]);
        index += 1;
    }

    command_line.push(u16::from(b'"'));
}

/// The environment as `CreateProcessW` takes it: `KEY=value` entries, each ended by a NUL, sorted by
/// key without regard to case, and one more NUL at the end. An empty environment is two NULs: a single
/// one would read as the end of an entry that is not there.
fn environment_block(builder: &CommandBuilder) -> Vec<u16> {
    let mut entries: Vec<(String, &str, &str)> =
        builder.iter_full_env_as_str().map(|(key, value)| (key.to_uppercase(), key, value)).collect();

    entries.sort_by(|left, right| left.0.cmp(&right.0));

    let mut block: Vec<u16> = Vec::new();

    for (_, key, value) in entries {
        block.extend(OsStr::new(key).encode_wide());
        block.push(u16::from(b'='));
        block.extend(OsStr::new(value).encode_wide());
        block.push(0);
    }

    if block.is_empty() {
        block.push(0);
    }

    block.push(0);

    block
}

/// The directory the command starts in: the requested one when it exists, else the user profile.
fn current_directory(builder: &CommandBuilder) -> Option<Vec<u16>> {
    let profile = builder.get_env("USERPROFILE").filter(|path| Path::new(path).is_dir());
    let requested = builder.get_cwd().map(OsString::as_os_str).filter(|path| Path::new(path).is_dir());
    let directory = requested.or(profile)?;

    let mut wide: Vec<u16> = match (Path::new(directory).is_relative(), std::env::current_dir()) {
        (true, Ok(current)) => current.join(directory).as_os_str().encode_wide().collect(),
        _ => directory.encode_wide().collect(),
    };

    wide.push(0);

    Some(wide)
}

/// A `PROC_THREAD_ATTRIBUTE_LIST` holding the pseudo console.
struct AttributeList {
    /// Pointer-sized units, so the list is aligned the way the API expects.
    data: Vec<usize>,
}

impl AttributeList {
    fn with_pseudo_console(console: HPCON) -> io::Result<Self> {
        let mut size = 0usize;

        // SAFETY: the first call only asks for the size the list needs.
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size) };

        let mut data = vec![0usize; size.div_ceil(mem::size_of::<usize>())];

        // SAFETY: `data` is at least as large as the first call asked for.
        if unsafe { InitializeProcThreadAttributeList(data.as_mut_ptr().cast(), 1, 0, &mut size) } == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut list = Self { data };

        // SAFETY: the list is initialised, and the value is the console handle itself, as
        // `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` requires.
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const c_void,
                mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null(),
            )
        };

        if updated == 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(list)
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.data.as_mut_ptr().cast()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: the list was initialised in `with_pseudo_console`.
        unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
    }
}

/// The pseudo console; closing it blocks until the console host is done (the caller drops the master on
/// a thread of its own).
struct Console(HPCON);

impl Drop for Console {
    fn drop(&mut self) {
        // SAFETY: the handle came from `CreatePseudoConsole` and is closed once.
        unsafe { ClosePseudoConsole(self.0) };
    }
}

/// Field order matters: the console is closed before the pipes it writes to.
struct Inner {
    console: Console,
    readable: File,
    writable: Option<File>,
    size: PtySize,
}

struct Master {
    inner: Arc<Mutex<Inner>>,
}

impl Master {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, anyhow::Error> {
        self.inner.lock().map_err(|_| anyhow::anyhow!("the terminal lock is poisoned"))
    }
}

impl MasterPty for Master {
    fn resize(&self, size: PtySize) -> Result<(), anyhow::Error> {
        let mut inner = self.lock()?;
        let coord = COORD { X: size.cols as i16, Y: size.rows as i16 };

        // SAFETY: the console is open while `inner` is alive.
        let result = unsafe { ResizePseudoConsole(inner.console.0, coord) };

        anyhow::ensure!(result == 0, "failed to resize the console to {}x{}: HRESULT {result}", size.cols, size.rows);

        inner.size = size;

        Ok(())
    }

    fn get_size(&self) -> Result<PtySize, anyhow::Error> {
        Ok(self.lock()?.size)
    }

    fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>, anyhow::Error> {
        Ok(Box::new(self.lock()?.readable.try_clone()?))
    }

    fn take_writer(&self) -> Result<Box<dyn Write + Send>, anyhow::Error> {
        let writer = self.lock()?.writable.take().ok_or_else(|| anyhow::anyhow!("the writer was already taken"))?;

        Ok(Box::new(writer))
    }
}

/// The command's process, as `portable-pty`'s child handle.
#[derive(Debug)]
struct WinChild {
    process: OwnedHandle,
    pid: u32,
}

impl WinChild {
    fn raw(&self) -> HANDLE {
        self.process.as_raw_handle() as HANDLE
    }
}

impl ChildKiller for WinChild {
    fn kill(&mut self) -> io::Result<()> {
        // SAFETY: the process handle is open and has terminate access (`CreateProcessW` returns full access).
        unsafe { TerminateProcess(self.raw(), 1) };

        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        let process = self.process.try_clone().expect("the process handle can be duplicated");

        Box::new(WinChild { process, pid: self.pid })
    }
}

impl Child for WinChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let mut code = 0u32;

        // SAFETY: the process handle is open and `code` is a valid out pointer.
        if unsafe { GetExitCodeProcess(self.raw(), &mut code) } == 0 || code as i32 == STILL_ACTIVE {
            return Ok(None);
        }

        Ok(Some(ExitStatus::with_exit_code(code)))
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        // SAFETY: the process handle is open.
        if unsafe { WaitForSingleObject(self.raw(), INFINITE) } == WAIT_FAILED {
            return Err(io::Error::last_os_error());
        }

        let mut code = 0u32;

        // SAFETY: as above.
        if unsafe { GetExitCodeProcess(self.raw(), &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(ExitStatus::with_exit_code(code))
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn as_raw_handle(&self) -> Option<RawHandle> {
        Some(self.process.as_raw_handle())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(block: &[u16]) -> String {
        String::from_utf16_lossy(block).replace('\0', "|")
    }

    #[test]
    fn the_environment_block_is_sorted_and_ended_by_a_second_nul() {
        let mut builder = CommandBuilder::new("cmd.exe");

        builder.env_clear();
        builder.env("b", "2");
        builder.env("A", "1");

        assert_eq!(text(&environment_block(&builder)), "A=1|b=2||");
    }

    #[test]
    fn an_empty_environment_is_two_nuls() {
        let mut builder = CommandBuilder::new("cmd.exe");

        builder.env_clear();

        assert_eq!(environment_block(&builder), [0, 0]);
    }
}
