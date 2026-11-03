// Per-file reader that feeds the detector directly, avoiding an intermediate
// `String` copy for mmap'd files that are already valid UTF-8.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use crate::archive::{self, ArchiveOptions};
use crate::decode::{scan_text_with_decoding, DecodeOptions};
use crate::detector::RawFinding;
use crate::rules::CompiledRuleset;

/// Everything the detector does for one unit of text: plain scan, decode pass, then the
/// composite-rule pass. Shared by files, archive entries and `scanTextSync`.
pub fn scan_text_full(ruleset: &CompiledRuleset, path: &Path, content: &str, decode: DecodeOptions) -> Vec<RawFinding> {
    crate::composite::apply(ruleset, scan_text_with_decoding(ruleset, path, content, decode))
}

const MMAP_THRESHOLD: u64 = 1 << 20; // 1 MiB
const BINARY_SNIFF_LEN: usize = 8192;

/// Read `path` and run the detector against its contents.
/// Returns `Ok(None)` if the file exceeds `max_bytes` (skipped).
/// With `archive.max_depth > 0`, zip / tar / gzip content (by magic bytes) is opened and
/// its entries scanned. Otherwise binary files (null byte in first 8 KiB) are skipped to
/// an empty Vec.
pub fn scan_file(
    path: &Path,
    ruleset: &CompiledRuleset,
    max_bytes: u64,
    decode: DecodeOptions,
    archive: ArchiveOptions,
) -> io::Result<Option<Vec<RawFinding>>> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    if size == 0 {
        return Ok(Some(Vec::new()));
    }
    if size > max_bytes {
        return Ok(None);
    }

    let mut file = File::open(path)?;

    if size >= MMAP_THRESHOLD {
        // SAFETY: another process truncating the file mid-scan would raise SIGBUS
        // for this thread. We accept that rare risk to keep the zero-copy path.
        if let Ok(map) = unsafe { memmap2::Mmap::map(&file) } {
            return Ok(Some(scan_bytes(path, ruleset, &map, decode, archive)));
        }
    }

    // Size already bounded by the max_bytes check above — casting to usize is safe in practice
    // (max_bytes defaults to 10 MiB, caller can raise it but NAPI caps it at u32::MAX).
    let capacity = usize::try_from(size).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    file.read_to_end(&mut bytes)?;
    if archive.max_depth == 0 || archive::detect(&bytes).is_none() {
        // Plain path: take ownership of the buffer to avoid a copy for valid UTF-8.
        if is_binary(&bytes) {
            return Ok(Some(Vec::new()));
        }
        return Ok(Some(match String::from_utf8(bytes) {
            Ok(s) => scan_text_full(ruleset, path, &s, decode),
            Err(e) => {
                let (cow, _, _) = encoding_rs::UTF_8.decode(e.as_bytes());
                scan_text_full(ruleset, path, &cow, decode)
            }
        }));
    }
    Ok(Some(scan_bytes(path, ruleset, &bytes, decode, archive)))
}

fn scan_bytes(
    path: &Path,
    ruleset: &CompiledRuleset,
    bytes: &[u8],
    decode: DecodeOptions,
    archive: ArchiveOptions,
) -> Vec<RawFinding> {
    if archive.max_depth > 0 {
        if let Some(kind) = archive::detect(bytes) {
            if let Some(found) = archive::scan_archive(ruleset, path, bytes, kind, decode, archive) {
                return found;
            }
        }
    }
    if is_binary(bytes) {
        return Vec::new();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => scan_text_full(ruleset, path, s, decode),
        Err(_) => {
            let (cow, _, _) = encoding_rs::UTF_8.decode(bytes);
            scan_text_full(ruleset, path, &cow, decode)
        }
    }
}

pub(crate) fn is_binary(bytes: &[u8]) -> bool {
    let sniff = &bytes[..bytes.len().min(BINARY_SNIFF_LEN)];
    sniff.contains(&0)
}
