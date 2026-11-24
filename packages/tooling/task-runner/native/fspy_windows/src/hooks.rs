//! Name-based IAT hooking for the Win32 file-API surface.
//!
//! We walk **every loaded module's** import table and, for every imported
//! function whose name matches one we care about, swap the IAT pointer to our
//! hook. The original each hook forwards to is resolved once, up front, with
//! `GetProcAddress` on `kernelbase`/`kernel32` — the real function, never a
//! thunk read out of some module's IAT — and `kernel32`, `kernelbase` and
//! `ntdll` themselves are never patched, so a hook can't be reached again
//! through the very function it calls. Walking all modules (not just the main exe)
//! catches file calls made from other DLLs — the CRT, addon `.node`s, etc.
//! Matching by **function name across all import
//! descriptors** (not by DLL name) means API-set forwarders
//! (`api-ms-win-core-file-l1-1-0.dll` etc.) are handled the same as a direct
//! `kernel32.dll` import. Pointer-swapping (vs inline patching) is
//! arch-independent, so the same code covers x64 and ARM64.
//!
//! Each hook tail-calls the original and reports the path over the pipe.

#![cfg(windows)]
#![allow(non_snake_case)]

// 64-bit only: the IAT walk uses the *64 PE structures (IMAGE_NT_HEADERS64,
// IMAGE_THUNK_DATA64, IMAGE_ORDINAL_FLAG64). Both shipped Windows targets
// (x86_64, aarch64) are 64-bit — fail fast rather than miscompile if a 32-bit
// target is ever added.
#[cfg(not(target_pointer_width = "64"))]
compile_error!("fspy_windows: only 64-bit Windows targets are supported (the IAT walk uses IMAGE_*64 structures)");

use core::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};

use windows_sys::Win32::Foundation::{HANDLE, HMODULE};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Memory::{VirtualProtect, PAGE_PROTECTION_FLAGS, PAGE_READWRITE};
use windows_sys::Win32::System::ProcessStatus::EnumProcessModules;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use crate::mode;
use crate::path::normalize_win;
use crate::pe;
use crate::pipe;

// Original function pointers, stored as usize. Each is resolved (and stored) by
// `resolve_originals` before any IAT slot is patched, so a hook that is reachable
// always sees a non-null original. Loaded + transmuted in the hooks.
static ORIG_CREATE_FILE_W: AtomicUsize = AtomicUsize::new(0);
static ORIG_CREATE_FILE_A: AtomicUsize = AtomicUsize::new(0);
static ORIG_DELETE_FILE_W: AtomicUsize = AtomicUsize::new(0);
static ORIG_GET_FILE_ATTRS_EX_W: AtomicUsize = AtomicUsize::new(0);
static ORIG_GET_FILE_ATTRS_W: AtomicUsize = AtomicUsize::new(0);
static ORIG_FIND_FIRST_FILE_W: AtomicUsize = AtomicUsize::new(0);
static ORIG_FIND_FIRST_FILE_EX_W: AtomicUsize = AtomicUsize::new(0);
static ORIG_MOVE_FILE_EX_W: AtomicUsize = AtomicUsize::new(0);

/// Our own DLL's base address — skipped when walking modules so we never hook
/// our own pipe-IPC file calls (avoids self-reporting + re-entrancy).
static SELF_BASE: AtomicUsize = AtomicUsize::new(0);

/// Record this DLL's module base so [`install_all`] can skip it. Called from
/// `DllMain` with the `hinstDLL` the loader passes.
pub fn set_self_base(base: usize) {
    SELF_BASE.store(base, Ordering::Relaxed);
}

type CreateFileWFn = unsafe extern "system" fn(*const u16, u32, u32, *const c_void, u32, u32, HANDLE) -> HANDLE;
type CreateFileAFn = unsafe extern "system" fn(*const u8, u32, u32, *const c_void, u32, u32, HANDLE) -> HANDLE;
type DeleteFileWFn = unsafe extern "system" fn(*const u16) -> i32;
type GetFileAttrsExWFn = unsafe extern "system" fn(*const u16, i32, *mut c_void) -> i32;
type GetFileAttrsWFn = unsafe extern "system" fn(*const u16) -> u32;
type FindFirstFileWFn = unsafe extern "system" fn(*const u16, *mut c_void) -> HANDLE;
type FindFirstFileExWFn = unsafe extern "system" fn(*const u16, i32, *mut c_void, i32, *const c_void, u32) -> HANDLE;
type MoveFileExWFn = unsafe extern "system" fn(*const u16, *const u16, u32) -> i32;

// Win32 access flags implying write intent.
const GENERIC_WRITE: u32 = 0x4000_0000;
const FILE_WRITE_DATA: u32 = 0x0002;
const FILE_APPEND_DATA: u32 = 0x0004;

fn classify(access: u32) -> u8 {
    if access & (GENERIC_WRITE | FILE_WRITE_DATA | FILE_APPEND_DATA) != 0 {
        mode::WRITE
    } else {
        mode::READ
    }
}

/// Run reporting code so a panic can never unwind out of a hook. The hooks are
/// `extern "system"` functions called from arbitrary host code; unwinding across
/// that boundary aborts the host process. The crate keeps the default
/// `panic = "unwind"` (see `Cargo.toml`), which is what makes this effective —
/// `panic = "abort"` would turn the same panic into an immediate host crash.
fn guarded(f: impl FnOnce()) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
}

fn report_w(path: *const u16, kind: u8) {
    if path.is_null() {
        return;
    }

    guarded(|| {
        // Read the NUL-terminated UTF-16 string.
        let mut len = 0usize;
        unsafe {
            while *path.add(len) != 0 {
                len += 1;
            }
        }
        let slice = unsafe { std::slice::from_raw_parts(path, len) };
        let s = String::from_utf16_lossy(slice);

        pipe::send(kind, &normalize_win(&s));
    });
}

fn report_a(path: *const u8, kind: u8) {
    if path.is_null() {
        return;
    }

    guarded(|| {
        let mut len = 0usize;
        unsafe {
            while *path.add(len) != 0 {
                len += 1;
            }
        }
        let slice = unsafe { std::slice::from_raw_parts(path, len) };
        let s = String::from_utf8_lossy(slice).into_owned();

        pipe::send(kind, &normalize_win(&s));
    });
}

unsafe extern "system" fn hook_CreateFileW(
    name: *const u16,
    access: u32,
    share: u32,
    sa: *const c_void,
    disposition: u32,
    flags: u32,
    template: HANDLE,
) -> HANDLE {
    let orig: CreateFileWFn = std::mem::transmute(ORIG_CREATE_FILE_W.load(Ordering::Acquire));
    let result = orig(name, access, share, sa, disposition, flags, template);
    report_w(name, classify(access));
    result
}

unsafe extern "system" fn hook_CreateFileA(
    name: *const u8,
    access: u32,
    share: u32,
    sa: *const c_void,
    disposition: u32,
    flags: u32,
    template: HANDLE,
) -> HANDLE {
    let orig: CreateFileAFn = std::mem::transmute(ORIG_CREATE_FILE_A.load(Ordering::Acquire));
    let result = orig(name, access, share, sa, disposition, flags, template);
    report_a(name, classify(access));
    result
}

unsafe extern "system" fn hook_DeleteFileW(name: *const u16) -> i32 {
    let orig: DeleteFileWFn = std::mem::transmute(ORIG_DELETE_FILE_W.load(Ordering::Acquire));
    let result = orig(name);
    report_w(name, mode::WRITE);
    result
}

unsafe extern "system" fn hook_GetFileAttributesExW(name: *const u16, level: i32, info: *mut c_void) -> i32 {
    let orig: GetFileAttrsExWFn = std::mem::transmute(ORIG_GET_FILE_ATTRS_EX_W.load(Ordering::Acquire));
    let result = orig(name, level, info);
    report_w(name, mode::STAT);
    result
}

unsafe extern "system" fn hook_GetFileAttributesW(name: *const u16) -> u32 {
    let orig: GetFileAttrsWFn = std::mem::transmute(ORIG_GET_FILE_ATTRS_W.load(Ordering::Acquire));
    let result = orig(name);
    report_w(name, mode::STAT);
    result
}

unsafe extern "system" fn hook_FindFirstFileW(name: *const u16, data: *mut c_void) -> HANDLE {
    let orig: FindFirstFileWFn = std::mem::transmute(ORIG_FIND_FIRST_FILE_W.load(Ordering::Acquire));
    let result = orig(name, data);
    report_w(name, mode::READDIR);
    result
}

unsafe extern "system" fn hook_FindFirstFileExW(
    name: *const u16,
    level: i32,
    data: *mut c_void,
    search_op: i32,
    filter: *const c_void,
    flags: u32,
) -> HANDLE {
    let orig: FindFirstFileExWFn = std::mem::transmute(ORIG_FIND_FIRST_FILE_EX_W.load(Ordering::Acquire));
    let result = orig(name, level, data, search_op, filter, flags);
    report_w(name, mode::READDIR);
    result
}

unsafe extern "system" fn hook_MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32 {
    let orig: MoveFileExWFn = std::mem::transmute(ORIG_MOVE_FILE_EX_W.load(Ordering::Acquire));
    let result = orig(existing, new, flags);
    // Both source and destination are mutated; `new` may be null (a pure delete
    // via MOVEFILE flags), which `report_w` ignores.
    report_w(existing, mode::WRITE);
    report_w(new, mode::WRITE);
    result
}

/// One (imported-name, hook, original-slot) row in the hook table.
struct HookEntry {
    name: &'static [u8],
    hook: *const c_void,
    orig: &'static AtomicUsize,
}

// SAFETY: only static fn pointers + static refs; read-only after init.
unsafe impl Sync for HookEntry {}

fn table() -> [HookEntry; 8] {
    [
        HookEntry { name: b"CreateFileW", hook: hook_CreateFileW as *const c_void, orig: &ORIG_CREATE_FILE_W },
        HookEntry { name: b"CreateFileA", hook: hook_CreateFileA as *const c_void, orig: &ORIG_CREATE_FILE_A },
        HookEntry { name: b"DeleteFileW", hook: hook_DeleteFileW as *const c_void, orig: &ORIG_DELETE_FILE_W },
        HookEntry {
            name: b"GetFileAttributesExW",
            hook: hook_GetFileAttributesExW as *const c_void,
            orig: &ORIG_GET_FILE_ATTRS_EX_W,
        },
        HookEntry {
            name: b"GetFileAttributesW",
            hook: hook_GetFileAttributesW as *const c_void,
            orig: &ORIG_GET_FILE_ATTRS_W,
        },
        HookEntry {
            name: b"FindFirstFileW",
            hook: hook_FindFirstFileW as *const c_void,
            orig: &ORIG_FIND_FIRST_FILE_W,
        },
        HookEntry {
            name: b"FindFirstFileExW",
            hook: hook_FindFirstFileExW as *const c_void,
            orig: &ORIG_FIND_FIRST_FILE_EX_W,
        },
        HookEntry { name: b"MoveFileExW", hook: hook_MoveFileExW as *const c_void, orig: &ORIG_MOVE_FILE_EX_W },
    ]
}

/// Resolve the real function behind every table entry and publish it for the
/// hooks. `kernelbase` is where these APIs live on Windows 8+; `kernel32` covers
/// older systems. Returns the entries that resolved — an entry without an
/// original is left unpatched rather than hooked with nothing to forward to.
fn resolve_originals(entries: &[HookEntry]) -> Vec<&HookEntry> {
    let kernelbase = unsafe { GetModuleHandleA(c"kernelbase.dll".as_ptr().cast()) };
    let kernel32 = unsafe { GetModuleHandleA(c"kernel32.dll".as_ptr().cast()) };

    entries
        .iter()
        .filter(|entry| {
            let Ok(name) = std::ffi::CString::new(entry.name) else {
                return false;
            };

            let resolved = [kernelbase, kernel32]
                .into_iter()
                .filter(|module| !module.is_null())
                .find_map(|module| unsafe { GetProcAddress(module, name.as_ptr().cast()) });

            match resolved {
                Some(function) => {
                    entry.orig.store(function as usize, Ordering::Release);
                    true
                }
                None => false,
            }
        })
        .collect()
}

/// Patch one module's IAT for every entry in `entries`. Returns the number of
/// IAT slots swapped in this module.
fn install_in_module(base: *const u8, entries: &[&HookEntry]) -> usize {
    if base.is_null() {
        return 0;
    }

    // SAFETY: `base` is a module handle from the loader, so its first page — the
    // DOS/NT headers — is mapped.
    let headers = unsafe { std::slice::from_raw_parts(base, HEADER_PROBE) };
    let Some(size) = pe::image_size(headers).filter(|&size| size >= HEADER_PROBE) else {
        return 0;
    };

    // SAFETY: the image stays mapped for the duration of the call (the module is
    // loaded and we hold no reference past it). Pages that are not committed are
    // never touched: `named_imports` only reads the import directory, name table
    // and names, each bounds-checked against this slice.
    let image = unsafe { std::slice::from_raw_parts(base, size) };

    let mut hooked = 0;

    for import in pe::named_imports(image) {
        let Some(entry) = entries.iter().find(|entry| entry.name == import.name) else {
            continue;
        };

        // SAFETY: `named_imports` only returns slots that lie wholly inside the image.
        let cell = unsafe { base.add(import.iat_offset) }.cast_mut().cast::<c_void>();

        if patch_slot(cell, entry.hook) {
            hooked += 1;
        }
    }

    hooked
}

/// Point one IAT slot at `hook`, restoring its page protection afterwards.
/// `entry.orig` is already published by [`resolve_originals`], so the hook is
/// fully usable the moment the slot is written.
fn patch_slot(cell: *mut c_void, hook: *const c_void) -> bool {
    let mut old: PAGE_PROTECTION_FLAGS = 0;

    unsafe {
        if VirtualProtect(cell, std::mem::size_of::<usize>(), PAGE_READWRITE, &mut old) == 0 {
            return false;
        }

        cell.cast::<usize>().write_unaligned(hook as usize);

        let mut restore: PAGE_PROTECTION_FLAGS = 0;
        VirtualProtect(cell, std::mem::size_of::<usize>(), old, &mut restore);
    }

    true
}

/// Bytes read from a module base to find `SizeOfImage`; the headers always fit
/// in the first page.
const HEADER_PROBE: usize = 0x1000;

/// Handles of the modules whose own IATs must stay untouched: they implement the
/// functions we forward to, so patching their imports can route a hook's call to
/// the original straight back into the hook.
fn system_modules() -> Vec<usize> {
    [c"kernel32.dll", c"kernelbase.dll", c"ntdll.dll"]
        .iter()
        .map(|name| unsafe { GetModuleHandleA(name.as_ptr().cast()) } as usize)
        .filter(|&handle| handle != 0)
        .collect()
}

/// Every module currently loaded in the process, falling back to just the main
/// executable if enumeration fails.
fn loaded_modules() -> Vec<HMODULE> {
    unsafe {
        let process = GetCurrentProcess();

        // First call sizes the module array; second fills it.
        let mut needed: u32 = 0;
        let sized = EnumProcessModules(process, std::ptr::null_mut(), 0, &mut needed) != 0 && needed != 0;

        if sized {
            let count = needed as usize / std::mem::size_of::<HMODULE>();
            let mut modules: Vec<HMODULE> = vec![std::ptr::null_mut(); count];
            let mut written: u32 = 0;

            if EnumProcessModules(process, modules.as_mut_ptr(), needed, &mut written) != 0 {
                modules.truncate((written as usize / std::mem::size_of::<HMODULE>()).min(count));

                return modules;
            }
        }

        vec![GetModuleHandleW(std::ptr::null())]
    }
}

/// Install hooks across **every** currently-loaded module's IAT — not just the
/// main executable — so file calls made from other DLLs (the CRT, addon
/// `.node`s, etc.) are caught too. Our own DLL and the system modules in
/// [`system_modules`] are skipped. Returns the total slots swapped.
pub fn install_all() -> usize {
    let self_base = SELF_BASE.load(Ordering::Relaxed);
    let skipped = system_modules();

    let entries = table();
    let entries = resolve_originals(&entries);

    loaded_modules()
        .into_iter()
        .filter(|&module| !module.is_null() && module as usize != self_base && !skipped.contains(&(module as usize)))
        .map(|module| install_in_module(module as *const u8, &entries))
        .sum()
}
