//! `fspy_macos` — a DYLD-interpose dylib that reports a tracked process's
//! file accesses back to the parent over an inherited `AF_UNIX`/`SOCK_DGRAM`
//! socket.
//!
//! ## How it attaches
//!
//! The parent ([`native/src/macos.rs`]) spawns the (PATH-resolved, **directly
//! exec'd** — never via `/bin/sh`, which macOS SIP would strip
//! `DYLD_INSERT_LIBRARIES` from) target binary with:
//!
//! - `DYLD_INSERT_LIBRARIES=<path to this .dylib>`
//! - `FSPY_MACOS_FD=<inherited socket fd>`
//!
//! dyld maps this dylib first and runs [`init`] (via `ctor`) before the
//! target's `main`. `init` adopts the socket fd. Every interposed libc call
//! forwards to the real implementation and then best-effort `send(2)`s one
//! datagram `[u8 mode][absolute path bytes]` to the parent (`mode` is
//! read/write/stat/readdir, or `missing` for a lookup that failed with `ENOENT`).
//!
//! ## `open`/`openat` are variadic
//!
//! `open(path, flags, ...)` takes its optional `mode` as a C variadic argument.
//! Defining a variadic Rust fn needs nightly (`feature(c_variadic)`), so each hook
//! is written with the fixed arity `(path, flags, mode)` and reads `mode` from
//! wherever the platform ABI puts it:
//!
//! - **x86_64** (SysV): variadic and fixed arguments share the argument
//!   registers, so the fixed-arity hook receives `mode` in `rdx` as is.
//! - **aarch64** (Apple): *every* variadic argument is passed on the stack, so a
//!   fixed-arity hook would read a leftover register instead. A two-instruction
//!   assembly trampoline (`fspy_open_variadic`, `fspy_openat_variadic`) loads the
//!   stack slot into the register the hook expects and tail-calls it; the
//!   interpose table points at the trampolines.
//!
//! The hook forwards `mode` to the real call only when `O_CREAT` is set.
//!
//! ## Why a dylib-local interpose call doesn't recurse
//!
//! A `__DATA,__interpose` tuple `{replacement, replacee}` makes dyld redirect
//! *other* images' calls to `replacee` into `replacement`. Inside the
//! interposing image, a call to the same symbol binds to the real
//! implementation — so `libc::open(..)` from within [`hook_open`] is the
//! genuine `open`, not a re-entry into the hook.

#![cfg(target_os = "macos")]
#![allow(clippy::missing_safety_doc)]

use core::ffi::{c_char, c_int, c_void};
use std::cell::Cell;
use std::sync::atomic::{AtomicI32, Ordering};

use libc::{size_t, ssize_t, DIR};

/// Wire opcodes — one byte prefix per datagram. Kept in sync with the parser
/// in `native/src/macos.rs`.
mod mode {
    pub const READ: u8 = 0;
    pub const WRITE: u8 = 1;
    pub const STAT: u8 = 2;
    pub const READDIR: u8 = 3;
    /// A lookup that failed with `ENOENT`: the path did not exist when probed.
    pub const MISSING: u8 = 4;
}

/// Env var carrying the inherited reporting socket fd. Set by the parent.
const FD_ENV: &[u8] = b"FSPY_MACOS_FD\0";

/// The reporting socket, adopted in [`init`]. `-1` means "not tracking" — every
/// hook then degrades to a plain forward with no reporting.
static REPORT_FD: AtomicI32 = AtomicI32::new(-1);

thread_local! {
    /// Guards against re-entrancy: if reporting (or anything it calls) were to
    /// trip another interposed function on the same thread we'd recurse. The
    /// hooks set this around their report so nested hooked calls are skipped.
    static IN_HOOK: Cell<bool> = const { Cell::new(false) };
}

/// dyld interpose tuple. `#[used]` + the `__DATA,__interpose` section is the
/// ABI dyld scans at load time.
#[repr(C)]
struct Interpose {
    replacement: *const c_void,
    replacee: *const c_void,
}

// SAFETY: the pointers are static fn addresses; the struct is only ever read by
// dyld. `Sync` is required to place it in a `static`.
unsafe impl Sync for Interpose {}

/// Adopt the inherited socket the moment dyld maps us, before the target's
/// `main`. Best-effort: any failure leaves `REPORT_FD == -1` (no tracking)
/// rather than disturbing the tracked process.
#[ctor::ctor(unsafe)]
fn init() {
    // SAFETY: `getenv` with a NUL-terminated key; we only read the returned C
    // string, never free it.
    let raw = unsafe { libc::getenv(FD_ENV.as_ptr().cast::<c_char>()) };

    if raw.is_null() {
        return;
    }

    let fd = unsafe { std::ffi::CStr::from_ptr(raw) }.to_str().ok().and_then(|s| s.parse::<c_int>().ok());

    let Some(fd) = fd else {
        return;
    };

    // The number can be stale: a descendant that closed its descriptors (or was
    // spawned without inheriting the socket) still sees `FSPY_MACOS_FD` in its
    // environment, and the number may by now belong to an unrelated file or
    // stream. Only adopt a unix-domain datagram socket; otherwise stay disabled
    // rather than write access records into someone else's descriptor.
    if fd < 0 || !is_report_socket(fd) {
        return;
    }

    // macOS has no `MSG_NOSIGNAL`; suppress SIGPIPE per-socket instead so a
    // parent that has gone away can never take the tracked process down.
    let on: c_int = 1;
    // SAFETY: standard setsockopt on an inherited socket fd.
    unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            std::ptr::addr_of!(on).cast::<c_void>(),
            std::mem::size_of::<c_int>() as libc::socklen_t,
        );
    }

    REPORT_FD.store(fd, Ordering::Relaxed);
}

/// True when `fd` is an `AF_UNIX`/`SOCK_DGRAM` socket — what the parent hands out.
fn is_report_socket(fd: c_int) -> bool {
    let mut kind: c_int = 0;
    let mut kind_len = std::mem::size_of::<c_int>() as libc::socklen_t;

    // SAFETY: `kind`/`kind_len` are valid out-parameters for SO_TYPE.
    let typed = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            std::ptr::addr_of_mut!(kind).cast::<c_void>(),
            &mut kind_len,
        )
    };

    if typed != 0 || kind != libc::SOCK_DGRAM {
        return false;
    }

    // SAFETY: an all-zero `sockaddr_storage` is a valid out-parameter for getsockname.
    let mut addr: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
    let mut addr_len = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;

    // SAFETY: `addr`/`addr_len` describe a writable sockaddr_storage.
    let named = unsafe { libc::getsockname(fd, std::ptr::addr_of_mut!(addr).cast::<libc::sockaddr>(), &mut addr_len) };

    named == 0 && c_int::from(addr.ss_family) == libc::AF_UNIX
}

/// Fill `buf` with the absolute form of `path`, returning its length: absolute
/// paths verbatim, relative ones joined to the directory `dirfd` refers to (or
/// the current directory for `AT_FDCWD`). The parent cannot do this itself — it
/// does not know the descriptor's directory or any `chdir` the process made.
/// When the base cannot be resolved the relative path is sent as is and the
/// parent falls back to joining it with the spawn directory.
unsafe fn absolute_path(path: *const c_char, dirfd: c_int, buf: &mut [u8]) -> usize {
    // SAFETY: `path` is a valid NUL-terminated C string from the caller.
    let path_len = unsafe { libc::strlen(path) };
    let relative = path_len > 0 && unsafe { *path } as u8 != b'/';
    let mut len = 0;

    if relative {
        let base = buf.as_mut_ptr().cast::<c_char>();

        // SAFETY: `buf` holds at least PATH_MAX bytes, which `getcwd` and
        // `F_GETPATH` both require.
        let resolved = unsafe {
            if dirfd == libc::AT_FDCWD {
                !libc::getcwd(base, buf.len()).is_null()
            } else {
                libc::fcntl(dirfd, libc::F_GETPATH, base) != -1
            }
        };

        if resolved {
            // SAFETY: both calls NUL-terminate on success.
            len = unsafe { libc::strlen(base) };

            // The root directory already ends in a separator.
            if len < buf.len() && buf[len - 1] != b'/' {
                buf[len] = b'/';
                len += 1;
            }
        }
    }

    let room = buf.len() - len;
    let copy = path_len.min(room);

    // SAFETY: copying `copy <= room` bytes from the C string into the buffer.
    unsafe { std::ptr::copy_nonoverlapping(path.cast::<u8>(), buf.as_mut_ptr().add(len), copy) };

    len + copy
}

/// Best-effort: send one `[mode][absolute path]` datagram. Never blocks
/// (`MSG_DONTWAIT`) and never errors out the caller — a full/closed socket just
/// drops the record. `dirfd` is the directory a relative `path` is resolved
/// against (`AT_FDCWD` for the plain, non-`*at` calls).
unsafe fn report(path: *const c_char, dirfd: c_int, mode: u8) {
    if path.is_null() {
        return;
    }

    let fd = REPORT_FD.load(Ordering::Relaxed);

    if fd < 0 {
        return;
    }

    // Re-entrancy guard: skip if we're already inside a hook on this thread.
    let entered = IN_HOOK.with(|flag| {
        if flag.get() {
            return false;
        }

        flag.set(true);

        true
    });

    if !entered {
        return;
    }

    // The hooks report right after the real call; the caller still has to see
    // that call's `errno`, not whatever `getcwd`/`send` left behind.
    let saved_errno = last_errno();

    // PATH_MAX (1024 on macOS) + 1 opcode byte. A path longer than this is
    // truncated for the wire; the parent treats it as a best-effort hint.
    const CAP: usize = 1 + 1024;
    let mut buf = [0u8; CAP];

    buf[0] = mode;

    // SAFETY: `path` is non-null and NUL-terminated; the buffer is PATH_MAX bytes.
    let len = unsafe { absolute_path(path, dirfd, &mut buf[1..]) };

    // SAFETY: send on the datagram socket; MSG_DONTWAIT keeps it non-blocking.
    unsafe {
        libc::send(fd, buf.as_ptr().cast::<c_void>(), len + 1, libc::MSG_DONTWAIT);
    }

    IN_HOOK.with(|flag| flag.set(false));

    // SAFETY: `__error` returns this thread's errno slot.
    unsafe { *libc::__error() = saved_errno };
}

/// The calling thread's `errno`.
fn last_errno() -> c_int {
    // SAFETY: `__error` returns this thread's errno slot.
    unsafe { *libc::__error() }
}

/// For a lookup that just failed: report the path as `missing` when the failure
/// was `ENOENT`, so a later appearance of the path invalidates a fingerprint
/// that probed it. Other failures (`EACCES`, `ENOTDIR`, …) are not reported.
unsafe fn report_if_missing(path: *const c_char, dirfd: c_int) {
    if last_errno() == libc::ENOENT {
        unsafe { report(path, dirfd, mode::MISSING) };
    }
}

/// `open(path, flags[, mode])` → classify by access flags.
#[inline]
fn open_mode(flags: c_int) -> u8 {
    if flags & (libc::O_WRONLY | libc::O_RDWR | libc::O_CREAT | libc::O_TRUNC | libc::O_APPEND) != 0 {
        mode::WRITE
    } else {
        mode::READ
    }
}

// ---- hooks -----------------------------------------------------------------
//
// Each hook forwards to the real libc function (resolved within this image, so
// not re-interposed) and reports on success, or as `missing` when a lookup
// failed with `ENOENT`. `extern "C"` + fixed arity.

/// `open(path, flags[, mode])`. `mode` is only meaningful (and only forwarded)
/// with `O_CREAT`; see the module docs for how it reaches this fn on each arch.
unsafe extern "C" fn hook_open(path: *const c_char, flags: c_int, mode: c_int) -> c_int {
    let fd = if flags & libc::O_CREAT != 0 {
        unsafe { libc::open(path, flags, mode) }
    } else {
        unsafe { libc::open(path, flags) }
    };

    if fd >= 0 {
        unsafe { report(path, libc::AT_FDCWD, open_mode(flags)) };
    } else if flags & libc::O_CREAT == 0 {
        // A failed create says nothing about the path's prior state (the parent
        // directory may be what is missing).
        unsafe { report_if_missing(path, libc::AT_FDCWD) };
    }

    fd
}

unsafe extern "C" fn hook_openat(dirfd: c_int, path: *const c_char, flags: c_int, mode: c_int) -> c_int {
    let fd = if flags & libc::O_CREAT != 0 {
        unsafe { libc::openat(dirfd, path, flags, mode) }
    } else {
        unsafe { libc::openat(dirfd, path, flags) }
    };

    if fd >= 0 {
        unsafe { report(path, dirfd, open_mode(flags)) };
    } else if flags & libc::O_CREAT == 0 {
        unsafe { report_if_missing(path, dirfd) };
    }

    fd
}

unsafe extern "C" fn hook_stat(path: *const c_char, buf: *mut libc::stat) -> c_int {
    let rc = unsafe { libc::stat(path, buf) };

    if rc == 0 {
        unsafe { report(path, libc::AT_FDCWD, mode::STAT) };
    } else {
        unsafe { report_if_missing(path, libc::AT_FDCWD) };
    }

    rc
}

unsafe extern "C" fn hook_lstat(path: *const c_char, buf: *mut libc::stat) -> c_int {
    let rc = unsafe { libc::lstat(path, buf) };

    if rc == 0 {
        unsafe { report(path, libc::AT_FDCWD, mode::STAT) };
    } else {
        unsafe { report_if_missing(path, libc::AT_FDCWD) };
    }

    rc
}

unsafe extern "C" fn hook_access(path: *const c_char, amode: c_int) -> c_int {
    let rc = unsafe { libc::access(path, amode) };

    if rc == 0 {
        unsafe { report(path, libc::AT_FDCWD, mode::STAT) };
    } else {
        unsafe { report_if_missing(path, libc::AT_FDCWD) };
    }

    rc
}

unsafe extern "C" fn hook_opendir(path: *const c_char) -> *mut DIR {
    let dir = unsafe { libc::opendir(path) };

    if !dir.is_null() {
        unsafe { report(path, libc::AT_FDCWD, mode::READDIR) };
    } else {
        unsafe { report_if_missing(path, libc::AT_FDCWD) };
    }

    dir
}

unsafe extern "C" fn hook_rename(old: *const c_char, new: *const c_char) -> c_int {
    let rc = unsafe { libc::rename(old, new) };

    if rc == 0 {
        unsafe { report(old, libc::AT_FDCWD, mode::WRITE) };
        unsafe { report(new, libc::AT_FDCWD, mode::WRITE) };
    }

    rc
}

unsafe extern "C" fn hook_mkdir(path: *const c_char, mode: libc::mode_t) -> c_int {
    let rc = unsafe { libc::mkdir(path, mode) };

    if rc == 0 {
        unsafe { report(path, libc::AT_FDCWD, mode::WRITE) };
    }

    rc
}

unsafe extern "C" fn hook_unlink(path: *const c_char) -> c_int {
    let rc = unsafe { libc::unlink(path) };

    if rc == 0 {
        unsafe { report(path, libc::AT_FDCWD, mode::WRITE) };
    }

    rc
}

// `read`/`write` are NOT hooked — we classify at `open` time, which is enough
// for cache fingerprinting and keeps the hot path (every byte of I/O) clean.

// ---- child-process propagation ---------------------------------------------
//
// `DYLD_INSERT_LIBRARIES` + `FSPY_MACOS_FD` are inherited by children through
// the environment automatically — *except* when a child is launched with a
// curated `envp` that omits them (Node's `posix_spawn`, build tools that scrub
// the environment, …). These hooks re-inject our two vars into such an `envp`
// so tracking follows the whole process tree. (A `/bin/sh`-style SIP binary in
// the chain still strips `DYLD_*`; that's inherent to SIP and unavoidable.)

/// Keys we propagate into a child's environment. Values are read from our own
/// environment at call time, so we forward exactly what we were started with.
const DYLD_KEY: &[u8] = b"DYLD_INSERT_LIBRARIES\0";

/// Owns the backing storage for a rebuilt `envp` so the pointers stay valid
/// for the duration of the `exec`/`posix_spawn` call. Inner pointers are
/// `*mut c_char` to match libc's `posix_spawn` ABI (`*const *mut c_char`);
/// `execve` (which wants `*const *const c_char`) casts the array at the call.
struct EnvCopy {
    // Kept alive; the pointer array below borrows from these.
    _owned: Vec<std::ffi::CString>,
    ptrs: Vec<*mut c_char>,
}

impl EnvCopy {
    fn as_ptr(&self) -> *const *mut c_char {
        self.ptrs.as_ptr()
    }
}

/// Build a NUL-terminated `envp` that contains the caller's entries plus any of
/// our propagation keys (`DYLD_INSERT_LIBRARIES`, `FSPY_MACOS_FD`) that were
/// missing, taking their values from our own environment. Returns `None` when
/// `envp` is null (the child then inherits our `environ`, which already carries
/// the vars) so the caller forwards the original pointer untouched.
unsafe fn rebuild_envp(envp: *const *const c_char) -> Option<EnvCopy> {
    if envp.is_null() {
        return None;
    }

    let mut owned: Vec<std::ffi::CString> = Vec::new();
    let mut ptrs: Vec<*mut c_char> = Vec::new();
    let mut have_dyld = false;
    let mut have_fd = false;

    // Copy the caller's entries verbatim, noting whether our keys are present.
    let mut i = 0isize;
    loop {
        let entry = unsafe { *envp.offset(i) };
        if entry.is_null() {
            break;
        }
        if unsafe { env_key_matches(entry, b"DYLD_INSERT_LIBRARIES=") } {
            have_dyld = true;
        } else if unsafe { env_key_matches(entry, b"FSPY_MACOS_FD=") } {
            have_fd = true;
        }
        ptrs.push(entry as *mut c_char);
        i += 1;
    }

    if have_dyld && have_fd {
        return None; // nothing to add — forward the original envp.
    }

    if !have_dyld {
        if let Some(entry) = unsafe { our_env_entry(DYLD_KEY, "DYLD_INSERT_LIBRARIES") } {
            ptrs.push(entry.as_ptr() as *mut c_char);
            owned.push(entry);
        }
    }
    if !have_fd {
        if let Some(entry) = unsafe { our_env_entry(FD_ENV, "FSPY_MACOS_FD") } {
            ptrs.push(entry.as_ptr() as *mut c_char);
            owned.push(entry);
        }
    }

    ptrs.push(std::ptr::null_mut());

    Some(EnvCopy { _owned: owned, ptrs })
}

/// True when the `KEY=` prefix of `entry` equals `prefix` (which includes `=`).
unsafe fn env_key_matches(entry: *const c_char, prefix: &[u8]) -> bool {
    let bytes = entry.cast::<u8>();
    for (i, &p) in prefix.iter().enumerate() {
        if unsafe { *bytes.add(i) } != p {
            return false;
        }
    }
    true
}

/// `"KEY=<our value>"` as a `CString`, or `None` when we don't carry the var.
unsafe fn our_env_entry(key_nul: &[u8], key: &str) -> Option<std::ffi::CString> {
    let raw = unsafe { libc::getenv(key_nul.as_ptr().cast::<c_char>()) };
    if raw.is_null() {
        return None;
    }
    let value = unsafe { std::ffi::CStr::from_ptr(raw) }.to_str().ok()?;
    std::ffi::CString::new(format!("{key}={value}")).ok()
}

unsafe extern "C" fn hook_execve(path: *const c_char, argv: *const *const c_char, envp: *const *const c_char) -> c_int {
    match unsafe { rebuild_envp(envp) } {
        // execve wants `*const *const c_char`; our storage is `*const *mut`.
        Some(copy) => unsafe { libc::execve(path, argv, copy.as_ptr() as *const *const c_char) },
        None => unsafe { libc::execve(path, argv, envp) },
    }
}

extern "C" {
    // Not exported by the `libc` crate. Marks `fd` as inherited by a child spawned
    // with `POSIX_SPAWN_CLOEXEC_DEFAULT` (which closes every descriptor that file
    // actions do not name).
    fn posix_spawn_file_actions_addinherit_np(file_actions: *mut libc::posix_spawn_file_actions_t, fd: c_int) -> c_int;
}

/// Runs `spawn` with file actions that keep the report socket open in the child.
///
/// libuv (Node's `child_process`, so vitest's fork pool and `vite` -> `esbuild`)
/// spawns with `POSIX_SPAWN_CLOEXEC_DEFAULT`; without an explicit inherit action
/// the child loses the socket and its accesses never reach the parent. The
/// caller's file actions are extended in place when given; otherwise a temporary
/// set is created and destroyed around the call.
unsafe fn with_inherited_report_fd(
    file_actions: *const libc::posix_spawn_file_actions_t,
    spawn: impl FnOnce(*const libc::posix_spawn_file_actions_t) -> c_int,
) -> c_int {
    let fd = REPORT_FD.load(Ordering::Relaxed);

    if fd < 0 {
        return spawn(file_actions);
    }

    if !file_actions.is_null() {
        // SAFETY: `file_actions` points at an initialised object the caller owns.
        unsafe { posix_spawn_file_actions_addinherit_np(file_actions.cast_mut(), fd) };

        return spawn(file_actions);
    }

    let mut own: libc::posix_spawn_file_actions_t = std::ptr::null_mut();

    // SAFETY: `own` is a valid out-parameter; it is destroyed below once initialised.
    if unsafe { libc::posix_spawn_file_actions_init(&mut own) } != 0 {
        return spawn(file_actions);
    }

    // SAFETY: `own` was initialised just above.
    unsafe { posix_spawn_file_actions_addinherit_np(&mut own, fd) };

    let rc = spawn(&own);

    // SAFETY: `own` was initialised and the spawn call has returned.
    unsafe { libc::posix_spawn_file_actions_destroy(&mut own) };

    rc
}

unsafe extern "C" fn hook_posix_spawn(
    pid: *mut libc::pid_t,
    path: *const c_char,
    file_actions: *const libc::posix_spawn_file_actions_t,
    attrp: *const libc::posix_spawnattr_t,
    argv: *const *mut c_char,
    envp: *const *mut c_char,
) -> c_int {
    // The kernel copies `envp` during the call, so dropping the rebuilt storage
    // when this returns is safe.
    let rebuilt = unsafe { rebuild_envp(envp as *const *const c_char) };
    let envp = rebuilt.as_ref().map_or(envp, EnvCopy::as_ptr);

    unsafe {
        with_inherited_report_fd(file_actions, |actions| libc::posix_spawn(pid, path, actions, attrp, argv, envp))
    }
}

unsafe extern "C" fn hook_posix_spawnp(
    pid: *mut libc::pid_t,
    path: *const c_char,
    file_actions: *const libc::posix_spawn_file_actions_t,
    attrp: *const libc::posix_spawnattr_t,
    argv: *const *mut c_char,
    envp: *const *mut c_char,
) -> c_int {
    let rebuilt = unsafe { rebuild_envp(envp as *const *const c_char) };
    let envp = rebuilt.as_ref().map_or(envp, EnvCopy::as_ptr);

    unsafe {
        with_inherited_report_fd(file_actions, |actions| libc::posix_spawnp(pid, path, actions, attrp, argv, envp))
    }
}

// Apple arm64 passes every variadic argument on the stack, so `open`'s `mode`
// is at `[sp]` (`openat`'s too) while a fixed-arity hook would read it from a
// register. These trampolines load the slot into the register the hook expects
// and tail-call it (stack and link register untouched).
#[cfg(target_arch = "aarch64")]
core::arch::global_asm!(
    ".text",
    ".p2align 2",
    ".globl _fspy_open_variadic",
    "_fspy_open_variadic:",
    "ldr w2, [sp]",
    "b {open}",
    ".globl _fspy_openat_variadic",
    "_fspy_openat_variadic:",
    "ldr w3, [sp]",
    "b {openat}",
    open = sym hook_open,
    openat = sym hook_openat,
);

#[cfg(target_arch = "aarch64")]
extern "C" {
    fn fspy_open_variadic();
    fn fspy_openat_variadic();
}

#[cfg(target_arch = "aarch64")]
const OPEN_REPLACEMENT: unsafe extern "C" fn() = fspy_open_variadic;
#[cfg(target_arch = "aarch64")]
const OPENAT_REPLACEMENT: unsafe extern "C" fn() = fspy_openat_variadic;
#[cfg(not(target_arch = "aarch64"))]
const OPEN_REPLACEMENT: unsafe extern "C" fn(*const c_char, c_int, c_int) -> c_int = hook_open;
#[cfg(not(target_arch = "aarch64"))]
const OPENAT_REPLACEMENT: unsafe extern "C" fn(c_int, *const c_char, c_int, c_int) -> c_int = hook_openat;

macro_rules! interpose {
    ($static_name:ident, $replacement:expr, $replacee:expr) => {
        #[used]
        #[link_section = "__DATA,__interpose"]
        static $static_name: Interpose =
            Interpose { replacement: $replacement as *const c_void, replacee: $replacee as *const c_void };
    };
}

interpose!(I_OPEN, OPEN_REPLACEMENT, libc::open);
interpose!(I_OPENAT, OPENAT_REPLACEMENT, libc::openat);
interpose!(I_STAT, hook_stat, libc::stat);
interpose!(I_LSTAT, hook_lstat, libc::lstat);
interpose!(I_ACCESS, hook_access, libc::access);
interpose!(I_OPENDIR, hook_opendir, libc::opendir);
interpose!(I_RENAME, hook_rename, libc::rename);
interpose!(I_UNLINK, hook_unlink, libc::unlink);
interpose!(I_MKDIR, hook_mkdir, libc::mkdir);
// Child-process propagation: re-inject DYLD_INSERT_LIBRARIES + FSPY_MACOS_FD
// into curated child environments so tracking follows the whole tree.
interpose!(I_EXECVE, hook_execve, libc::execve);
interpose!(I_POSIX_SPAWN, hook_posix_spawn, libc::posix_spawn);
interpose!(I_POSIX_SPAWNP, hook_posix_spawnp, libc::posix_spawnp);

// Silence "unused" for the libc imports only referenced through interpose
// type-checking on some toolchains.
#[allow(dead_code)]
fn _type_anchors(_: size_t, _: ssize_t) {}
