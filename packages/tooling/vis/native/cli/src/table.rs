//! Borderless text tables laid out the way the Node CLI's table renderer lays
//! them out, so help output stays byte-identical.
//!
//! Two layouts exist. With `fixed` column widths (the command lists) every cell
//! is word-wrapped and then truncated with `…` to its column. Without them
//! (option lists, usage lines) column widths follow the content and shrink in
//! proportion when the table is wider than the terminal; cells then wrap and
//! may overflow if a single word does not fit.

use crate::width_tables;

/// One table cell. `text` may contain SGR colour codes; widths ignore them.
pub struct Cell {
    pub text: String,
    /// `false` keeps the text on one line (names are never wrapped).
    pub wrap: bool,
}

impl Cell {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into(), wrap: true }
    }

    pub fn unwrapped(text: impl Into<String>) -> Self {
        Self { text: text.into(), wrap: false }
    }
}

pub struct Layout {
    pub pad_left: usize,
    pub pad_right: usize,
    /// Terminal width the table must fit.
    pub width: usize,
    /// Fixed column widths, padding included.
    pub fixed: Option<Vec<usize>>,
}

/// Display width of `text` ignoring SGR escape sequences. Every character the
/// manifest contains is narrow except East Asian wide ones.
pub fn visible_width(text: &str) -> usize {
    let mut width = 0;
    let mut chars = text.chars();

    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            // Skip `ESC [ … <final byte>`.
            if chars.next() == Some('[') {
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }

            continue;
        }

        width += char_width(character);
    }

    width
}

fn in_ranges(code: u32, ranges: &[(u32, u32)]) -> bool {
    ranges
        .binary_search_by(|&(low, high)| {
            if code < low {
                std::cmp::Ordering::Greater
            } else if code > high {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Column width of one character, following the Node CLI's width rules: ASCII
/// and Latin-1 are narrow, East Asian wide and fullwidth are two columns, and
/// "ambiguous" characters (`—`, `→`, `≥`, ...) are also two columns there.
fn char_width(character: char) -> usize {
    let code = character as u32;

    match code {
        0x20..=0x7e | 0xa0..=0xff | 0x2500..=0x257f | 0x2026 => 1,
        0x200b | 0x200c | 0x200d | 0x2060 => 0,
        0..=0x1f | 0x7f..=0x9f => 0,
        0x1100..=0x11ff | 0x2e80..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff => 2,
        0xff00..=0xffef if !(0xff61..=0xff9f).contains(&code) => 2,
        _ if in_ranges(code, width_tables::AMBIGUOUS)
            || in_ranges(code, width_tables::FULLWIDTH)
            || in_ranges(code, width_tables::WIDE) =>
        {
            2
        }
        _ => 1,
    }
}

/// Greedy word wrap that keeps over-long words whole. Whitespace at a line start
/// is dropped and trailing spaces are trimmed.
fn wrap_line(line: &str, width: usize) -> Vec<String> {
    let trimmed = line.trim();

    if trimmed.is_empty() {
        return vec![String::new()];
    }

    // Tokens alternate between runs of non-whitespace and single whitespace characters.
    let mut tokens: Vec<&str> = Vec::new();
    let mut start = 0;
    let mut previous_space: Option<bool> = None;

    for (index, character) in trimmed.char_indices() {
        let is_space = character.is_whitespace();

        if previous_space.is_some() && (is_space || previous_space == Some(true)) {
            tokens.push(&trimmed[start..index]);
            start = index;
        }

        previous_space = Some(is_space);
    }

    tokens.push(&trimmed[start..]);

    let mut lines = Vec::new();
    let mut current = String::new();
    let mut used = 0;
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens[index];
        let is_space = token.chars().all(char::is_whitespace);
        let token_width = visible_width(token);

        if is_space && used == 0 {
            index += 1;

            continue;
        }

        if used + token_width > width && used > 0 {
            lines.push(current.trim_end_matches(' ').to_owned());
            current.clear();
            used = 0;

            continue;
        }

        current.push_str(token);
        used += token_width;
        index += 1;
    }

    if !current.is_empty() {
        lines.push(current.trim_end_matches(' ').to_owned());
    }

    lines
}

fn wrap(text: &str, width: usize) -> Vec<String> {
    if text.trim().is_empty() {
        return vec![String::new()];
    }

    text.split('\n').flat_map(|line| wrap_line(line.trim_end_matches('\r'), width)).collect()
}

/// Cut `line` to `limit` columns, ending in `…` when it had to be shortened.
fn truncate(line: &str, limit: usize) -> String {
    if line.is_empty() || limit == 0 {
        return String::new();
    }

    if visible_width(line) <= limit {
        return line.to_owned();
    }

    let mut kept = String::new();
    let mut used = 0;
    let mut open_style = false;
    let mut chars = line.chars().peekable();

    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            // Copy a complete `ESC [ … <final byte>` sequence without counting it.
            kept.push(character);

            if chars.next_if_eq(&'[').is_some() {
                kept.push('[');

                let mut parameters = String::new();

                for next in chars.by_ref() {
                    kept.push(next);

                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        if next == 'm' {
                            // `ESC[0m`, `ESC[m` and the `2x`/`39`/`49` closers end a style.
                            open_style = !matches!(parameters.as_str(), "" | "0" | "22" | "23" | "24" | "39" | "49");
                        }

                        break;
                    }

                    parameters.push(next);
                }
            }

            continue;
        }

        let character_width = char_width(character);

        if used + character_width > limit.saturating_sub(1) {
            break;
        }

        kept.push(character);
        used += character_width;
    }

    kept.push('…');

    if open_style {
        kept.push_str("\u{1b}[0m");
    }

    kept
}

/// Shrink `widths` proportionally so they sum to `available`.
fn shrink(widths: &[usize], available: usize) -> Vec<usize> {
    if available == 0 {
        return vec![1; widths.len()];
    }

    let total: usize = widths.iter().sum();

    if total == 0 {
        return vec![available / widths.len(); widths.len()];
    }

    let mut shares: Vec<usize> = widths
        .iter()
        .map(|&width| {
            let ratio = width as f64 / total as f64;

            1.max((available as f64 * ratio).floor() as usize)
        })
        .collect();

    let mut excess = shares.iter().sum::<usize>() as isize - available as isize;

    while excess > 0 {
        let mut widest: Option<usize> = None;

        for (index, &share) in shares.iter().enumerate() {
            if share > 1 && widest.is_none_or(|best| share > shares[best]) {
                widest = Some(index);
            }
        }

        let Some(index) = widest else { break };

        shares[index] -= 1;
        excess -= 1;
    }

    let remaining = available as isize - shares.iter().sum::<usize>() as isize;

    if remaining > 0 {
        let mut order: Vec<(usize, f64)> = widths
            .iter()
            .enumerate()
            .map(|(index, &width)| {
                let ratio = width as f64 / total as f64;

                (index, (available as f64 * ratio) % 1.0)
            })
            .collect();

        order.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal));

        for (index, _) in order.into_iter().take(remaining as usize) {
            shares[index] += 1;
        }
    }

    shares
}

/// Render `rows` as lines joined by `\n` (no trailing newline).
pub fn render(rows: &[Vec<Cell>], layout: &Layout) -> String {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);

    if columns == 0 {
        return String::new();
    }

    let padding = layout.pad_left + layout.pad_right;
    let truncating = layout.fixed.is_some();

    let widths = match &layout.fixed {
        Some(fixed) if fixed.len() == columns => fixed.clone(),
        _ => {
            let mut widths = vec![0; columns];

            for row in rows {
                for (column, cell) in row.iter().enumerate() {
                    let widest_line =
                        cell.text.split('\n').map(|line| visible_width(line.trim_end_matches('\r'))).max().unwrap_or(0);

                    widths[column] = widths[column].max(widest_line + padding);
                }
            }

            if widths.iter().sum::<usize>() > layout.width {
                widths = shrink(&widths, layout.width);
            }

            widths
        }
    };

    let mut out: Vec<String> = Vec::new();

    for row in rows {
        let mut rendered: Vec<Vec<String>> = Vec::with_capacity(columns);

        for (column, &width) in widths.iter().enumerate() {
            let Some(cell) = row.get(column) else {
                rendered.push(vec![" ".repeat(width)]);

                continue;
            };

            let content_width = width.saturating_sub(padding);

            if width <= padding {
                rendered.push(vec![" ".repeat(padding)]);

                continue;
            }

            let mut lines = if cell.wrap {
                wrap(&cell.text, content_width)
            } else {
                cell.text.split('\n').map(str::to_owned).collect()
            };

            if truncating {
                lines = lines.iter().map(|line| truncate(line, content_width)).collect();
            }

            rendered.push(
                lines
                    .iter()
                    .map(|line| {
                        let pad = content_width.saturating_sub(visible_width(line));

                        format!(
                            "{}{line}{}{}",
                            " ".repeat(layout.pad_left),
                            " ".repeat(pad),
                            " ".repeat(layout.pad_right)
                        )
                    })
                    .collect(),
            );
        }

        let height = rendered.iter().map(Vec::len).max().unwrap_or(1);

        for line in 0..height {
            let mut text = String::new();

            for (column, cell_lines) in rendered.iter().enumerate() {
                match cell_lines.get(line) {
                    Some(cell_line) => text.push_str(cell_line),
                    None => text.push_str(&" ".repeat(widths[column])),
                }
            }

            out.push(text);
        }
    }

    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_on_spaces_and_keeps_long_words_whole() {
        assert_eq!(wrap("aaa bbb ccc", 7), vec!["aaa bbb", "ccc"]);
        assert_eq!(wrap("aaaaaaaaaa bb", 4), vec!["aaaaaaaaaa", "bb"]);
    }

    #[test]
    fn truncation_keeps_escape_sequences_whole_and_resets_the_style() {
        let line = "\u{1b}[32mabcdefghijklmnopqrstuvwxyz\u{1b}[39m";

        assert_eq!(truncate(line, 20), "\u{1b}[32mabcdefghijklmnopqrs…\u{1b}[0m");
        assert_eq!(visible_width(&truncate(line, 20)), 20);
        assert_eq!(truncate("abcdefghijklmnopqrstuvwxyz", 20), "abcdefghijklmnopqrs…");
        assert_eq!(truncate(line, 40), line);
    }

    #[test]
    fn width_ignores_colour_codes() {
        assert_eq!(visible_width("\u{1b}[1m\u{1b}[33m--ci\u{1b}[39m\u{1b}[22m"), 4);
    }

    #[test]
    fn truncates_with_an_ellipsis() {
        assert_eq!(truncate("abcdefghij", 5), "abcd…");
        assert_eq!(truncate("abc", 5), "abc");
    }

    #[test]
    fn fixed_layout_pads_every_cell_to_its_column() {
        let rows = vec![vec![Cell::unwrapped("run"), Cell::new("Run a target")]];
        let layout = Layout { pad_left: 4, pad_right: 1, width: 40, fixed: Some(vec![9, 31]) };
        let line = render(&rows, &layout);

        assert!(line.starts_with("    run  "), "{line:?}");
        assert!(line.contains("    Run a target"), "{line:?}");
        assert_eq!(visible_width(&line), 40);
    }

    #[test]
    fn ambiguous_width_characters_take_two_columns() {
        assert_eq!(visible_width("a—b"), 4);
        assert_eq!(visible_width("a…b"), 3);
    }
}
