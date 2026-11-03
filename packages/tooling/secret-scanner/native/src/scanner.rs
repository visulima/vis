// Per-file reader that feeds the detector directly, avoiding an intermediate
// `String` copy for file content that is already valid UTF-8.

use std::borrow::Cow;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use crate::archive::{self, ArchiveOptions};
use crate::decode::{scan_text_with_decoding, DecodeOptions};
use crate::detector::{DetectOptions, RawFinding};
use crate::rules::CompiledRuleset;
use crate::skip::Skipped;

/// Per-scan switches for one unit of text: the decode pass and the detection options.
#[derive(Debug, Clone, Copy, Default)]
pub struct TextScanOptions<'a> {
    pub decode: DecodeOptions,
    pub detect: DetectOptions<'a>,
}

/// What scanning one file produced. `skipped` lists content inside it that was not scanned
/// (archive entries over a size cap, unreadable entries).
#[derive(Debug, Default)]
pub struct FileScan {
    pub findings: Vec<RawFinding>,
    pub skipped: Vec<Skipped>,
}

impl From<Vec<RawFinding>> for FileScan {
    fn from(findings: Vec<RawFinding>) -> Self {
        Self { findings, skipped: Vec::new() }
    }
}

/// Everything the detector does for one unit of text: plain scan, decode pass, then the
/// composite-rule pass. Shared by files, archive entries and `scanTextSync`.
pub fn scan_text_full(
    ruleset: &CompiledRuleset,
    path: &Path,
    content: &str,
    opts: TextScanOptions<'_>,
) -> Vec<RawFinding> {
    crate::composite::apply(ruleset, scan_text_with_decoding(ruleset, path, content, opts))
}

const MMAP_THRESHOLD: u64 = 1 << 20; // 1 MiB
const BINARY_SNIFF_LEN: usize = 8192;

/// Read `path` and run the detector against its contents.
/// Returns `Ok(None)` if the file exceeds `max_bytes` (skipped).
/// With `archive.max_depth > 0`, zip / tar / gzip content (by magic bytes) is opened and
/// its entries scanned. Otherwise binary files (null byte in first 8 KiB) are skipped to
/// an empty result.
pub fn scan_file(
    ruleset: &CompiledRuleset,
    path: &Path,
    max_bytes: u64,
    opts: TextScanOptions<'_>,
    archive: ArchiveOptions,
) -> io::Result<Option<FileScan>> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    if size == 0 {
        return Ok(Some(FileScan::default()));
    }
    if size > max_bytes {
        return Ok(None);
    }

    let mut file = File::open(path)?;

    if size >= MMAP_THRESHOLD {
        // SAFETY: another process truncating the file mid-scan would raise SIGBUS
        // for this thread. We accept that rare risk to keep the zero-copy path.
        if let Ok(map) = unsafe { memmap2::Mmap::map(&file) } {
            return Ok(Some(scan_bytes(ruleset, path, &map, opts, archive)));
        }
    }

    // Size already bounded by the max_bytes check above — casting to usize is safe in practice
    // (max_bytes defaults to 10 MiB, caller can raise it but NAPI caps it at u32::MAX).
    let capacity = usize::try_from(size).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    file.read_to_end(&mut bytes)?;
    Ok(Some(scan_bytes(ruleset, path, &bytes, opts, archive)))
}

fn scan_bytes(
    ruleset: &CompiledRuleset,
    path: &Path,
    bytes: &[u8],
    opts: TextScanOptions<'_>,
    archive: ArchiveOptions,
) -> FileScan {
    if archive.max_depth > 0 {
        if let Some(kind) = archive::detect(bytes) {
            if let Some(found) = archive::scan_archive(ruleset, path, bytes, kind, opts, archive) {
                return found;
            }
        }
    }
    if is_binary(bytes) {
        return FileScan::default();
    }
    scan_text_full(ruleset, path, &lossy_text(bytes), opts).into()
}

/// `bytes` as text: borrowed when valid UTF-8, else decoded with replacement characters
/// (`encoding_rs`, which also drops a leading BOM on that path).
pub(crate) fn lossy_text(bytes: &[u8]) -> Cow<'_, str> {
    match std::str::from_utf8(bytes) {
        Ok(s) => Cow::Borrowed(s),
        Err(_) => encoding_rs::UTF_8.decode(bytes).0,
    }
}

pub(crate) fn is_binary(bytes: &[u8]) -> bool {
    let sniff = &bytes[..bytes.len().min(BINARY_SNIFF_LEN)];
    sniff.contains(&0)
}
