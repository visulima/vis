//! Starting a command with `posix_spawn` on macOS.
//!
//! A command has to lead a session of its own, so that `kill(-pid)` reaches everything it starts
//! and it has no controlling terminal. The standard library can only do that through a `pre_exec`
//! hook, and a hook makes it `fork` the whole process first. In a large process (Node and its
//! heap) that costs several milliseconds per command, on the one thread that starts them, which
//! made a run of 200 short commands seven times slower than the JS spawner.
//!
//! `posix_spawn` with `POSIX_SPAWN_SETSID` makes the same session without the `fork`. It needs
//! a spawner of our own, because `std::process::Command` offers no way to set that flag. This one
//! does what `Command` does for the cases the runner uses: it wires stdin, stdout and stderr,
//! changes the directory, builds the environment, finds the program on `PATH`, resets the signal
//! mask and `SIGPIPE`, reports a failure to start as an error from the call, and kills and reaps
//! a command that is dropped while it runs.

use std::collections::HashSet;
use std::ffi::{CString, OsStr, OsString};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::ptr;
use std::sync::OnceLock;

use nix::libc;
use tokio::net::unix::pipe::{Receiver, Sender};
use tokio::signal::unix::{signal, SignalKind};

use super::types::{ConcurrentCommandConfig, StdinMode};

/// `POSIX_SPAWN_SETSID` (`<sys/spawn.h>`, macOS 10.15 and later); the `libc` crate does not export it.
const POSIX_SPAWN_SETSID: libc::c_short = 0x0400;

/// What `execvp` searches when the environment has no `PATH`.
const DEFAULT_PATH: &str = "/usr/bin:/bin";

type AddChdir = unsafe extern "C" fn(*mut libc::posix_spawn_file_actions_t, *const libc::c_char) -> libc::c_int;

/// `posix_spawn_file_actions_addchdir_np`, looked up at run time: the symbol exists from macOS
/// 10.15, and a build that links it directly would not load on an older system at all. `None`
/// when it is missing (or `POSIX_SPAWN_SETSID`, which came with it, cannot be relied on), and
/// the caller then starts commands the way it does on every other platform.
fn add_chdir() -> Option<AddChdir> {
    static SYMBOL: OnceLock<Option<AddChdir>> = OnceLock::new();

    *SYMBOL.get_or_init(|| {
        // SAFETY: a lookup of a symbol by a NUL-terminated name; the result, when found, has this signature.
        let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"posix_spawn_file_actions_addchdir_np".as_ptr()) };

        (!symbol.is_null()).then(|| unsafe { std::mem::transmute::<*mut libc::c_void, AddChdir>(symbol) })
    })
}

/// Whether [`spawn`] can be used on this system.
pub(crate) fn available() -> bool {
    add_chdir().is_some()
}

/// A command started with [`spawn`]. Its pipes are not part of it: they are handed out separately.
pub(crate) struct Child {
    pid: libc::pid_t,
    /// Set once the exit status has been collected; until then the process may be a zombie.
    reaped: bool,
}

/// The parent's ends of a started command's pipes.
pub(crate) struct Pipes {
    pub(crate) stdin: Option<Sender>,
    pub(crate) stdout: Receiver,
    pub(crate) stderr: Receiver,
}

impl Child {
    pub(crate) fn id(&self) -> u32 {
        self.pid as u32
    }

    /// Collect the exit status if the command has ended.
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let mut status: libc::c_int = 0;

        loop {
            // SAFETY: `status` is a valid out-pointer and `pid` is a child of this process.
            match unsafe { libc::waitpid(self.pid, &raw mut status, libc::WNOHANG) } {
                0 => return Ok(None),
                -1 => {
                    let error = io::Error::last_os_error();

                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                }
                _ => {
                    self.reaped = true;

                    return Ok(Some(ExitStatus::from_raw(status)));
                }
            }
        }
    }

    /// Wait for the command to end. The exit is noticed through `SIGCHLD`; the listener is
    /// registered before the first check, so an exit between the two is not missed.
    pub(crate) async fn wait(&mut self) -> io::Result<ExitStatus> {
        let mut child_exited = signal(SignalKind::child())?;

        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }

            if child_exited.recv().await.is_none() {
                return Err(io::Error::other("the signal driver shut down while waiting for a command"));
            }
        }
    }
}

impl Drop for Child {
    /// A command that is let go of while it runs is killed, and collected so it does not stay a
    /// zombie: the same as `kill_on_drop` on the standard path. The kill is aimed at the process
    /// only, like that one.
    fn drop(&mut self) {
        if self.reaped {
            return;
        }

        let pid = self.pid;

        // SAFETY: signalling a child of this process that has not been collected.
        unsafe { libc::kill(pid, libc::SIGKILL) };

        // Dropping may happen while the runtime is shutting down, so the collecting does not rely on it.
        std::thread::spawn(move || {
            let mut status: libc::c_int = 0;

            // SAFETY: waits for a child of this process; the process was just sent SIGKILL.
            unsafe { libc::waitpid(pid, &raw mut status, 0) };
        });
    }
}

/// Start `program` with `args` for `config`: its directory, environment and stdin. Output is
/// always piped. Must run inside the async runtime's context (the pipes register with it).
pub(crate) fn spawn(program: &str, args: &[String], config: &ConcurrentCommandConfig) -> io::Result<(Child, Pipes)> {
    let environment = environment(config);
    let program = resolve_program(program, config.cwd.as_deref(), &environment)?;
    let argv = std::iter::once(program.original.as_str())
        .chain(args.iter().map(String::as_str))
        .map(cstring)
        .collect::<io::Result<Vec<_>>>()?;
    let envp = environment.into_iter().map(|(key, value)| env_entry(&key, &value)).collect::<io::Result<Vec<_>>>()?;
    let cwd = config.cwd.as_deref().map(cstring).transpose()?;

    let (stdout_read, stdout_write) = pipe()?;
    let (stderr_read, stderr_write) = pipe()?;
    let stdin_pipe = (config.stdin == StdinMode::Pipe).then(pipe).transpose()?;

    // The parent's ends are read and written through the runtime, which needs them non-blocking.
    // The child's ends are other open files, so this does not reach the command.
    set_nonblocking(&stdout_read)?;
    set_nonblocking(&stderr_read)?;

    if let Some((_, write)) = &stdin_pipe {
        set_nonblocking(write)?;
    }

    let mut actions = FileActions::new()?;

    match (&stdin_pipe, config.stdin) {
        (Some((read, _)), _) => actions.dup2(read.as_raw_fd(), 0)?,
        (None, StdinMode::Inherit) => {}
        (None, _) => actions.open_null(0)?,
    }

    actions.dup2(stdout_write.as_raw_fd(), 1)?;
    actions.dup2(stderr_write.as_raw_fd(), 2)?;

    if let Some(cwd) = &cwd {
        actions.chdir(cwd)?;
    }

    let attributes = Attributes::new()?;
    let mut pid: libc::pid_t = 0;
    let mut executable = program.path;
    let mut argv = argv;

    loop {
        let pointers: Vec<*mut libc::c_char> =
            argv.iter().map(|argument| argument.as_ptr().cast_mut()).chain(std::iter::once(ptr::null_mut())).collect();
        let environment_pointers: Vec<*mut libc::c_char> =
            envp.iter().map(|entry| entry.as_ptr().cast_mut()).chain(std::iter::once(ptr::null_mut())).collect();

        // SAFETY: every pointer refers to a NUL-terminated string, or a NULL-terminated array of
        // them, that outlives the call; the actions and attributes are initialised.
        let code = unsafe {
            libc::posix_spawn(
                &raw mut pid,
                executable.as_ptr(),
                actions.as_ptr(),
                attributes.as_ptr(),
                pointers.as_ptr(),
                environment_pointers.as_ptr(),
            )
        };

        match code {
            0 => break,
            // A file that is not a binary and has no `#!` line: what `execvp` hands to the shell.
            libc::ENOEXEC if executable.to_bytes() != b"/bin/sh" => {
                argv.insert(0, c"/bin/sh".to_owned());
                argv[1] = executable;
                executable = c"/bin/sh".to_owned();
            }
            code => return Err(io::Error::from_raw_os_error(code)),
        }
    }

    // The child holds its own ends now.
    drop((stdout_write, stderr_write));

    let child = Child { pid, reaped: false };
    let stdin = match stdin_pipe {
        Some((read, write)) => {
            drop(read);

            Some(write)
        }
        None => None,
    };

    // On an error here `child` is dropped, which kills and collects the command.
    let pipes = Pipes {
        stdin: stdin.map(Sender::from_owned_fd).transpose()?,
        stdout: Receiver::from_owned_fd(stdout_read)?,
        stderr: Receiver::from_owned_fd(stderr_read)?,
    };

    Ok((child, pipes))
}

fn cstring(value: &str) -> io::Result<CString> {
    CString::new(value).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "nul byte found in provided data"))
}

fn env_entry(key: &OsStr, value: &OsStr) -> io::Result<CString> {
    let mut entry = Vec::with_capacity(key.len() + value.len() + 1);

    entry.extend_from_slice(key.as_bytes());
    entry.push(b'=');
    entry.extend_from_slice(value.as_bytes());

    CString::new(entry).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "nul byte found in provided data"))
}

/// The environment the command starts with: this process's, unless the caller opted out, with the
/// caller's variables on top.
fn environment(config: &ConcurrentCommandConfig) -> Vec<(OsString, OsString)> {
    let overlay = config.env.as_ref();
    let mut variables: Vec<(OsString, OsString)> = if config.inherit_env == Some(false) {
        Vec::new()
    } else {
        let overridden: HashSet<&OsStr> =
            overlay.into_iter().flatten().map(|(key, _)| OsStr::new(key.as_str())).collect();

        std::env::vars_os().filter(|(key, _)| !overridden.contains(key.as_os_str())).collect()
    };

    variables.extend(overlay.into_iter().flatten().map(|(key, value)| (OsString::from(key), OsString::from(value))));

    variables
}

/// A program as the caller named it, and the file that will be run.
struct Program {
    /// What the command sees as `argv[0]`.
    original: String,
    path: CString,
}

/// Find the file to run for `program`. A name with a `/` is used as it is; any other is searched
/// for on the command's own `PATH`, as `execvp` does after the command's environment is set up.
fn resolve_program(program: &str, cwd: Option<&str>, environment: &[(OsString, OsString)]) -> io::Result<Program> {
    let path = if program.contains('/') {
        cstring(program)?
    } else {
        let search = environment
            .iter()
            .find(|(key, _)| key == "PATH")
            .map_or_else(|| OsString::from(DEFAULT_PATH), |(_, value)| value.clone());
        let mut denied = false;
        let mut found = None;

        for directory in std::env::split_paths(&search) {
            let directory = if directory.as_os_str().is_empty() { PathBuf::from(".") } else { directory };
            let candidate = directory.join(program);
            // A relative entry is relative to the command's directory, where `execvp` would run.
            let on_disk = match cwd {
                Some(cwd) if candidate.is_relative() => Path::new(cwd).join(&candidate),
                _ => candidate.clone(),
            };

            match std::fs::metadata(&on_disk) {
                Ok(metadata) if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 => {
                    found = Some(candidate);

                    break;
                }
                Ok(metadata) if metadata.is_file() => denied = true,
                _ => {}
            }
        }

        let candidate =
            found.ok_or_else(|| io::Error::from_raw_os_error(if denied { libc::EACCES } else { libc::ENOENT }))?;

        CString::new(OsString::from(candidate).into_vec())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "nul byte found in provided data"))?
    };

    Ok(Program { original: program.to_string(), path })
}

/// A pipe whose ends close on `exec` and are never fd 0, 1 or 2, so a `dup2` onto a standard
/// stream really replaces it. Returns `(read, write)`.
fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];

    // SAFETY: `fds` has room for the two descriptors `pipe` writes.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: both descriptors were just created and nothing else owns them.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };

    Ok((above_stdio(read)?, above_stdio(write)?))
}

fn set_nonblocking(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: `fd` is an open descriptor; the commands take an int.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };

    if flags == -1 || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }

    Ok(())
}

/// Mark `fd` close-on-exec; move it above the standard streams when it is one of them.
fn above_stdio(fd: OwnedFd) -> io::Result<OwnedFd> {
    let raw = fd.as_raw_fd();
    let command = if raw <= 2 { libc::F_DUPFD_CLOEXEC } else { libc::F_SETFD };
    let argument = if raw <= 2 { 3 } else { libc::FD_CLOEXEC };

    // SAFETY: `raw` is a descriptor this function owns; the commands take an int.
    let result = unsafe { libc::fcntl(raw, command, argument) };

    match result {
        -1 => Err(io::Error::last_os_error()),
        // SAFETY: `F_DUPFD_CLOEXEC` returned a new descriptor that nothing else owns.
        duplicate if raw <= 2 => Ok(unsafe { OwnedFd::from_raw_fd(duplicate) }),
        _ => Ok(fd),
    }
}

/// The file actions of one spawn: what the command's descriptors and directory are set to before it runs.
struct FileActions(libc::posix_spawn_file_actions_t);

impl FileActions {
    fn new() -> io::Result<Self> {
        let mut actions = MaybeUninit::uninit();

        // SAFETY: `init` fills the value in; it is only used after that succeeded.
        check(unsafe { libc::posix_spawn_file_actions_init(actions.as_mut_ptr()) })?;

        Ok(Self(unsafe { actions.assume_init() }))
    }

    fn as_ptr(&self) -> *const libc::posix_spawn_file_actions_t {
        &raw const self.0
    }

    fn dup2(&mut self, from: RawFd, onto: RawFd) -> io::Result<()> {
        // SAFETY: the actions are initialised; the descriptors are plain numbers.
        check(unsafe { libc::posix_spawn_file_actions_adddup2(&raw mut self.0, from, onto) })
    }

    fn open_null(&mut self, onto: RawFd) -> io::Result<()> {
        // SAFETY: the actions are initialised and the path is NUL-terminated.
        check(unsafe {
            libc::posix_spawn_file_actions_addopen(&raw mut self.0, onto, c"/dev/null".as_ptr(), libc::O_RDONLY, 0)
        })
    }

    fn chdir(&mut self, directory: &CString) -> io::Result<()> {
        let add = add_chdir().ok_or_else(|| io::Error::from_raw_os_error(libc::ENOSYS))?;

        // SAFETY: the actions are initialised and the path is NUL-terminated.
        check(unsafe { add(&raw mut self.0, directory.as_ptr()) })
    }
}

impl Drop for FileActions {
    fn drop(&mut self) {
        // SAFETY: initialised in `new` and not destroyed before.
        unsafe { libc::posix_spawn_file_actions_destroy(&raw mut self.0) };
    }
}

/// The attributes of one spawn: a session of its own, an empty signal mask, `SIGPIPE` at its default.
struct Attributes(libc::posix_spawnattr_t);

impl Attributes {
    fn new() -> io::Result<Self> {
        let mut attributes = MaybeUninit::uninit();

        // SAFETY: `init` fills the value in; it is only used after that succeeded.
        check(unsafe { libc::posix_spawnattr_init(attributes.as_mut_ptr()) })?;

        let mut attributes = Self(unsafe { attributes.assume_init() });
        let mut mask = MaybeUninit::<libc::sigset_t>::uninit();
        let mut defaults = MaybeUninit::<libc::sigset_t>::uninit();

        // SAFETY: the sets are initialised by `sigemptyset` before use; the attributes by `init`.
        unsafe {
            libc::sigemptyset(mask.as_mut_ptr());
            libc::sigemptyset(defaults.as_mut_ptr());
            libc::sigaddset(defaults.as_mut_ptr(), libc::SIGPIPE);

            check(libc::posix_spawnattr_setsigmask(&raw mut attributes.0, mask.as_ptr()))?;
            check(libc::posix_spawnattr_setsigdefault(&raw mut attributes.0, defaults.as_ptr()))?;
            check(libc::posix_spawnattr_setflags(
                &raw mut attributes.0,
                POSIX_SPAWN_SETSID
                    | libc::POSIX_SPAWN_SETSIGMASK as libc::c_short
                    | libc::POSIX_SPAWN_SETSIGDEF as libc::c_short,
            ))?;
        }

        Ok(attributes)
    }

    fn as_ptr(&self) -> *const libc::posix_spawnattr_t {
        &raw const self.0
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: initialised in `new` and not destroyed before.
        unsafe { libc::posix_spawnattr_destroy(&raw mut self.0) };
    }
}

/// The `posix_spawn` family returns an error number rather than setting `errno`.
fn check(code: libc::c_int) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}
