// Archive scanning (gitleaks `--max-archive-depth`).
//
// zip, tar, gzip and tar.gz are recognised by their magic bytes, never by extension:
// `notes.7z.txt` holding plain text is still scanned as text (gitleaks #2317) and a zip
// named `bundle.dat` is still opened (#2010). Everything stays in memory; entry names are
// only used as labels in the virtual path `archive.zip!inner/dir/file.env`.

use std::io::{self, Cursor, Read};
use std::path::Path;

use flate2::read::MultiGzDecoder;

use crate::rules::CompiledRuleset;
use crate::scanner::{is_binary, scan_text_full, FileScan, TextScanOptions};

/// Off by default: opening archives costs time and changes results for existing users.
pub const DEFAULT_MAX_ARCHIVE_DEPTH: u32 = 0;
/// Hard ceiling on nesting regardless of the option, so a self-containing zip quine stops.
pub const MAX_ARCHIVE_DEPTH_CAP: u32 = 8;
/// Decompressed bytes allowed per top-level archive, across all nesting levels.
pub const DEFAULT_MAX_TOTAL_BYTES: u64 = 256 << 20;
/// Regular-file entries opened per top-level archive, across all nesting levels.
pub const DEFAULT_MAX_ENTRIES: usize = 10_000;
/// Decompressed / compressed ratio beyond which an entry (or gzip stream) is a bomb.
pub const DEFAULT_MAX_RATIO: u64 = 100;
/// The ratio guard only applies above this many decompressed bytes: small, very
/// repetitive text files legitimately compress past 100:1.
pub const DEFAULT_RATIO_FLOOR: u64 = 1 << 20;

const TAR_MAGIC_OFFSET: usize = 257;
const TAR_HEADER_LEN: usize = 512;

#[derive(Debug, Clone, Copy)]
pub struct ArchiveOptions {
    /// 0 disables archive scanning; 1 opens top-level archives; each extra level opens
    /// one more layer of nested archives. Clamped to `MAX_ARCHIVE_DEPTH_CAP`.
    pub max_depth: u32,
    /// Per-entry decompressed size cap (the scan's `maxFileSize`).
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
    pub max_entries: usize,
    pub max_ratio: u64,
    pub ratio_floor: u64,
}

impl Default for ArchiveOptions {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_ARCHIVE_DEPTH,
            max_entry_bytes: 10 << 20,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
            max_entries: DEFAULT_MAX_ENTRIES,
            max_ratio: DEFAULT_MAX_RATIO,
            ratio_floor: DEFAULT_RATIO_FLOOR,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    Zip,
    Gzip,
    Tar,
}

/// Identify an archive by its leading bytes.
pub fn detect(bytes: &[u8]) -> Option<ArchiveKind> {
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        return Some(ArchiveKind::Zip);
    }
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Some(ArchiveKind::Gzip);
    }
    if is_tar(bytes) {
        return Some(ArchiveKind::Tar);
    }
    None
}

/// POSIX (`ustar\0`) and GNU (`ustar `) tar both carry `ustar` at offset 257.
fn is_tar(bytes: &[u8]) -> bool {
    bytes.get(TAR_MAGIC_OFFSET..TAR_MAGIC_OFFSET + 5) == Some(b"ustar".as_slice())
}

struct Ctx<'a> {
    ruleset: &'a CompiledRuleset,
    text: TextScanOptions<'a>,
    limits: ArchiveOptions,
    /// Path of the archive file on disk, as passed to the scanner.
    outer: String,
    total: u64,
    entries: usize,
    out: FileScan,
}

impl Ctx<'_> {
    fn remaining(&self) -> u64 {
        self.limits.max_total_bytes.saturating_sub(self.total)
    }

    fn exhausted(&self) -> bool {
        self.remaining() == 0 || self.entries >= self.limits.max_entries
    }

    /// Decompressed bytes an input of `compressed` bytes may expand to.
    fn ratio_cap(&self, compressed: u64) -> u64 {
        compressed.saturating_mul(self.limits.max_ratio).max(self.limits.ratio_floor)
    }

    /// Record content that was not scanned. `suffix` is the virtual suffix of the entry
    /// (`!dir/file.env`), or of the archive layer itself when the walk stopped early.
    fn skip(&mut self, suffix: &str, reason: &'static str) {
        self.out.skipped.push((suffix.to_string(), reason));
    }
}

/// Scan `bytes` (the content of `path`) as an archive. Returns `None` when the bytes only
/// looked like an archive and failed to open, so the caller falls back to the plain path.
pub fn scan_archive(
    ruleset: &CompiledRuleset,
    path: &Path,
    bytes: &[u8],
    kind: ArchiveKind,
    opts: TextScanOptions<'_>,
    limits: ArchiveOptions,
) -> Option<FileScan> {
    let mut ctx = Ctx {
        ruleset,
        text: opts,
        limits: ArchiveOptions { max_depth: limits.max_depth.min(MAX_ARCHIVE_DEPTH_CAP), ..limits },
        outer: path.to_string_lossy().into_owned(),
        total: 0,
        entries: 0,
        out: FileScan::default(),
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    open(&mut ctx, bytes, kind, "", &name, 1).then_some(ctx.out)
}

/// Open one archive layer. `prefix` is the virtual suffix of the archive itself (empty at
/// the top level); `name` is its own file name, used to label a bare gzip stream.
fn open(ctx: &mut Ctx<'_>, bytes: &[u8], kind: ArchiveKind, prefix: &str, name: &str, depth: u32) -> bool {
    match kind {
        ArchiveKind::Zip => walk_zip(ctx, bytes, prefix, depth),
        ArchiveKind::Tar => walk_tar(ctx, Cursor::new(bytes), prefix, depth),
        ArchiveKind::Gzip => walk_gzip(ctx, bytes, prefix, name, depth),
    }
}

fn walk_zip(ctx: &mut Ctx<'_>, bytes: &[u8], prefix: &str, depth: u32) -> bool {
    let Ok(mut zip) = zip::ZipArchive::new(Cursor::new(bytes)) else {
        return false;
    };

    for i in 0..zip.len() {
        if ctx.exhausted() {
            ctx.skip(prefix, "too-large");
            break;
        }
        // Encrypted entries and unsupported compression methods fail here; skip them.
        let Ok(mut file) = zip.by_index(i) else {
            let name = zip.name_for_index(i).and_then(Result::ok).map(|n| sanitize_entry_name(&n));
            ctx.skip(&format!("{prefix}!{}", name.as_deref().unwrap_or("unnamed")), "io-error");
            continue;
        };
        if !file.is_file() {
            continue;
        }
        ctx.entries += 1;

        let name = sanitize_entry_name(&String::from_utf8_lossy(file.name_raw()));
        // Header sizes are attacker-controlled: they only allow an early skip, the read
        // below is capped independently.
        if file.size() > ctx.limits.max_entry_bytes {
            ctx.skip(&format!("{prefix}!{name}"), "too-large");
            continue;
        }
        let cap = ctx.ratio_cap(file.compressed_size());
        match read_capped(ctx, &mut file, cap) {
            ReadOutcome::Data(data) => handle_entry(ctx, data, prefix, &name, depth),
            ReadOutcome::Skip(reason) => ctx.skip(&format!("{prefix}!{name}"), reason),
            ReadOutcome::Stop => {
                ctx.skip(prefix, "too-large");
                break;
            }
        }
    }
    true
}

/// Returns `false` when the first header doesn't parse: text that merely has `ustar` at
/// offset 257 then falls back to the plain path instead of vanishing.
fn walk_tar<R: Read>(ctx: &mut Ctx<'_>, reader: R, prefix: &str, depth: u32) -> bool {
    let mut archive = tar::Archive::new(reader);
    let Ok(entries) = archive.entries() else { return false };

    for (i, entry) in entries.enumerate() {
        if ctx.exhausted() {
            ctx.skip(prefix, "too-large");
            break;
        }
        // A truncated or capped stream ends the walk; findings so far are kept.
        let Ok(mut entry) = entry else {
            if i > 0 {
                ctx.skip(prefix, "io-error");
            }
            return i > 0;
        };
        if !entry.header().entry_type().is_file() {
            continue;
        }
        ctx.entries += 1;

        let name = sanitize_entry_name(&String::from_utf8_lossy(&entry.path_bytes()));
        if entry.size() > ctx.limits.max_entry_bytes {
            ctx.skip(&format!("{prefix}!{name}"), "too-large");
            continue;
        }
        match read_capped(ctx, &mut entry, u64::MAX) {
            ReadOutcome::Data(data) => handle_entry(ctx, data, prefix, &name, depth),
            ReadOutcome::Skip(reason) => ctx.skip(&format!("{prefix}!{name}"), reason),
            ReadOutcome::Stop => {
                ctx.skip(prefix, "too-large");
                break;
            }
        }
    }
    true
}

/// A gzip stream is either a tar.gz (walked at the same level: decompression is not a
/// nesting layer) or a single compressed file.
fn walk_gzip(ctx: &mut Ctx<'_>, bytes: &[u8], prefix: &str, name: &str, depth: u32) -> bool {
    // Cap the whole decompressed stream by the bomb ratio and the remaining budget. Hitting
    // the cap surfaces as a read error, which ends the walk.
    let cap = ctx.ratio_cap(bytes.len() as u64).min(ctx.remaining());
    let mut stream = CappedReader { inner: MultiGzDecoder::new(bytes), left: cap };

    let mut head = Vec::with_capacity(TAR_HEADER_LEN);
    if (&mut stream).take(TAR_HEADER_LEN as u64).read_to_end(&mut head).is_err() || head.is_empty() {
        return false;
    }

    if is_tar(&head) {
        walk_tar(ctx, Cursor::new(head).chain(stream), prefix, depth);
        return true;
    }

    let inner_name = stream
        .inner
        .header()
        .and_then(|h| h.filename())
        .map(|f| sanitize_entry_name(&String::from_utf8_lossy(f)))
        .unwrap_or_else(|| strip_gz_suffix(name));
    if ctx.exhausted() {
        ctx.skip(&format!("{prefix}!{inner_name}"), "too-large");
        return true;
    }
    ctx.entries += 1;

    let mut reader = Cursor::new(head).chain(stream);
    match read_capped(ctx, &mut reader, u64::MAX) {
        ReadOutcome::Data(data) => handle_entry(ctx, data, prefix, &inner_name, depth),
        ReadOutcome::Skip(reason) => ctx.skip(&format!("{prefix}!{inner_name}"), reason),
        ReadOutcome::Stop => ctx.skip(&format!("{prefix}!{inner_name}"), "too-large"),
    }
    true
}

enum ReadOutcome {
    Data(Vec<u8>),
    /// Entry too large, a bomb (`"too-large"`), or unreadable (`"io-error"`): skip it and
    /// continue.
    Skip(&'static str),
    /// The per-archive byte budget ran out: stop walking.
    Stop,
}

/// Read an entry under `min(maxFileSize, remaining budget, ratio_cap)` bytes.
fn read_capped<R: Read + ?Sized>(ctx: &mut Ctx<'_>, reader: &mut R, ratio_cap: u64) -> ReadOutcome {
    let remaining = ctx.remaining();
    let limit = ctx.limits.max_entry_bytes.min(remaining).min(ratio_cap);
    let mut data = Vec::new();
    let result = reader.take(limit.saturating_add(1)).read_to_end(&mut data);
    ctx.total = ctx.total.saturating_add(data.len() as u64);

    if let Err(e) = result {
        let reason = if e.kind() == io::ErrorKind::FileTooLarge { "too-large" } else { "io-error" };
        return ReadOutcome::Skip(reason);
    }
    if data.len() as u64 > limit {
        return if limit == remaining { ReadOutcome::Stop } else { ReadOutcome::Skip("too-large") };
    }
    ReadOutcome::Data(data)
}

fn handle_entry(ctx: &mut Ctx<'_>, data: Vec<u8>, prefix: &str, name: &str, depth: u32) {
    let suffix = format!("{prefix}!{name}");

    if let Some(kind) = detect(&data) {
        if depth < ctx.limits.max_depth {
            let base = name.rsplit('/').next().unwrap_or(name).to_string();
            open(ctx, &data, kind, &suffix, &base, depth + 1);
        }
        // Past the depth limit a nested archive is binary content: skipped like one.
        return;
    }
    if data.is_empty() || is_binary(&data) {
        return;
    }

    let text = match String::from_utf8(data) {
        Ok(s) => s,
        Err(e) => encoding_rs::UTF_8.decode(e.as_bytes()).0.into_owned(),
    };
    let virtual_path = format!("{}{suffix}", ctx.outer);
    for mut finding in scan_text_full(ctx.ruleset, Path::new(&virtual_path), &text, ctx.text) {
        finding.archive_entry = Some(suffix.clone());
        ctx.out.findings.push(finding);
    }
}

/// Turn an untrusted entry name into a safe, readable label: `\` becomes `/`, control
/// characters go, and empty, `.`, `..` and drive-letter components are dropped, so the
/// label can't climb out of the archive (`../../etc/passwd` -> `etc/passwd`).
pub fn sanitize_entry_name(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).map(|c| if c == '\\' { '/' } else { c }).collect();
    let parts: Vec<&str> = cleaned
        .split('/')
        .enumerate()
        .filter(|(i, p)| {
            !p.is_empty()
                && *p != "."
                && *p != ".."
                && !(*i == 0 && p.len() == 2 && p.ends_with(':') && p.as_bytes()[0].is_ascii_alphabetic())
        })
        .map(|(_, p)| p)
        .collect();
    if parts.is_empty() {
        "unnamed".to_string()
    } else {
        parts.join("/")
    }
}

fn strip_gz_suffix(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for ext in [".gz", ".gzip"] {
        if lower.ends_with(ext) && name.len() > ext.len() {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    if name.is_empty() {
        "unnamed".to_string()
    } else {
        name.to_string()
    }
}

/// Fails with an error once more than `left` bytes were read.
struct CappedReader<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for CappedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n as u64 > self.left {
            self.left = 0;
            return Err(io::Error::new(io::ErrorKind::FileTooLarge, "archive decompression cap reached"));
        }
        self.left -= n as u64;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::config::Config;
    use crate::detector::RawFinding;

    const SECRET_LINE: &str = concat!("token = ghp_aB3dE4fG5hI6jK7l", "M8nO9pQ0rS1tU2vW3xY4\n");

    fn ruleset() -> CompiledRuleset {
        let cfg: Config = serde_json::from_value(serde_json::json!({
            "rules": [{ "id": "gh-pat", "regex": "ghp_[0-9A-Za-z]{36}", "keywords": ["ghp_"] }]
        }))
        .unwrap();
        CompiledRuleset::compile(&cfg).unwrap()
    }

    fn opts(depth: u32) -> ArchiveOptions {
        ArchiveOptions { max_depth: depth, ..Default::default() }
    }

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            w.start_file(*name, o).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn tar_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for (name, data) in entries {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            // `append_data` rejects `..`; write the raw name to simulate a hostile archive.
            let raw = name.as_bytes();
            h.as_old_mut().name[..raw.len()].copy_from_slice(raw);
            h.set_cksum();
            b.append(&h, *data).unwrap();
        }
        b.into_inner().unwrap()
    }

    fn gz(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn scan_full(bytes: &[u8], name: &str, o: ArchiveOptions) -> FileScan {
        let rs = ruleset();
        let kind = detect(bytes).expect("archive");
        scan_archive(&rs, Path::new(name), bytes, kind, TextScanOptions::default(), o).expect("opened")
    }

    fn scan(bytes: &[u8], name: &str, o: ArchiveOptions) -> Vec<RawFinding> {
        scan_full(bytes, name, o).findings
    }

    fn files(findings: &[RawFinding]) -> Vec<String> {
        findings.iter().map(|f| f.file.clone()).collect()
    }

    #[test]
    fn nested_zip_inside_tar_gz() {
        let inner = zip_of(&[("config/app.env", SECRET_LINE.as_bytes())]);
        let outer = gz(&tar_of(&[("vendor/bundle.zip", &inner), ("README", b"nothing here\n")]));

        // tar.gz is one level, the zip inside it a second.
        assert!(scan(&outer, "release.tgz", opts(1)).is_empty());
        let found = scan(&outer, "release.tgz", opts(2));
        assert_eq!(files(&found), vec!["release.tgz!vendor/bundle.zip!config/app.env"]);
        assert_eq!(found[0].archive_entry.as_deref(), Some("!vendor/bundle.zip!config/app.env"));
        assert_eq!(found[0].start_line, 1);
    }

    #[test]
    fn plain_gz_uses_header_name_or_stripped_file_name() {
        let found = scan(&gz(SECRET_LINE.as_bytes()), "dump.sql.gz", opts(1));
        assert_eq!(files(&found), vec!["dump.sql.gz!dump.sql"]);

        let mut e = flate2::GzBuilder::new().filename("../../inner.txt").write(Vec::new(), flate2::Compression::fast());
        e.write_all(SECRET_LINE.as_bytes()).unwrap();
        let found = scan(&e.finish().unwrap(), "x.gz", opts(1));
        assert_eq!(files(&found), vec!["x.gz!inner.txt"]);
    }

    #[test]
    fn traversal_names_are_sanitised() {
        let t = tar_of(&[("../../etc/passwd.env", SECRET_LINE.as_bytes())]);
        assert_eq!(files(&scan(&t, "a.tar", opts(1))), vec!["a.tar!etc/passwd.env"]);

        assert_eq!(sanitize_entry_name("..\\..\\C:\\x\\.\\y"), "C:/x/y");
        assert_eq!(sanitize_entry_name("C:\\Windows\\a"), "Windows/a");
        assert_eq!(sanitize_entry_name("/abs//p\u{1b}[31m/q"), "abs/p[31m/q");
        assert_eq!(sanitize_entry_name("../.."), "unnamed");
    }

    #[test]
    fn zip_bomb_entry_is_skipped_by_ratio() {
        let bomb = vec![b'a'; 4 << 20];
        let z = zip_of(&[("bomb.txt", &bomb), ("ok.env", SECRET_LINE.as_bytes())]);
        let o = ArchiveOptions { ratio_floor: 64 << 10, ..opts(1) };
        let out = scan_full(&z, "b.zip", o);
        // The bomb is skipped and reported, the following entry still scanned.
        assert_eq!(files(&out.findings), vec!["b.zip!ok.env"]);
        assert_eq!(out.skipped, vec![("!bomb.txt".to_string(), "too-large")]);
    }

    #[test]
    fn gzip_bomb_stream_is_capped() {
        let mut body = vec![b'a'; 4 << 20];
        body.extend_from_slice(SECRET_LINE.as_bytes());
        let o = ArchiveOptions { ratio_floor: 64 << 10, ..opts(1) };
        let out = scan_full(&gz(&body), "big.gz", o);
        assert!(out.findings.is_empty());
        assert_eq!(out.skipped, vec![("!big".to_string(), "too-large")]);
        // A ratio limit high enough for this stream lets it through.
        assert_eq!(scan(&gz(&body), "big.gz", ArchiveOptions { max_ratio: 100_000, ..opts(1) }).len(), 1);
    }

    #[test]
    fn total_budget_and_entry_count_stop_the_walk() {
        let entries: Vec<(String, Vec<u8>)> =
            (0..5).map(|i| (format!("f{i}.env"), SECRET_LINE.as_bytes().to_vec())).collect();
        let refs: Vec<(&str, &[u8])> = entries.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
        let z = zip_of(&refs);

        let out = scan_full(&z, "z.zip", ArchiveOptions { max_entries: 2, ..opts(1) });
        assert_eq!(out.findings.len(), 2);
        // The rest of the archive was not read: the archive itself is reported as skipped.
        assert_eq!(out.skipped, vec![(String::new(), "too-large")]);
        let budget = SECRET_LINE.len() as u64 * 3;
        assert_eq!(scan(&z, "z.zip", ArchiveOptions { max_total_bytes: budget, ..opts(1) }).len(), 3);
        // Entries above maxFileSize are skipped, not fatal.
        assert!(scan(&z, "z.zip", ArchiveOptions { max_entry_bytes: 10, ..opts(1) }).is_empty());
    }

    #[test]
    fn binary_entries_are_skipped() {
        let mut bin = SECRET_LINE.as_bytes().to_vec();
        bin.push(0);
        assert!(scan(&zip_of(&[("blob.bin", &bin)]), "z.zip", opts(1)).is_empty());
    }

    #[test]
    fn detection_is_by_magic_bytes() {
        assert_eq!(detect(&zip_of(&[("a", b"b")])), Some(ArchiveKind::Zip));
        assert_eq!(detect(&gz(b"x")), Some(ArchiveKind::Gzip));
        assert_eq!(detect(&tar_of(&[("a", b"b")])), Some(ArchiveKind::Tar));
        assert_eq!(detect(b"7z archive notes\nPK\x03\x04 later is fine"), None);
        assert_eq!(detect(b"PK"), None);
    }

    #[test]
    fn garbage_with_zip_magic_falls_back() {
        let rs = ruleset();
        let bytes = b"PK\x03\x04 not really a zip";
        assert!(
            scan_archive(&rs, Path::new("x"), bytes, ArchiveKind::Zip, TextScanOptions::default(), opts(1)).is_none()
        );
    }

    #[test]
    fn text_with_tar_magic_falls_back() {
        let rs = ruleset();
        let mut text = vec![b'x'; 300];
        text[TAR_MAGIC_OFFSET..TAR_MAGIC_OFFSET + 5].copy_from_slice(b"ustar");
        assert_eq!(detect(&text), Some(ArchiveKind::Tar));
        assert!(scan_archive(&rs, Path::new("t.txt"), &text, ArchiveKind::Tar, TextScanOptions::default(), opts(1))
            .is_none());
    }

    #[test]
    fn depth_is_capped() {
        let mut layer = zip_of(&[("s.env", SECRET_LINE.as_bytes())]);
        for i in 0..MAX_ARCHIVE_DEPTH_CAP + 2 {
            let name = format!("l{i}.zip");
            layer = zip_of(&[(name.as_str(), &layer)]);
        }
        assert!(scan(&layer, "q.zip", opts(u32::MAX)).is_empty());
    }
}
