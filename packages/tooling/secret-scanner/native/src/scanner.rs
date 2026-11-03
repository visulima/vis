// Per-file reader that feeds the detector directly, avoiding an intermediate
// `String` copy for mmap'd files that are already valid UTF-8.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

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
/// Binary files (null byte in first 8 KiB) are skipped to an empty Vec.
pub fn scan_file(
    path: &Path,
    ruleset: &CompiledRuleset,
    max_bytes: u64,
    decode: DecodeOptions,
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
            if is_binary(&map) {
                return Ok(Some(Vec::new()));
            }
            if let Ok(s) = std::str::from_utf8(&map) {
                return Ok(Some(scan_text_full(ruleset, path, s, decode)));
            }
            // Fall through to lossy decode for non-UTF-8 large files.
            let (cow, _, _) = encoding_rs::UTF_8.decode(&map);
            return Ok(Some(scan_text_full(ruleset, path, &cow, decode)));
        }
    }

    // Size already bounded by the max_bytes check above — casting to usize is safe in practice
    // (max_bytes defaults to 10 MiB, caller can raise it but NAPI caps it at u32::MAX).
    let capacity = usize::try_from(size).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    file.read_to_end(&mut bytes)?;
    if is_binary(&bytes) {
        return Ok(Some(Vec::new()));
    }
    match String::from_utf8(bytes) {
        Ok(s) => Ok(Some(scan_text_full(ruleset, path, &s, decode))),
        Err(e) => {
            let (cow, _, _) = encoding_rs::UTF_8.decode(e.as_bytes());
            Ok(Some(scan_text_full(ruleset, path, &cow, decode)))
        }
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    let sniff = &bytes[..bytes.len().min(BINARY_SNIFF_LEN)];
    sniff.contains(&0)
}
