//! Pure-Rust seccomp filter installer. Hand-rolls a BPF program
//! that returns `SECCOMP_RET_USER_NOTIF` for the syscalls we want
//! to observe and `SECCOMP_RET_ALLOW` for everything else, then
//! loads it via raw `seccomp(2)` with `SECCOMP_FILTER_FLAG_NEW_LISTENER`.
//!
//! Why no `libseccomp-sys`: that crate dynamically links the
//! system libseccomp, which doesn't cross-compile into musl /
//! aarch64 sysroots without bespoke CI setup. Rolling our own BPF
//! takes ~80 lines and works on every Linux target with no C
//! dependency.
//!
//! BPF program shape (`x32` row only on x86_64):
//!
//! ```text
//! ld [arch]                  // seccomp_data.arch (32 bits)
//! jeq <native_arch>, 0, notify
//! ld [nr]                    // seccomp_data.nr (32 bits)
//! jset <x32_bit>, notify, 0  // x32 syscalls share the x86_64 audit arch
//! for each tracked syscall:
//!     jeq <nr>, notify, 0
//! ret ALLOW
//! notify:
//! ret USER_NOTIF
//! ```
//!
//! A syscall of a foreign ABI (an i386 binary on x86_64, an AArch32 binary
//! on aarch64, an x32 syscall) cannot be decoded with this table: its
//! numbers mean different calls. It is neither killed nor silently allowed;
//! it is sent to the supervisor like a tracked syscall, which lets it run
//! and marks the whole trace incomplete (see [`is_native_call`]) so the
//! cache does not trust it. The cost is one supervisor round trip per
//! syscall of such a process.

use std::io;
use std::os::raw::c_long;
use std::os::unix::io::RawFd;

use libc::{
    c_uint, seccomp_data, sock_filter, sock_fprog, syscall, SYS_seccomp, BPF_ABS, BPF_JEQ, BPF_JMP, BPF_JSET, BPF_K,
    BPF_LD, BPF_RET, BPF_W, SECCOMP_FILTER_FLAG_NEW_LISTENER, SECCOMP_RET_ALLOW, SECCOMP_RET_USER_NOTIF,
    SECCOMP_SET_MODE_FILTER,
};

use crate::syscalls::TrackedSyscall;

/// `AUDIT_ARCH_*` values, from `<linux/audit.h>`: the ELF machine number
/// (`EM_*`, which libc exports) OR-ed with the width and endianness flags.
/// libc has no `AUDIT_ARCH_*` itself.
const AUDIT_ARCH_64BIT: u32 = 0x8000_0000; // __AUDIT_ARCH_64BIT
const AUDIT_ARCH_LE: u32 = 0x4000_0000; // __AUDIT_ARCH_LE

pub(crate) const AUDIT_ARCH_X86_64: u32 = libc::EM_X86_64 as u32 | AUDIT_ARCH_64BIT | AUDIT_ARCH_LE;
pub(crate) const AUDIT_ARCH_AARCH64: u32 = libc::EM_AARCH64 as u32 | AUDIT_ARCH_64BIT | AUDIT_ARCH_LE;
/// Foreign ABIs a 64-bit kernel can still run: only the tests name them, to
/// check they are not mistaken for the native one.
#[cfg(test)]
pub(crate) const AUDIT_ARCH_I386: u32 = libc::EM_386 as u32 | AUDIT_ARCH_LE;
#[cfg(test)]
pub(crate) const AUDIT_ARCH_ARM: u32 = libc::EM_ARM as u32 | AUDIT_ARCH_LE;

/// `__X32_SYSCALL_BIT` from `<asm/unistd.h>`: set in `seccomp_data.nr` by an x32
/// syscall, which shares the x86_64 audit arch. libc exports it only for the x32
/// target.
pub(crate) const X32_SYSCALL_BIT: u32 = 0x4000_0000;

/// Only arches that ALSO have a populated syscall-number table in
/// `syscalls.rs` are listed — otherwise the filter would build a no-op tracker
/// (every syscall resolves to `None`, so nothing is intercepted). A new arch
/// needs BOTH a constant above and its numbers in `syscalls.rs`.
/// The syscall ABI a filter is built for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Abi {
    /// `AUDIT_ARCH_*` of the ABI whose syscall numbers the table holds.
    pub audit_arch: c_uint,
    /// Bit set in `seccomp_data.nr` by a syscall of a second ABI that shares
    /// `audit_arch` (`__X32_SYSCALL_BIT` on x86_64); `None` when there is none.
    pub alias_bit: Option<c_uint>,
}

impl Abi {
    pub const X86_64: Self = Self { audit_arch: AUDIT_ARCH_X86_64, alias_bit: Some(X32_SYSCALL_BIT) };
    pub const AARCH64: Self = Self { audit_arch: AUDIT_ARCH_AARCH64, alias_bit: None };
}

#[cfg(target_arch = "x86_64")]
pub const NATIVE_ABI: Abi = Abi::X86_64;

#[cfg(target_arch = "aarch64")]
pub const NATIVE_ABI: Abi = Abi::AARCH64;

// Gate unsupported arches at compile time rather than shipping a
// silent no-op. riscv64 has an AUDIT_ARCH (0xc000_00f3) but no
// syscall table yet — add the numbers to `syscalls.rs::TRACKED`
// and a const above before enabling it.
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!(
    "fspy_seccomp: unsupported target_arch — only x86_64 and aarch64 \
     have syscall tables. Populate syscalls.rs::TRACKED and add an \
     AUDIT_ARCH constant in filter.rs before building this target."
);

/// Build and install a seccomp filter that traps the given
/// syscalls for user-notify and allows everything else. Returns
/// the kernel-issued listener fd that the parent supervisor will
/// read notifications from.
///
/// MUST be called from the post-fork pre-exec window (or otherwise
/// the future child) — the kernel installs the filter on the
/// *calling* thread, and the notify fd lives in *its* fd table.
///
/// # Safety
///
/// Wraps raw `seccomp(2)`. Caller must ensure
/// `prctl(PR_SET_NO_NEW_PRIVS, 1, ...)` succeeded earlier in the
/// same thread, or `seccomp(2)` returns `EACCES` for a non-root
/// process.
pub unsafe fn install(tracked: &[TrackedSyscall]) -> io::Result<RawFd> {
    let numbers: Vec<i32> = tracked.iter().filter_map(TrackedSyscall::nr).collect();
    let prog = build_program(NATIVE_ABI, &numbers)?;
    let fprog = sock_fprog {
        len: u16::try_from(prog.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "BPF program exceeds 65535 instructions"))?,
        filter: prog.as_ptr() as *mut sock_filter,
    };

    // `seccomp(2)` with `SECCOMP_FILTER_FLAG_NEW_LISTENER` returns
    // the listener fd on success. Cast via `c_long`/`as i32` so
    // we preserve negative fds for error mapping.
    //
    // SAFETY: `fprog` points at `prog`, which is alive and unmoved until the
    // call returns (the kernel copies the program), and `len` is its length.
    // The caller guarantees `PR_SET_NO_NEW_PRIVS` (see this fn's contract).
    let rc = unsafe {
        syscall(
            SYS_seccomp,
            SECCOMP_SET_MODE_FILTER as c_long,
            SECCOMP_FILTER_FLAG_NEW_LISTENER as c_long,
            &fprog as *const _,
        )
    };

    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(rc as RawFd)
}

/// Whether a trapped syscall belongs to the ABI the syscall table was built
/// for. `false` for a foreign architecture and for the x32 alias: their
/// numbers mean different syscalls, so [`crate::syscalls::classify`] must not
/// decode them. Mirrors the checks the BPF program makes.
pub fn is_native_call(abi: Abi, arch: u32, nr: i32) -> bool {
    arch == abi.audit_arch && abi.alias_bit.is_none_or(|bit| nr as u32 & bit == 0)
}

fn insn(code: c_uint, jt: u8, jf: u8, k: u32) -> sock_filter {
    sock_filter { code: code as u16, jt, jf, k }
}

/// Relative offset of a BPF jump from instruction `from` to instruction `to`
/// (`to` is executed after skipping `to - from - 1` instructions). The
/// offset field is 8 bits, so a longer jump cannot be encoded.
fn jump(from: usize, to: usize) -> io::Result<u8> {
    let skip = to
        .checked_sub(from + 1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "BPF jumps only go forward"))?;

    u8::try_from(skip).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("BPF jump of {skip} instructions exceeds 255: too many tracked syscalls"),
        )
    })
}

/// Which branch of a conditional jump leaves for the notify return.
#[derive(Clone, Copy)]
enum Branch {
    /// `jt`: the condition held.
    Taken,
    /// `jf`: the condition did not hold.
    NotTaken,
}

/// Construct the BPF program for `abi` and the given syscall numbers: the arch
/// check, the alias-ABI check (x32), one `jeq` per syscall and the two final
/// returns (allow, notify). Fails when a jump cannot be encoded.
///
/// No offset is counted by hand: each jump to the notify return is recorded as
/// it is pushed and patched once the notify return's position is known, and
/// [`validate_program`] re-checks the result in debug builds.
pub(crate) fn build_program(abi: Abi, syscall_numbers: &[i32]) -> io::Result<Vec<sock_filter>> {
    // Field offsets in `struct seccomp_data` — stable kernel ABI:
    //   nr        : offset 0  (i32)
    //   arch      : offset 4  (u32)
    //   ip        : offset 8  (u64)
    //   args[6]   : offset 16 (u64 each)
    let arch_offset = std::mem::offset_of!(seccomp_data, arch) as u32;
    let nr_offset = std::mem::offset_of!(seccomp_data, nr) as u32;

    let load = BPF_LD | BPF_W | BPF_ABS;
    let jeq = BPF_JMP | BPF_JEQ | BPF_K;
    let ret = BPF_RET | BPF_K;

    let mut prog: Vec<sock_filter> = Vec::with_capacity(syscall_numbers.len() + 6);
    // Instructions whose `jt` or `jf` must end up at the notify return.
    let mut to_notify: Vec<(usize, Branch)> = Vec::new();

    // Load seccomp_data.arch.
    prog.push(insn(load, 0, 0, arch_offset));
    // Native arch: go on to the syscall number; any other arch: notify, so the
    // supervisor can flag the trace as incomplete.
    to_notify.push((prog.len(), Branch::NotTaken));
    prog.push(insn(jeq, 0, 0, abi.audit_arch));
    // Load seccomp_data.nr.
    prog.push(insn(load, 0, 0, nr_offset));
    // The alias ABI (x32) shares the arch value: notify on its marker bit.
    if let Some(bit) = abi.alias_bit {
        to_notify.push((prog.len(), Branch::Taken));
        prog.push(insn(BPF_JMP | BPF_JSET | BPF_K, 0, 0, bit));
    }
    // One jeq per tracked syscall, jumping to the notify return.
    for nr in syscall_numbers {
        to_notify.push((prog.len(), Branch::Taken));
        prog.push(insn(jeq, 0, 0, *nr as u32));
    }
    // Default action: allow.
    prog.push(insn(ret, 0, 0, SECCOMP_RET_ALLOW));
    // Notify target.
    let notify_at = prog.len();
    prog.push(insn(ret, 0, 0, SECCOMP_RET_USER_NOTIF));

    for (at, branch) in to_notify {
        let offset = jump(at, notify_at)?;

        match branch {
            Branch::Taken => prog[at].jt = offset,
            Branch::NotTaken => prog[at].jf = offset,
        }
    }

    debug_assert_eq!(validate_program(&prog), Ok(()), "the BPF program built by build_program is malformed");

    Ok(prog)
}

/// Check the structural invariants of a program [`build_program`] produces:
///
/// - it ends in `ret ALLOW` followed by `ret USER_NOTIF`, so no path runs off
///   the end and the fall-through of the last test is the allow;
/// - every instruction is one the program is allowed to use;
/// - every jump that leaves the straight-line path (a non-zero offset) stays
///   inside the program and lands on the final `ret USER_NOTIF`: a miscounted
///   offset would otherwise land on another test, or on the allow return, and
///   silently let a tracked syscall through.
pub(crate) fn validate_program(prog: &[sock_filter]) -> Result<(), String> {
    let n = prog.len();

    let [.., allow, notify] = prog else {
        return Err(format!("a program needs at least the two final returns, has {n} instructions"));
    };

    let ret = BPF_RET | BPF_K;

    if u32::from(allow.code) != ret || allow.k != SECCOMP_RET_ALLOW {
        return Err("the second-to-last instruction must be `ret ALLOW`".into());
    }
    if u32::from(notify.code) != ret || notify.k != SECCOMP_RET_USER_NOTIF {
        return Err("the last instruction must be `ret USER_NOTIF`".into());
    }

    let notify_at = n - 1;

    for (at, i) in prog.iter().enumerate() {
        let code = u32::from(i.code);

        if code == BPF_LD | BPF_W | BPF_ABS || code == ret {
            continue;
        }
        if code != BPF_JMP | BPF_JEQ | BPF_K && code != BPF_JMP | BPF_JSET | BPF_K {
            return Err(format!("instruction {at}: unexpected opcode {code:#x}"));
        }

        for (name, offset) in [("jt", i.jt), ("jf", i.jf)] {
            if offset == 0 {
                continue;
            }

            let target = at + 1 + usize::from(offset);

            if target >= n {
                return Err(format!("instruction {at}: {name} jumps to {target}, past the end ({n} instructions)"));
            }
            if target != notify_at {
                return Err(format!(
                    "instruction {at}: {name} lands on {target}, not on the notify return ({notify_at})"
                ));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syscalls;

    const X32_BIT: i32 = X32_SYSCALL_BIT as i32;

    /// Evaluates the subset of classic BPF the program uses (`ld abs`, `jeq`,
    /// `jset`, `ret`) against a `seccomp_data` with the given arch and nr, so
    /// the tests check what the kernel would decide rather than the layout.
    fn evaluate(prog: &[sock_filter], arch: u32, nr: i32) -> u32 {
        let arch_offset = std::mem::offset_of!(seccomp_data, arch) as u32;
        let nr_offset = std::mem::offset_of!(seccomp_data, nr) as u32;
        let mut acc = 0_u32;
        let mut pc = 0_usize;

        loop {
            let i = &prog[pc];
            pc += 1;

            match u32::from(i.code) {
                c if c == BPF_LD | BPF_W | BPF_ABS => {
                    acc = if i.k == arch_offset {
                        arch
                    } else if i.k == nr_offset {
                        nr as u32
                    } else {
                        panic!("load of unexpected seccomp_data offset {}", i.k)
                    };
                }
                c if c == BPF_JMP | BPF_JEQ | BPF_K => pc += usize::from(if acc == i.k { i.jt } else { i.jf }),
                c if c == BPF_JMP | BPF_JSET | BPF_K => pc += usize::from(if acc & i.k != 0 { i.jt } else { i.jf }),
                c if c == BPF_RET | BPF_K => return i.k,
                c => panic!("unexpected BPF opcode {c:#x}"),
            }
        }
    }

    const NOTIFY: u32 = SECCOMP_RET_USER_NOTIF;
    const ALLOW: u32 = SECCOMP_RET_ALLOW;

    #[test]
    fn native_tracked_syscalls_notify_and_others_are_allowed() {
        for abi in [Abi::X86_64, Abi::AARCH64] {
            let prog = build_program(abi, &[2, 257, 437]).unwrap();

            for nr in [2, 257, 437] {
                assert_eq!(evaluate(&prog, abi.audit_arch, nr), NOTIFY, "{abi:?} nr {nr}");
            }
            for nr in [0, 1, 3, 256, 258, 436, 438, 1000] {
                assert_eq!(evaluate(&prog, abi.audit_arch, nr), ALLOW, "{abi:?} nr {nr}");
            }
        }
    }

    #[test]
    fn foreign_arch_is_notified_not_killed_or_allowed() {
        // i386 `open` is nr 5 and x86_64 `read` is 0. A foreign-ABI child must neither die
        // with SIGSYS (KILL_THREAD) nor run unobserved (ALLOW).
        for abi in [Abi::X86_64, Abi::AARCH64] {
            let prog = build_program(abi, &[2, 257]).unwrap();

            for arch in [AUDIT_ARCH_I386, AUDIT_ARCH_ARM, 0] {
                for nr in [0, 2, 5, 257, 1000] {
                    assert_eq!(evaluate(&prog, arch, nr), NOTIFY, "{abi:?} arch {arch:#x} nr {nr}");
                }
            }
        }
    }

    #[test]
    fn the_other_native_arch_counts_as_foreign() {
        let prog = build_program(Abi::X86_64, &[2]).unwrap();

        assert_eq!(evaluate(&prog, Abi::AARCH64.audit_arch, 56), NOTIFY);
    }

    #[test]
    fn x32_syscalls_are_notified_on_x86_64_only() {
        let prog = build_program(Abi::X86_64, &[2, 257]).unwrap();

        // Same audit arch, number | __X32_SYSCALL_BIT: would otherwise slip past the jeq list.
        for nr in [0, 2, 257, 1000] {
            assert_eq!(evaluate(&prog, Abi::X86_64.audit_arch, nr | X32_BIT), NOTIFY, "x32 nr {nr}");
        }

        // aarch64 has no alias ABI: the program has no such branch.
        let prog = build_program(Abi::AARCH64, &[56]).unwrap();

        assert_eq!(evaluate(&prog, Abi::AARCH64.audit_arch, 1000), ALLOW);
    }

    #[test]
    fn is_native_call_agrees_with_the_program() {
        for abi in [Abi::X86_64, Abi::AARCH64] {
            let prog = build_program(abi, &[2, 257]).unwrap();

            for arch in
                [abi.audit_arch, AUDIT_ARCH_I386, AUDIT_ARCH_ARM, Abi::X86_64.audit_arch, Abi::AARCH64.audit_arch]
            {
                for nr in [0, 2, 5, 257, 1000, 2 | X32_BIT, 1000 | X32_BIT] {
                    let native = is_native_call(abi, arch, nr);
                    let decision = evaluate(&prog, arch, nr);

                    // A call the supervisor will not decode must reach it: foreign => notify.
                    if !native {
                        assert_eq!(decision, NOTIFY, "{abi:?} arch {arch:#x} nr {nr:#x}");
                    }
                }
            }

            assert!(is_native_call(abi, abi.audit_arch, 257));
            assert!(!is_native_call(abi, AUDIT_ARCH_I386, 5));
        }

        assert!(!is_native_call(Abi::X86_64, Abi::X86_64.audit_arch, 257 | X32_BIT));
    }

    /// Longest syscall list whose farthest jump (the arch check) still fits in 8 bits.
    fn max_syscalls(abi: Abi) -> usize {
        255 - 2 - usize::from(abi.alias_bit.is_some())
    }

    #[test]
    fn the_largest_encodable_list_builds_and_still_decides_correctly() {
        for abi in [Abi::X86_64, Abi::AARCH64] {
            let n = max_syscalls(abi);
            let numbers: Vec<i32> = (1..=n as i32).collect();
            let prog = build_program(abi, &numbers).unwrap();

            // First, middle and last entries all reach the notify return.
            for nr in [1, n as i32 / 2, n as i32] {
                assert_eq!(evaluate(&prog, abi.audit_arch, nr), NOTIFY, "{abi:?} nr {nr}");
            }
            assert_eq!(evaluate(&prog, abi.audit_arch, n as i32 + 1), ALLOW);
            assert_eq!(evaluate(&prog, AUDIT_ARCH_I386, 1), NOTIFY);
        }
    }

    #[test]
    fn a_list_that_needs_a_jump_past_255_is_an_error_not_a_clamped_jump() {
        for abi in [Abi::X86_64, Abi::AARCH64] {
            let numbers: Vec<i32> = (1..=max_syscalls(abi) as i32 + 1).collect();
            let err = build_program(abi, &numbers).unwrap_err();

            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{abi:?}");
            assert!(err.to_string().contains("exceeds 255"), "{err}");
        }
    }

    #[test]
    fn the_real_table_traps_every_tracked_syscall_on_this_arch() {
        let numbers: Vec<i32> = syscalls::tracked().iter().filter_map(TrackedSyscall::nr).collect();
        let prog = build_program(NATIVE_ABI, &numbers).unwrap();

        assert!(!numbers.is_empty());
        for nr in &numbers {
            assert_eq!(evaluate(&prog, NATIVE_ABI.audit_arch, *nr), NOTIFY, "nr {nr}");
        }
    }

    #[test]
    fn the_audit_arch_values_match_linux_audit_h() {
        // <linux/audit.h>: EM_* | __AUDIT_ARCH_64BIT (0x80000000) | __AUDIT_ARCH_LE (0x40000000).
        assert_eq!(AUDIT_ARCH_X86_64, 0xc000_003e);
        assert_eq!(AUDIT_ARCH_AARCH64, 0xc000_00b7);
        assert_eq!(AUDIT_ARCH_I386, 0x4000_0003);
        assert_eq!(AUDIT_ARCH_ARM, 0x4000_0028);
        assert_eq!(X32_SYSCALL_BIT, 0x4000_0000);
    }

    #[test]
    fn built_programs_pass_the_structural_validation() {
        for abi in [Abi::X86_64, Abi::AARCH64] {
            for numbers in [vec![], vec![2], vec![2, 257, 437], (1..=max_syscalls(abi) as i32).collect()] {
                let prog = build_program(abi, &numbers).unwrap();

                assert_eq!(validate_program(&prog), Ok(()), "{abi:?} with {} syscalls", numbers.len());
            }
        }

        let numbers: Vec<i32> = syscalls::tracked().iter().filter_map(TrackedSyscall::nr).collect();

        assert_eq!(validate_program(&build_program(NATIVE_ABI, &numbers).unwrap()), Ok(()));
    }

    #[test]
    fn every_jump_lands_on_the_notify_return_and_the_layout_is_as_documented() {
        for abi in [Abi::X86_64, Abi::AARCH64] {
            let numbers = [2, 257, 437];
            let prog = build_program(abi, &numbers).unwrap();
            let alias = usize::from(abi.alias_bit.is_some());
            let notify_at = prog.len() - 1;

            // arch load, arch jeq, nr load, [alias jset], one jeq per syscall, allow, notify.
            assert_eq!(prog.len(), 3 + alias + numbers.len() + 2, "{abi:?}");
            assert_eq!(prog[notify_at].k, SECCOMP_RET_USER_NOTIF);
            assert_eq!(prog[notify_at - 1].k, SECCOMP_RET_ALLOW);

            for (at, i) in prog.iter().enumerate() {
                for offset in [i.jt, i.jf].into_iter().filter(|&o| o != 0) {
                    assert_eq!(at + 1 + usize::from(offset), notify_at, "{abi:?} instruction {at}");
                }
            }
        }
    }

    #[test]
    fn validation_rejects_a_jump_that_lands_on_the_wrong_instruction() {
        let mut prog = build_program(Abi::X86_64, &[2, 257, 437]).unwrap();
        let first_jeq = 4;

        // One short: lands on the allow return, so syscall 2 would run unobserved.
        prog[first_jeq].jt -= 1;

        let err = validate_program(&prog).unwrap_err();

        assert!(err.contains("not on the notify return"), "{err}");
    }

    #[test]
    fn validation_rejects_a_jump_past_the_end() {
        let mut prog = build_program(Abi::AARCH64, &[56]).unwrap();

        prog[1].jf += 1;

        let err = validate_program(&prog).unwrap_err();

        assert!(err.contains("past the end"), "{err}");
    }

    #[test]
    fn validation_rejects_a_program_that_does_not_end_in_allow_then_notify() {
        let good = build_program(Abi::AARCH64, &[56]).unwrap();

        assert!(validate_program(&[]).is_err());
        assert!(validate_program(&good[..1]).is_err());

        let mut swapped = good.clone();
        let n = swapped.len();
        swapped.swap(n - 2, n - 1);

        assert!(validate_program(&swapped).unwrap_err().contains("ret ALLOW"));

        let mut open_ended = good.clone();
        open_ended.pop();

        assert!(validate_program(&open_ended).is_err());
    }

    #[test]
    fn validation_rejects_an_opcode_the_program_never_uses() {
        let mut prog = build_program(Abi::AARCH64, &[56]).unwrap();

        prog[0].code = (BPF_JMP | BPF_JSET | BPF_K | 0x08) as u16;

        assert!(validate_program(&prog).unwrap_err().contains("unexpected opcode"));
    }

    #[test]
    fn a_backward_jump_cannot_be_encoded() {
        assert!(jump(5, 5).is_err());
        assert!(jump(5, 3).is_err());
        assert_eq!(jump(5, 6).unwrap(), 0);
        assert_eq!(jump(0, 256).unwrap(), 255);
        assert!(jump(0, 257).is_err());
    }
}
