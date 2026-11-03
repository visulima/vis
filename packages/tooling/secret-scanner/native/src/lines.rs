// Byte offset <-> line / column helpers shared by the detector and the decode pass.

/// Byte offset of the start of every line: `0`, then one past each `\n`.
pub fn compute_line_offsets(s: &str) -> Vec<usize> {
    let mut v = vec![0usize];
    for (i, b) in s.bytes().enumerate() {
        if b == b'\n' {
            v.push(i + 1);
        }
    }
    v
}

/// Byte offsets → 1-based line + codepoint column. Columns count **characters**, not bytes,
/// so multi-byte UTF-8 sequences line up with what editors/LSPs expect.
///
/// The `.get(…).copied().unwrap_or(0)` guards are belt-and-braces — `compute_line_offsets`
/// always pushes `0` first, so `partition_point` returns ≥ 1 for any valid byte offset. We
/// still avoid bare `[idx]` here: the offsets slice may come from a future caller that
/// forgets the invariant, and a corrupt index on user-controlled content is not worth a
/// panic when emitting `1` is a correct fallback.
pub fn offset_to_line_col(offsets: &[usize], start: usize, end: usize, content: &str) -> (u32, u32, u32, u32) {
    let sl = offsets.partition_point(|&o| o <= start);
    let el = offsets.partition_point(|&o| o <= end);
    let start_line_offset = offsets.get(sl.saturating_sub(1)).copied().unwrap_or(0);
    let end_line_offset = offsets.get(el.saturating_sub(1)).copied().unwrap_or(0);
    let sc = codepoint_col(content, start_line_offset, start);
    let ec = codepoint_col(content, end_line_offset, end);
    (sl.max(1) as u32, sc, el.max(1) as u32, ec)
}

fn codepoint_col(content: &str, line_start: usize, offset: usize) -> u32 {
    let end = offset.min(content.len());
    if line_start >= end {
        return 1;
    }
    // Character count of the slice `[line_start..offset]`, +1 for 1-based columns.
    (content[line_start..end].chars().count() as u32) + 1
}

/// Text of the 1-based `line`, without its trailing `\n`.
pub fn line_slice<'a>(content: &'a str, offsets: &[usize], line: u32) -> &'a str {
    let idx = (line as usize).saturating_sub(1);
    let start = offsets.get(idx).copied().unwrap_or(0);
    let end = offsets.get(idx + 1).copied().unwrap_or(content.len());
    content[start..end].trim_end_matches('\n')
}
