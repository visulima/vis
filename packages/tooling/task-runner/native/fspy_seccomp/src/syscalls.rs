//! Syscall metadata + per-call decoders. Each handler maps one
//! seccomp notification to zero or more `FileAccess` entries.
//!
//! The syscall numbers come from `libc::SYS_*`, so the table holds the numbers
//! of the build target only. Syscalls that don't exist on a given arch (e.g.
//! legacy `open`/`stat`/`unlink` on aarch64) are left out there. The unit tests
//! pin every number to the kernel's table.

use libc::seccomp_notif;

use crate::peer;
use crate::{AccessKind, FileAccess};

/// One row of the seccomp filter table. `name` is informational
/// only — used for dispatch in `classify` and for diagnostics.
#[derive(Debug, Clone, Copy)]
pub struct TrackedSyscall {
    pub name: &'static str,
    /// The syscall number on the build target.
    nr: i32,
}

impl TrackedSyscall {
    /// The syscall number for the current build target. Always `Some`: a
    /// syscall the arch lacks has no row at all.
    pub fn nr(&self) -> Option<i32> {
        Some(self.nr)
    }
}

/// Declare a row from libc's constant for the build target.
const fn s(name: &'static str, nr: libc::c_long) -> TrackedSyscall {
    TrackedSyscall { name, nr: nr as i32 }
}

/// aarch64's `renameat` (see `include/uapi/asm-generic/unistd.h`). libc exports it
/// for musl but not for glibc, so the number is local here.
#[cfg(target_arch = "aarch64")]
const SYS_RENAMEAT: libc::c_long = 38;
#[cfg(target_arch = "x86_64")]
const SYS_RENAMEAT: libc::c_long = libc::SYS_renameat;

// Only x86_64 and aarch64 have a table (see `filter.rs`, which refuses to build
// elsewhere), and x32 (an x86_64 target whose libc numbers carry
// `__X32_SYSCALL_BIT`) is not supported.
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
static TRACKED: &[TrackedSyscall] = &[
    // Open / read funnel
    s("openat", libc::SYS_openat),
    s("openat2", libc::SYS_openat2),
    #[cfg(target_arch = "x86_64")] // legacy; aarch64 uses openat
    s("open", libc::SYS_open),
    // Stat family
    #[cfg(target_arch = "x86_64")]
    s("stat", libc::SYS_stat),
    #[cfg(target_arch = "x86_64")]
    s("lstat", libc::SYS_lstat),
    s("newfstatat", libc::SYS_newfstatat),
    s("statx", libc::SYS_statx),
    #[cfg(target_arch = "x86_64")]
    s("access", libc::SYS_access),
    s("faccessat", libc::SYS_faccessat),
    s("faccessat2", libc::SYS_faccessat2),
    // Directory enumeration
    s("getdents64", libc::SYS_getdents64),
    // Symlinks
    #[cfg(target_arch = "x86_64")]
    s("readlink", libc::SYS_readlink),
    s("readlinkat", libc::SYS_readlinkat),
    // Writes — create / delete / rename / link
    #[cfg(target_arch = "x86_64")]
    s("unlink", libc::SYS_unlink),
    s("unlinkat", libc::SYS_unlinkat),
    #[cfg(target_arch = "x86_64")]
    s("rename", libc::SYS_rename),
    s("renameat", SYS_RENAMEAT),
    s("renameat2", libc::SYS_renameat2),
    #[cfg(target_arch = "x86_64")]
    s("mkdir", libc::SYS_mkdir),
    s("mkdirat", libc::SYS_mkdirat),
    #[cfg(target_arch = "x86_64")]
    s("rmdir", libc::SYS_rmdir),
    #[cfg(target_arch = "x86_64")]
    s("symlink", libc::SYS_symlink),
    s("symlinkat", libc::SYS_symlinkat),
    #[cfg(target_arch = "x86_64")]
    s("link", libc::SYS_link),
    s("linkat", libc::SYS_linkat),
    // cwd shifts (no recorded access, but the supervisor needs
    // to see them so future arg resolution stays accurate)
    s("chdir", libc::SYS_chdir),
    s("fchdir", libc::SYS_fchdir),
];

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
static TRACKED: &[TrackedSyscall] = &[];

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
        // SAFETY: `seccomp_notif` is a plain-old-data C struct; all-zero is valid.
        let mut notif: seccomp_notif = unsafe { std::mem::zeroed() };

        notif.data.nr = nr;
        notif.data.args = args;
        notif
    }

    /// Pin one row to the kernel's number: the `const` assertion fails the build if
    /// libc's constant ever differs from the number in the kernel's syscall table
    /// (`arch/x86/entry/syscalls/syscall_64.tbl`, `include/uapi/asm-generic/unistd.h`),
    /// and the list feeds the test below.
    macro_rules! pinned {
        ($($name:literal => $sys:expr, $nr:literal;)*) => {
            $(const _: () = assert!($sys as i64 == $nr);)*

            const PINNED: &[(&str, i64)] = &[$(($name, $nr)),*];
        };
    }

    #[cfg(target_arch = "x86_64")]
    pinned! {
        "openat" => libc::SYS_openat, 257;
        "openat2" => libc::SYS_openat2, 437;
        "open" => libc::SYS_open, 2;
        "stat" => libc::SYS_stat, 4;
        "lstat" => libc::SYS_lstat, 6;
        "newfstatat" => libc::SYS_newfstatat, 262;
        "statx" => libc::SYS_statx, 332;
        "access" => libc::SYS_access, 21;
        "faccessat" => libc::SYS_faccessat, 269;
        "faccessat2" => libc::SYS_faccessat2, 439;
        "getdents64" => libc::SYS_getdents64, 217;
        "readlink" => libc::SYS_readlink, 89;
        "readlinkat" => libc::SYS_readlinkat, 267;
        "unlink" => libc::SYS_unlink, 87;
        "unlinkat" => libc::SYS_unlinkat, 263;
        "rename" => libc::SYS_rename, 82;
        "renameat" => libc::SYS_renameat, 264;
        "renameat2" => libc::SYS_renameat2, 316;
        "mkdir" => libc::SYS_mkdir, 83;
        "mkdirat" => libc::SYS_mkdirat, 258;
        "rmdir" => libc::SYS_rmdir, 84;
        "symlink" => libc::SYS_symlink, 88;
        "symlinkat" => libc::SYS_symlinkat, 266;
        "link" => libc::SYS_link, 86;
        "linkat" => libc::SYS_linkat, 265;
        "chdir" => libc::SYS_chdir, 80;
        "fchdir" => libc::SYS_fchdir, 81;
    }

    #[cfg(target_arch = "aarch64")]
    pinned! {
        "openat" => libc::SYS_openat, 56;
        "openat2" => libc::SYS_openat2, 437;
        "newfstatat" => libc::SYS_newfstatat, 79;
        "statx" => libc::SYS_statx, 291;
        "faccessat" => libc::SYS_faccessat, 48;
        "faccessat2" => libc::SYS_faccessat2, 439;
        "getdents64" => libc::SYS_getdents64, 61;
        "readlinkat" => libc::SYS_readlinkat, 78;
        "unlinkat" => libc::SYS_unlinkat, 35;
        "renameat" => super::SYS_RENAMEAT, 38;
        "renameat2" => libc::SYS_renameat2, 276;
        "mkdirat" => libc::SYS_mkdirat, 34;
        "symlinkat" => libc::SYS_symlinkat, 36;
        "linkat" => libc::SYS_linkat, 37;
        "chdir" => libc::SYS_chdir, 49;
        "fchdir" => libc::SYS_fchdir, 50;
    }

    #[test]
    fn the_table_holds_exactly_the_kernels_numbers_for_this_arch() {
        let mut table: Vec<(&str, i64)> =
            tracked().iter().map(|row| (row.name, i64::from(row.nr().expect("every row has a number")))).collect();
        let mut expected = PINNED.to_vec();

        table.sort_unstable();
        expected.sort_unstable();

        assert_eq!(table, expected);
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
