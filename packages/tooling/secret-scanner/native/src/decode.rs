// Recursive decoding layer — port of gitleaks' `--max-decode-depth`.
//
// Finds base64 (std + url-safe), hex and percent-encoded segments, decodes the ones that
// yield printable UTF-8, and re-runs the detector over the decoded text. Each decoded
// segment is rescanned together with up to `CONTEXT_BYTES` of its original line on either
// side, so `password: <base64>` still gives keyword-driven rules their context.
//
// All fragments of one depth are joined into a single buffer and scanned once: the
// detector allocates per-rule state and runs the RegexSet per call, so one call per
// segment would cost O(segments × rules).
//
// A finding from decoded text is reported at the line/column of the ORIGINAL encoded
// span and carries the encoding chain (outermost first) in `RawFinding::decoded`.

use std::path::Path;

use once_cell::sync::Lazy;
use regex::Regex;

use crate::detector::{self, DetectOptions, RawFinding};
use crate::rules::CompiledRuleset;

/// Default recursion depth. 2 covers "base64 in a k8s Secret" and one extra wrapping
/// layer without the blow-up of deeper recursion.
pub const DEFAULT_MAX_DECODE_DEPTH: u32 = 2;

/// Default cap on decoded bytes produced per file, summed over every depth. Bounds
/// memory on hostile or huge inputs (gitleaks #2019 reached 24 GB without one).
pub const DEFAULT_MAX_DECODED_BYTES: usize = 4 << 20;

/// Bytes of the original line kept on each side of an encoded segment.
const CONTEXT_BYTES: usize = 256;

/// Minimum length of a base64 run. 16 chars decode to 12 bytes — shorter runs are mostly
/// identifiers and add noise without carrying a realistic secret.
const MIN_BASE64_LEN: usize = 16;
/// Minimum length of a hex run (16 decoded bytes).
const MIN_HEX_LEN: usize = 32;

static BASE64_RUN: Lazy<Regex> = Lazy::new(|| Regex::new(r"[A-Za-z0-9+/_-]{16,}={0,2}").expect("base64 regex"));
static PERCENT_RUN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"%[0-9A-Fa-f]{2}(?:[^\s%"'<>`]*?%[0-9A-Fa-f]{2})*"#).expect("percent regex"));

#[derive(Debug, Clone, Copy)]
pub struct DecodeOptions {
    /// 0 disables decoding.
    pub max_depth: u32,
    /// Total decoded bytes allowed per file across all depths.
    pub max_bytes: usize,
}

impl Default for DecodeOptions {
    fn default() -> Self {
        Self { max_depth: DEFAULT_MAX_DECODE_DEPTH, max_bytes: DEFAULT_MAX_DECODED_BYTES }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Base64,
    Hex,
    Percent,
}

impl Encoding {
    fn as_str(self) -> &'static str {
        match self {
            Self::Base64 => "base64",
            Self::Hex => "hex",
            Self::Percent => "percent",
        }
    }
}

#[derive(Debug)]
struct Segment {
    start: usize,
    end: usize,
    encoding: Encoding,
    decoded: String,
}

/// One contiguous run of a fragment buffer and where it came from.
#[derive(Debug, Clone)]
struct Piece {
    buf_start: usize,
    buf_end: usize,
    /// Span in the original file content. Literal pieces map linearly; decoded pieces map
    /// every inner offset to the whole encoded span.
    orig_start: usize,
    orig_end: usize,
    /// `None` = literal original text. `Some(chain)` = decoded text, outermost first.
    chain: Option<Vec<Encoding>>,
    /// Introduced at the current depth. Only findings touching a fresh piece are reported
    /// at this depth — the rest were already reported by the plain scan or a shallower depth.
    fresh: bool,
}

#[derive(Debug)]
struct Fragment {
    start: usize,
    end: usize,
    pieces: Vec<Piece>,
}

/// Plain scan plus the bounded recursive decode pass.
pub fn scan_text_with_decoding(
    ruleset: &CompiledRuleset,
    path: &Path,
    content: &str,
    opts: DecodeOptions,
    detect: DetectOptions<'_>,
) -> Vec<RawFinding> {
    let mut out = detector::scan_text_with(ruleset, path, content, detect);
    if opts.max_depth == 0 || opts.max_bytes == 0 {
        return out;
    }

    let mut budget = opts.max_bytes;
    let segments = find_segments(content, 0, content.len(), &mut budget);
    if segments.is_empty() {
        return out;
    }

    let line_offsets = detector::compute_line_offsets(content);
    let allow_regions = if detect.inline_allow { detector::find_allow_regions(content) } else { Vec::new() };
    let original = Original { content, line_offsets: &line_offsets, allow_regions: &allow_regions, detect };

    let (mut buf, mut fragments) = first_level(content, segments);
    for depth in 1..=opts.max_depth {
        // Inline markers are checked against the original line in `map_finding`; in the
        // joined fragment buffer a nextline pragma would leak into the next fragment.
        let raw = detector::scan_text_decoded(ruleset, path, &buf, DetectOptions { inline_allow: false, ..detect });
        for finding in raw {
            let Some(mapped) = map_finding(finding, &fragments, &original) else { continue };
            // A percent run keeps the literal text between its escapes, so a plain secret
            // inside it is "decoded" again; likewise a shallower depth may already have
            // reported it. Drop the repeat: same rule + secret already reported inside
            // this encoded span.
            if already_reported(&out, &mapped) {
                continue;
            }
            out.push(mapped);
        }

        if depth == opts.max_depth || budget == 0 {
            break;
        }
        match next_level(&buf, &fragments, &mut budget) {
            Some((next_buf, next_fragments)) => {
                buf = next_buf;
                fragments = next_fragments;
            }
            None => break,
        }
    }

    out
}

fn already_reported(out: &[RawFinding], f: &RawFinding) -> bool {
    out.iter().any(|p| {
        p.rule_id == f.rule_id
            && p.secret == f.secret
            && p.start_offset >= f.start_offset
            && p.end_offset <= f.end_offset
    })
}

struct Original<'a> {
    content: &'a str,
    line_offsets: &'a [usize],
    allow_regions: &'a [(usize, usize)],
    detect: DetectOptions<'a>,
}

/// Find decodable segments in `text[from..to]`. Returned offsets are absolute in `text`,
/// sorted and non-overlapping. Each accepted segment is charged against `budget`.
fn find_segments(text: &str, from: usize, to: usize, budget: &mut usize) -> Vec<Segment> {
    let hay = &text[from..to];
    let mut candidates: Vec<(usize, usize)> = Vec::new();
    // Cheap byte prefilter: skip the percent regex when there's no `%` at all.
    if hay.as_bytes().contains(&b'%') {
        candidates.extend(PERCENT_RUN.find_iter(hay).map(|m| (m.start(), m.end())));
    }
    candidates.extend(BASE64_RUN.find_iter(hay).map(|m| (m.start(), m.end())));
    // Leftmost first, longest first on ties — deterministic regardless of detector order.
    candidates.sort_by_key(|&(s, e)| (s, std::cmp::Reverse(e)));

    let mut out: Vec<Segment> = Vec::new();
    let mut last_end = 0usize;
    for (s, e) in candidates {
        if *budget == 0 {
            break;
        }
        if s < last_end {
            continue;
        }
        let raw = &hay[s..e];
        // Lower bound on the decoded size of base64/hex (percent is checked after
        // decoding); skip before allocating when it can't fit.
        if raw.trim_end_matches('=').len() * 3 / 4 > *budget {
            continue;
        }
        let Some((encoding, decoded)) = decode_candidate(raw) else { continue };
        if decoded.len() > *budget {
            continue;
        }
        *budget -= decoded.len();
        last_end = e;
        out.push(Segment { start: from + s, end: from + e, encoding, decoded });
    }
    out
}

fn decode_candidate(raw: &str) -> Option<(Encoding, String)> {
    if raw.starts_with('%') {
        return decode_percent(raw).map(|d| (Encoding::Percent, d));
    }
    let unpadded = raw.trim_end_matches('=');
    if unpadded.len() >= MIN_HEX_LEN && unpadded.len() == raw.len() && unpadded.bytes().all(|b| b.is_ascii_hexdigit()) {
        if let Some(d) = decode_hex(unpadded) {
            return Some((Encoding::Hex, d));
        }
    }
    if unpadded.len() >= MIN_BASE64_LEN {
        if let Some(d) = decode_base64(raw) {
            return Some((Encoding::Base64, d));
        }
    }
    None
}

/// Accept decoded bytes only when they are UTF-8 text a human could have typed: valid
/// UTF-8 (non-ASCII allowed, gitleaks #2172/#2208), no control chars other than
/// `\t`/`\n`/`\r`. Random binary (images, hashes, ciphertext) almost never passes.
fn printable_utf8(bytes: Vec<u8>) -> Option<String> {
    let s = String::from_utf8(bytes).ok()?;
    if s.is_empty() || s.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) {
        return None;
    }
    Some(s)
}

fn decode_base64(raw: &str) -> Option<String> {
    let body = raw.trim_end_matches('=');
    let bytes = body.as_bytes();
    let has_std = bytes.iter().any(|&b| b == b'+' || b == b'/');
    let has_url = bytes.iter().any(|&b| b == b'-' || b == b'_');
    // Mixed alphabets are not base64 — usually a path or a kebab/snake identifier.
    if has_std && has_url {
        return None;
    }
    if bytes.len() % 4 == 1 {
        return None;
    }

    fn value(b: u8) -> Option<u32> {
        Some(match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    }

    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 + 2);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, &b) in chunk.iter().enumerate() {
            acc |= value(b)? << (18 - 6 * i);
        }
        let n = chunk.len() * 6 / 8;
        for i in 0..n {
            let byte = (acc >> (16 - 8 * i)) & 0xFF;
            // Early exit on the first control byte: keeps rejection of binary blobs cheap.
            if byte < 0x20 && !matches!(byte, 0x09 | 0x0A | 0x0D) {
                return None;
            }
            out.push(byte as u8);
        }
    }
    printable_utf8(out)
}

fn decode_hex(raw: &str) -> Option<String> {
    if !raw.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(raw.len() / 2);
    for pair in raw.as_bytes().chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        let byte = (hi << 4 | lo) as u8;
        if byte < 0x20 && !matches!(byte, 0x09 | 0x0A | 0x0D) {
            return None;
        }
        out.push(byte);
    }
    printable_utf8(out)
}

fn decode_percent(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi << 4 | lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    printable_utf8(out)
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Context window around `[start, end)`: the enclosing line, capped at `CONTEXT_BYTES`
/// on each side. Always on char boundaries.
fn context_window(text: &str, start: usize, end: usize, lo_bound: usize, hi_bound: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    let floor = start.saturating_sub(CONTEXT_BYTES).max(lo_bound);
    let line_start = bytes[floor..start].iter().rposition(|&b| b == b'\n').map_or(floor, |p| floor + p + 1);
    let ceil = (end + CONTEXT_BYTES).min(hi_bound);
    let line_end = bytes[end..ceil].iter().position(|&b| b == b'\n').map_or(ceil, |p| end + p);
    (floor_char_boundary(text, line_start).max(lo_bound), ceil_char_boundary(text, line_end).min(hi_bound))
}

/// Build the depth-1 buffer from segments found in the original content.
fn first_level(content: &str, segments: Vec<Segment>) -> (String, Vec<Fragment>) {
    // Group segments whose context windows touch into one fragment.
    let mut groups: Vec<(usize, usize, Vec<Segment>)> = Vec::new();
    for seg in segments {
        let (cs, ce) = context_window(content, seg.start, seg.end, 0, content.len());
        match groups.last_mut() {
            Some((_, g_end, segs)) if cs <= *g_end => {
                *g_end = (*g_end).max(ce);
                segs.push(seg);
            }
            _ => groups.push((cs, ce, vec![seg])),
        }
    }

    let mut buf = String::new();
    let mut fragments = Vec::with_capacity(groups.len());
    for (g_start, g_end, segs) in groups {
        if !buf.is_empty() {
            buf.push('\n');
        }
        let frag_start = buf.len();
        let mut pieces = Vec::new();
        let mut cursor = g_start;
        for seg in segs {
            push_literal(&mut buf, &mut pieces, content, cursor, seg.start);
            let b = buf.len();
            buf.push_str(&seg.decoded);
            pieces.push(Piece {
                buf_start: b,
                buf_end: buf.len(),
                orig_start: seg.start,
                orig_end: seg.end,
                chain: Some(vec![seg.encoding]),
                fresh: true,
            });
            cursor = seg.end;
        }
        push_literal(&mut buf, &mut pieces, content, cursor, g_end);
        fragments.push(Fragment { start: frag_start, end: buf.len(), pieces });
    }
    (buf, fragments)
}

fn push_literal(buf: &mut String, pieces: &mut Vec<Piece>, content: &str, from: usize, to: usize) {
    if from >= to {
        return;
    }
    let b = buf.len();
    buf.push_str(&content[from..to]);
    pieces.push(Piece { buf_start: b, buf_end: buf.len(), orig_start: from, orig_end: to, chain: None, fresh: false });
}

/// Build the next depth: look for further encoded segments inside the decoded pieces of
/// the current buffer. Fragments without a new segment are dropped. `None` = nothing left.
fn next_level(buf: &str, fragments: &[Fragment], budget: &mut usize) -> Option<(String, Vec<Fragment>)> {
    let mut next_buf = String::new();
    let mut next_fragments = Vec::new();

    for frag in fragments {
        let mut pieces = Vec::new();
        let mut found_any = false;
        let mark = next_buf.len();
        if !next_buf.is_empty() {
            next_buf.push('\n');
        }
        let frag_start = next_buf.len();

        for piece in &frag.pieces {
            let Some(chain) = &piece.chain else {
                let b = next_buf.len();
                next_buf.push_str(&buf[piece.buf_start..piece.buf_end]);
                pieces.push(Piece { buf_start: b, buf_end: next_buf.len(), fresh: false, ..piece.clone() });
                continue;
            };

            let segs =
                if *budget == 0 { Vec::new() } else { find_segments(buf, piece.buf_start, piece.buf_end, budget) };
            let mut cursor = piece.buf_start;
            for seg in segs {
                found_any = true;
                push_decoded(&mut next_buf, &mut pieces, &buf[cursor..seg.start], piece, chain.clone(), false);
                let mut inner = chain.clone();
                inner.push(seg.encoding);
                push_decoded(&mut next_buf, &mut pieces, &seg.decoded, piece, inner, true);
                cursor = seg.end;
            }
            push_decoded(&mut next_buf, &mut pieces, &buf[cursor..piece.buf_end], piece, chain.clone(), false);
        }

        if found_any {
            next_fragments.push(Fragment { start: frag_start, end: next_buf.len(), pieces });
        } else {
            next_buf.truncate(mark);
        }
    }

    if next_fragments.is_empty() {
        None
    } else {
        Some((next_buf, next_fragments))
    }
}

fn push_decoded(
    buf: &mut String,
    pieces: &mut Vec<Piece>,
    text: &str,
    parent: &Piece,
    chain: Vec<Encoding>,
    fresh: bool,
) {
    if text.is_empty() {
        return;
    }
    let b = buf.len();
    buf.push_str(text);
    pieces.push(Piece {
        buf_start: b,
        buf_end: buf.len(),
        orig_start: parent.orig_start,
        orig_end: parent.orig_end,
        chain: Some(chain),
        fresh,
    });
}

/// Translate a finding over the fragment buffer back to the original content. Returns
/// `None` for findings that don't touch freshly decoded text, cross a fragment boundary,
/// or are suppressed by an allow marker on the original line.
fn map_finding(mut f: RawFinding, fragments: &[Fragment], original: &Original<'_>) -> Option<RawFinding> {
    let (s, e) = (f.start_offset as usize, f.end_offset as usize);
    let idx = fragments.partition_point(|fr| fr.end < s);
    let frag = fragments.get(idx)?;
    if s < frag.start || e > frag.end {
        return None;
    }

    let overlapping: Vec<&Piece> = frag.pieces.iter().filter(|p| p.buf_start < e.max(s + 1) && s < p.buf_end).collect();
    if !overlapping.iter().any(|p| p.fresh) {
        return None;
    }
    let first = overlapping.first()?;
    let last = overlapping.last()?;

    let orig_start = match first.chain {
        None => first.orig_start + (s - first.buf_start),
        Some(_) => first.orig_start,
    };
    let orig_end = match last.chain {
        None => last.orig_start + (e.min(last.buf_end) - last.buf_start),
        Some(_) => last.orig_end,
    };
    let chain = overlapping.iter().filter_map(|p| p.chain.as_ref()).max_by_key(|c| c.len())?;

    // Defensive: never hand a non-boundary offset to the line/column helpers, which slice.
    if !original.content.is_char_boundary(orig_start)
        || !original.content.is_char_boundary(orig_end)
        || orig_start > orig_end
    {
        return None;
    }

    // Suppression markers live on the original line, which the decoded buffer may not
    // fully contain — re-check them against the original content.
    let (sl, sc, el, ec) = detector::offset_to_line_col(original.line_offsets, orig_start, orig_end, original.content);
    let line = detector::line_slice(original.content, original.line_offsets, sl);
    let inline_allowed = original.detect.inline_allow
        && (detector::has_allow_comment(line)
            || detector::is_in_allow_region(original.allow_regions, orig_start)
            || (sl > 1
                && detector::has_nextline_pragma(detector::line_slice(
                    original.content,
                    original.line_offsets,
                    sl - 1,
                ))));
    if inline_allowed {
        if !original.detect.report_suppressed {
            return None;
        }
        f.suppressed_by = Some(detector::SUPPRESSED_INLINE);
    }

    f.inner_start = (s - frag.start) as u32;
    f.inner_end = (e - frag.start) as u32;
    f.start_offset = orig_start as u32;
    f.end_offset = orig_end as u32;
    f.start_line = sl;
    f.start_column = sc;
    f.end_line = el;
    f.end_column = ec;
    f.decoded = Some(chain.iter().map(|enc| enc.as_str().to_string()).collect());
    Some(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ruleset(json: &str) -> CompiledRuleset {
        let cfg: crate::config::Config = serde_json::from_str(json).expect("config json");
        CompiledRuleset::compile(&cfg).expect("compile")
    }

    fn b64(s: &str) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in s.as_bytes().chunks(3) {
            let mut acc = 0u32;
            for (i, &b) in chunk.iter().enumerate() {
                acc |= (b as u32) << (16 - 8 * i);
            }
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(ALPHABET[((acc >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    fn hex(s: &str) -> String {
        s.bytes().map(|b| format!("{b:02x}")).collect()
    }

    const OPENROUTER: &str = r#"{"rules":[{"id":"openrouter","regex":"\\b(sk-or-v1-[0-9a-f]{64})\\b","secretGroup":1,"keywords":["sk-or-v1-"]}]}"#;
    const KEY: &str = concat!("sk-or-v1-0123456789abcdef0123456789a", "bcdef0123456789abcdef0123456789abcdef");

    fn scan(text: &str, depth: u32) -> Vec<RawFinding> {
        let rs = ruleset(OPENROUTER);
        scan_text_with_decoding(
            &rs,
            Path::new("x.txt"),
            text,
            DecodeOptions { max_depth: depth, ..Default::default() },
            DetectOptions::default(),
        )
    }

    #[test]
    fn base64_wrapped_key_reports_original_span() {
        let encoded = b64(KEY);
        let text = format!("# config\nvalue: {encoded}\n");
        let findings = scan(&text, 2);
        assert_eq!(findings.len(), 1);
        let f = &findings[0];
        assert_eq!(f.secret, KEY);
        assert_eq!(f.decoded.as_deref(), Some(&["base64".to_string()][..]));
        assert_eq!(f.start_line, 2);
        assert_eq!(f.start_column, 8);
        assert_eq!(f.end_column as usize, 8 + encoded.len());
        assert_eq!(&text[f.start_offset as usize..f.end_offset as usize], encoded);
    }

    #[test]
    fn url_safe_base64_hex_and_percent_decode() {
        let url_safe = b64(&format!("{KEY}??>>")).replace('+', "-").replace('/', "_");
        assert!(url_safe.contains('_') || url_safe.contains('-'));
        assert_eq!(scan(&format!("a={url_safe}\n"), 1).len(), 1);
        assert_eq!(scan(&format!("a={}\n", hex(KEY)), 1)[0].decoded.as_deref(), Some(&["hex".to_string()][..]));
        let percent: String = KEY.bytes().map(|b| format!("%{b:02X}")).collect();
        assert_eq!(scan(&format!("a={percent}\n"), 1)[0].decoded.as_deref(), Some(&["percent".to_string()][..]));
    }

    #[test]
    fn double_encoding_needs_depth_two() {
        let double = b64(&b64(KEY));
        let text = format!("blob: {double}\n");
        assert!(scan(&text, 1).is_empty());
        let findings = scan(&text, 2);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].decoded.as_deref(), Some(&["base64".to_string(), "base64".to_string()][..]));
        assert_eq!(findings[0].start_line, 1);
        assert_eq!(findings[0].start_column, 7);
    }

    #[test]
    fn depth_limit_stops_recursion() {
        let triple = b64(&b64(&b64(KEY)));
        assert!(scan(&format!("blob: {triple}\n"), 2).is_empty());
        assert_eq!(scan(&format!("blob: {triple}\n"), 3).len(), 1);
    }

    #[test]
    fn depth_zero_disables_decoding() {
        assert!(scan(&format!("value: {}\n", b64(KEY)), 0).is_empty());
    }

    #[test]
    fn plain_secret_is_not_duplicated() {
        let findings = scan(&format!("plain {KEY}\nenc {}\n", b64(KEY)), 2);
        assert_eq!(findings.len(), 2);
        assert!(findings[0].decoded.is_none());
        assert!(findings[1].decoded.is_some());
    }

    #[test]
    fn memory_cap_bounds_decoded_bytes() {
        let rs = ruleset(OPENROUTER);
        let text = format!("value: {}\n", b64(KEY));
        let tight = DecodeOptions { max_depth: 2, max_bytes: KEY.len() - 1 };
        assert!(scan_text_with_decoding(&rs, Path::new("x"), &text, tight, DetectOptions::default()).is_empty());
        let fits = DecodeOptions { max_depth: 2, max_bytes: KEY.len() };
        assert_eq!(scan_text_with_decoding(&rs, Path::new("x"), &text, fits, DetectOptions::default()).len(), 1);

        // Many segments: the budget is shared, so only the first few get decoded.
        let many: String = (0..100).map(|_| format!("v: {}\n", b64(KEY))).collect();
        let mut budget = KEY.len() * 3;
        assert_eq!(find_segments(&many, 0, many.len(), &mut budget).len(), 3);
        assert_eq!(budget, 0);
    }

    #[test]
    fn rejects_binary_base64_and_hashes() {
        let mut budget = usize::MAX;
        // 1x1 PNG, sha256 hex, sha512 integrity hash, a JWT-free random blob.
        let samples = [
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
            "packages/tooling/secret-scanner/native/src",
            "this_is_a_really_long_identifier_name",
            "--some-long-command-line-flag",
        ];
        for s in samples {
            assert!(find_segments(s, 0, s.len(), &mut budget).is_empty(), "{s}");
        }
    }

    #[test]
    fn accepts_non_ascii_utf8() {
        let mut budget = usize::MAX;
        let text = b64("pässwört-geheimnis-ü");
        let segs = find_segments(&text, 0, text.len(), &mut budget);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].decoded, "pässwört-geheimnis-ü");
    }

    #[test]
    fn allow_comment_on_original_line_suppresses_decoded_finding() {
        assert!(scan(&format!("value: {} # gitleaks:allow\n", b64(KEY)), 2).is_empty());
    }

    #[test]
    fn nextline_pragma_does_not_leak_into_another_fragment() {
        // Both lines carry an encoded segment, so their fragments sit next to each other
        // in the decode buffer. The pragma only covers line 2 of the original file.
        let text = format!(
            "a: {} # pragma: allowlist nextline secret\nfiller\nb: {}\n",
            b64("just some harmless text"),
            b64(KEY)
        );
        let findings = scan(&text, 2);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].start_line, 3);
    }

    #[test]
    fn percent_run_does_not_duplicate_plain_secret() {
        let text = format!("url=https://x.test/?r=%2Fhome&token={KEY}&x=%20\n");
        let findings = scan(&text, 2);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].decoded.is_none());
    }

    #[test]
    fn percent_escape_that_completes_a_match_is_found() {
        let rs = ruleset(
            r#"{"rules":[{"id":"pw","regex":"password=(hunter2[a-z]+)","secretGroup":1,"keywords":["password"]}]}"#,
        );
        let text = "q=password%3Dhunter2secret&x=%20\n";
        let findings =
            scan_text_with_decoding(&rs, Path::new("a"), text, DecodeOptions::default(), DetectOptions::default());
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].secret, "hunter2secret");
        assert_eq!(findings[0].decoded.as_deref(), Some(&["percent".to_string()][..]));
    }

    #[test]
    fn pre_regex_replace_rules_do_not_panic_on_decoded_text() {
        // Length-changing replace + multibyte context on the same line as a segment.
        let rs = ruleset(
            r#"{"rules":[{"id":"r","regex":"sk-or-v1-[0-9a-f]{64}","keywords":["sk-or"],"preRegexReplace":[{"from":"ä","to":""}]}]}"#,
        );
        let text = format!("ääää ääää {} ääää sk-or-v1-{}\n", b64(KEY), "0123456789abcdef".repeat(4));
        let findings =
            scan_text_with_decoding(&rs, Path::new("a"), &text, DecodeOptions::default(), DetectOptions::default());
        assert!(findings.iter().all(|f| f.decoded.is_none()));
    }

    #[test]
    fn keeps_context_for_keyword_rules() {
        // `password: <base64>` — the keyword sits outside the encoded span.
        let rs = ruleset(
            r#"{"rules":[{"id":"pw","regex":"password: (hunter2[a-z]+)","secretGroup":1,"keywords":["password"]}]}"#,
        );
        let text = format!("data:\n  password: {}\n", b64("hunter2secretvalue"));
        let findings = scan_text_with_decoding(
            &rs,
            Path::new("s.yaml"),
            &text,
            DecodeOptions::default(),
            DetectOptions::default(),
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].secret, "hunter2secretvalue");
        assert_eq!(findings[0].start_line, 2);
    }
}
