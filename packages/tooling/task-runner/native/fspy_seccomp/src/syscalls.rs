//! Syscall metadata + per-call decoders. Each handler maps one
//! seccomp notification to zero or more `FileAccess` entries.
//!
//! Per-arch syscall numbers baked in here (we used to delegate to
//! libseccomp's name resolver, but dropping the libseccomp-sys dep
//! to support musl/aarch64 cross-compile means we carry the table
//! ourselves now). Each `TrackedSyscall` records its name plus the
//! nr on each supported arch; `nr()` picks the one that matches the
//! current build target. Syscalls that don't exist on a given arch
//! (e.g. legacy `open`/`stat`/`unlink` on aarch64) are `None` there
//! and skipped at filter-install time.

use libc::seccomp_notif;

use crate::peer;
use crate::{AccessKind, FileAccess};

/// One row of the seccomp filter table. `name` is informational
/// only — used for dispatch in `classify` and for diagnostics.
#[derive(Debug, Clone, Copy)]
pub struct TrackedSyscall {
    pub name: &'static str,
    /// x86_64 syscall number (from `<asm/unistd_64.h>`).
    /// `None` means this syscall doesn't exist on x86_64.
    /// `dead_code` because only the field matching the build
    /// target's arch is read by `nr()`.
    #[allow(dead_code)]
    x86_64: Option<i32>,
    /// aarch64 syscall number (from `<asm/unistd.h>`).
    /// `None` means this syscall doesn't exist on aarch64.
    /// aarch64 dropped many legacy calls (open, stat, unlink, ...);
    /// their userspace shims call the *at variants instead.
    #[allow(dead_code)]
    aarch64: Option<i32>,
}

impl TrackedSyscall {
    /// Resolve the syscall number for the current build target.
    /// Returns `None` when the syscall isn't available on this arch.
    pub fn nr(&self) -> Option<i32> {
        #[cfg(target_arch = "x86_64")]
        return self.x86_64;
        #[cfg(target_arch = "aarch64")]
        return self.aarch64;
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        return None;
    }
}

/// Convenience for declaring a row with a single shared name and
/// per-arch numbers.
const fn s(name: &'static str, x86_64: Option<i32>, aarch64: Option<i32>) -> TrackedSyscall {
    TrackedSyscall { name, x86_64, aarch64 }
}

/// Per-arch numbers verified against:
/// - x86_64: `arch/x86/entry/syscalls/syscall_64.tbl`
/// - aarch64: `include/uapi/asm-generic/unistd.h`
static TRACKED: &[TrackedSyscall] = &[
    // Open / read funnel
    s("openat", Some(257), Some(56)),
    s("openat2", Some(437), Some(437)),
    s("open", Some(2), None), // legacy; aarch64 uses openat
    // Stat family
    s("stat", Some(4), None),
    s("lstat", Some(6), None),
    s("newfstatat", Some(262), Some(79)),
    s("statx", Some(332), Some(291)),
    s("access", Some(21), None),
    s("faccessat", Some(269), Some(48)),
    s("faccessat2", Some(439), Some(439)),
    // Directory enumeration
    s("getdents64", Some(217), Some(61)),
    // Symlinks
    s("readlink", Some(89), None),
    s("readlinkat", Some(267), Some(78)),
    // Writes — create / delete / rename / link
    s("unlink", Some(87), None),
    s("unlinkat", Some(263), Some(35)),
    s("rename", Some(82), None),
    s("renameat", Some(264), Some(38)),
    s("renameat2", Some(316), Some(276)),
    s("mkdir", Some(83), None),
    s("mkdirat", Some(258), Some(34)),
    s("rmdir", Some(84), None),
    s("symlink", Some(88), None),
    s("symlinkat", Some(266), Some(36)),
    s("link", Some(86), None),
    s("linkat", Some(265), Some(37)),
    // cwd shifts (no recorded access, but the supervisor needs
    // to see them so future arg resolution stays accurate)
    s("chdir", Some(80), Some(49)),
    s("fchdir", Some(81), Some(50)),
];

/// The full set we intercept.
pub fn tracked() -> &'static [TrackedSyscall] {
    TRACKED
}

/// Decode `openat`-style flags into the resulting access kind.
/// Bits per `<fcntl.h>` — any write-side bit promotes to `Write`.
pub fn openat_kind_from_flags(flags: u64) -> AccessKind {
    const O_WRONLY: u64 = 1;
    const O_RDWR: u64 = 2;
    const O_CREAT: u64 = 0o100;
    const O_TRUNC: u64 = 0o1000;

    let write_bits = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC;

    if flags & write_bits != 0 {
        AccessKind::Write
    } else {
        AccessKind::Read
    }
}

/// What one notification contributed to the trace.
#[derive(Debug, Default)]
pub struct Classified {
    pub accesses: Vec<FileAccess>,
    /// The tracked process made an access that could not be recorded
    /// because its arguments could not be read (`process_vm_readv` refused:
    /// non-dumpable process, Yama `ptrace_scope`, bad pointer, process gone).
    /// A trace with such a gap must not be trusted as a complete input set.
    pub incomplete: bool,
}

impl Classified {
    fn one(path: std::path::PathBuf, kind: AccessKind) -> Self {
        Self { accesses: vec![FileAccess { path, kind }], incomplete: false }
    }

    fn lost() -> Self {
        Self { accesses: Vec::new(), incomplete: true }
    }

    fn merge(mut self, other: Self) -> Self {
        self.accesses.extend(other.accesses);
        self.incomplete |= other.incomplete;
        self
    }
}

/// Map one seccomp notification to zero or more accesses. The
/// per-syscall arms handle their own arg layout; everything routes
/// through `peer::read_path` and `peer::resolve_at` for the actual
/// child-memory inspection.
///
/// Non-`*at` syscalls (`open`, `stat`, `unlink`, ...) take a
/// raw `*pathname` arg. We route them through `decode_direct`
/// which resolves via `resolve_at(pid, AT_FDCWD, &raw)` — same
/// path the `*at` variants get. Without this, `open("foo")`
/// would record `foo` while `openat(AT_FDCWD, "foo")` records
/// `/cwd/foo`, leaving downstream consumers with a mix of
/// relative and absolute paths for equivalent operations.
pub fn classify(notif: &seccomp_notif, pid: i32) -> Classified {
    // Map the notif's nr back to a TrackedSyscall by walking the
    // table. The table is small (~25 entries) and the dispatch
    // runs once per notification, so linear search is fine.
    let nr = notif.data.nr;
    let Some(entry) = tracked().iter().find(|s| s.nr() == Some(nr)) else {
        return Classified::default();
    };

    let args = &notif.data.args;

    match entry.name {
        // openat(dirfd, *pathname, flags, mode) — flags is arg2.
        "openat" => decode_at_with_flags(pid, args[0] as i32, args[1], args[2]),
        // openat2(dirfd, *pathname, *open_how, size) — arg2 is a
        // POINTER to `struct open_how { __u64 flags; ... }`, not the
        // flags themselves. Read the first u64 (flags) from the
        // child's address space; fall back to Read if the read fails
        // (a write misclassified as read is safer than treating a
        // random pointer's bits as a flag mask).
        "openat2" => {
            let (flags, flags_lost) = match peer::read_u64(pid, args[2]) {
                Ok(flags) => (flags, false),
                Err(_) => (0, true),
            };
            let mut classified = decode_at_with_flags(pid, args[0] as i32, args[1], flags);

            classified.incomplete |= flags_lost;
            classified
        }
        // (*pathname, flags, mode)
        "open" => decode_at_with_flags(pid, libc::AT_FDCWD, args[0], args[1]),
        // (*pathname, *statbuf)
        "stat" | "lstat" => decode_direct(pid, args[0], AccessKind::Stat),
        // (*pathname, mode)
        "access" => decode_direct(pid, args[0], AccessKind::Stat),
        // (dirfd, *pathname, *statbuf, flags)
        "newfstatat" => decode_at(pid, args[0] as i32, args[1], AccessKind::Stat),
        // (dirfd, *pathname, mode[, flags])
        "faccessat" | "faccessat2" => decode_at(pid, args[0] as i32, args[1], AccessKind::Stat),
        // (dirfd, *pathname, flags, mask, *buf)
        "statx" => decode_at(pid, args[0] as i32, args[1], AccessKind::Stat),
        // (fd, *dirp, count) — resolve from fd
        "getdents64" => decode_from_fd(pid, args[0] as i32, AccessKind::ReadDir),
        // (*pathname, *buf, bufsiz)
        "readlink" => decode_direct(pid, args[0], AccessKind::Read),
        // (dirfd, *pathname, *buf, bufsiz)
        "readlinkat" => decode_at(pid, args[0] as i32, args[1], AccessKind::Read),
        // (*pathname)
        "unlink" | "rmdir" => decode_direct(pid, args[0], AccessKind::Write),
        // (dirfd, *pathname, flags)
        "unlinkat" => decode_at(pid, args[0] as i32, args[1], AccessKind::Write),
        // (*pathname, mode)
        "mkdir" => decode_direct(pid, args[0], AccessKind::Write),
        // (dirfd, *pathname, mode)
        "mkdirat" => decode_at(pid, args[0] as i32, args[1], AccessKind::Write),
        // (*oldpath, *newpath) — emit both as writes
        "rename" | "link" => decode_pair_direct(pid, args[0], args[1], AccessKind::Write),
        // (olddir, *oldpath, newdir, *newpath[, flags])
        "renameat" | "renameat2" | "linkat" => decode_pair_at(pid, args[0] as i32, args[1], args[2] as i32, args[3]),
        // (*target, *linkpath) — target is symlink contents (not a
        // real fs path); only linkpath is the actual write.
        "symlink" => decode_direct(pid, args[1], AccessKind::Write),
        // (*target, dirfd, *linkpath)
        "symlinkat" => decode_at(pid, args[1] as i32, args[2], AccessKind::Write),
        // chdir / fchdir don't record an access today — they only
        // matter as cwd-cache invalidation triggers (future work).
        "chdir" | "fchdir" => Classified::default(),
        _ => Classified::default(),
    }
}

/// Non-`*at` syscall handler. Resolves the read path against the
/// child's cwd so callers see absolute paths consistently — see the
/// note at the top of `classify`.
fn decode_direct(pid: i32, addr: u64, kind: AccessKind) -> Classified {
    decode_at(pid, libc::AT_FDCWD, addr, kind)
}

fn decode_at(pid: i32, dirfd: i32, addr: u64, kind: AccessKind) -> Classified {
    match peer::read_path(pid, addr) {
        Ok(raw) => Classified::one(peer::resolve_at(pid, dirfd, &raw), kind),
        Err(_) => Classified::lost(),
    }
}

fn decode_at_with_flags(pid: i32, dirfd: i32, addr: u64, flags: u64) -> Classified {
    decode_at(pid, dirfd, addr, openat_kind_from_flags(flags))
}

fn decode_from_fd(pid: i32, fd: i32, kind: AccessKind) -> Classified {
    match peer::path_of_fd(pid, fd) {
        Ok(path) => Classified::one(path, kind),
        Err(_) => Classified::lost(),
    }
}

fn decode_pair_direct(pid: i32, a: u64, b: u64, kind: AccessKind) -> Classified {
    decode_direct(pid, a, kind).merge(decode_direct(pid, b, kind))
}

fn decode_pair_at(pid: i32, old_dirfd: i32, old_addr: u64, new_dirfd: i32, new_addr: u64) -> Classified {
    decode_at(pid, old_dirfd, old_addr, AccessKind::Write).merge(decode_at(pid, new_dirfd, new_addr, AccessKind::Write))
}

#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::path::Path;

    use super::*;

    /// A pid no process can have (above `PID_MAX_LIMIT`), so `process_vm_readv`
    /// and `/proc/<pid>/...` fail with `ESRCH` / `ENOENT`.
    const GONE_PID: i32 = i32::MAX;

    fn notif(syscall: &str, args: [u64; 6]) -> seccomp_notif {
        let nr = tracked()
            .iter()
            .find(|s| s.name == syscall)
            .and_then(TrackedSyscall::nr)
            .expect("syscall exists on this arch");
        let mut notif: seccomp_notif = unsafe { std::mem::zeroed() };

        notif.data.nr = nr;
        notif.data.args = args;
        notif
    }

    fn own_pid() -> i32 {
        std::process::id() as i32
    }

    fn ptr(c: &CString) -> u64 {
        c.as_ptr() as u64
    }

    #[test]
    fn a_readable_path_is_recorded_and_the_trace_stays_complete() {
        let path = CString::new("/etc/passwd").unwrap();
        let got = classify(&notif("openat", [libc::AT_FDCWD as u64, ptr(&path), 0, 0, 0, 0]), own_pid());

        assert!(!got.incomplete);
        assert_eq!(got.accesses.len(), 1);
        assert_eq!(got.accesses[0].path, Path::new("/etc/passwd"));
        assert_eq!(got.accesses[0].kind, AccessKind::Read);
    }

    #[test]
    fn an_unreadable_path_argument_marks_the_trace_incomplete() {
        // The target is gone / not dumpable / the pointer is bad: nothing can be recorded.
        let path = CString::new("/etc/passwd").unwrap();
        let got = classify(&notif("openat", [libc::AT_FDCWD as u64, ptr(&path), 0, 0, 0, 0]), GONE_PID);

        assert!(got.accesses.is_empty());
        assert!(got.incomplete, "a dropped access must be reported, not silently ignored");
    }

    #[test]
    fn a_bad_pointer_in_the_target_marks_the_trace_incomplete() {
        let got = classify(&notif("openat", [libc::AT_FDCWD as u64, 8, 0, 0, 0, 0]), own_pid());

        assert!(got.accesses.is_empty());
        assert!(got.incomplete);
    }

    #[test]
    fn an_unreadable_open_how_is_incomplete_even_though_the_path_is_recorded() {
        // openat2's flags live behind a pointer; if they cannot be read a write may be
        // recorded as a read, so the trace is flagged instead of trusted.
        let path = CString::new("/etc/passwd").unwrap();
        let got = classify(&notif("openat2", [libc::AT_FDCWD as u64, ptr(&path), 8, 24, 0, 0]), own_pid());

        assert_eq!(got.accesses.len(), 1);
        assert!(got.incomplete);
    }

    #[test]
    fn one_unreadable_path_of_a_pair_keeps_the_other_and_flags_the_trace() {
        let old = CString::new("/tmp/fspy-old").unwrap();
        let got =
            classify(&notif("renameat", [libc::AT_FDCWD as u64, ptr(&old), libc::AT_FDCWD as u64, 8, 0, 0]), own_pid());

        assert_eq!(got.accesses.len(), 1);
        assert_eq!(got.accesses[0].path, Path::new("/tmp/fspy-old"));
        assert!(got.incomplete);
    }

    #[test]
    fn an_unresolvable_directory_fd_marks_the_trace_incomplete() {
        let got = classify(&notif("getdents64", [1_000_000, 0, 0, 0, 0, 0]), own_pid());

        assert!(got.accesses.is_empty());
        assert!(got.incomplete);
    }

    #[test]
    fn a_syscall_that_records_nothing_is_not_incomplete() {
        let got = classify(&notif("chdir", [0; 6]), GONE_PID);

        assert!(got.accesses.is_empty());
        assert!(!got.incomplete);
    }
}
