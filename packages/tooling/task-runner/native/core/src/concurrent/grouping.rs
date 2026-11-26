//! Folding a batch of events into fewer, larger items for the host.
//!
//! A host that turns every event into an object of its own pays for it per event: on Node, building
//! one napi object per output line is the dominant cost of a run that prints a lot. Adjacent output
//! events of one command and one stream are therefore folded into a single [`Delivered::Lines`]
//! whose text holds the lines joined with `\n`; the host splits it again. Nothing is reordered,
//! nothing is merged across a lifecycle event or across commands or streams, and splitting the
//! joined text gives back exactly the lines that went in.

use super::types::ProcessEvent;

/// The most bytes of text folded into one group. A line longer than this is a group of its own, so
/// a batch of very long lines is not copied into one enormous string.
pub const MAX_GROUP_BYTES: usize = 256 * 1024;

/// One item of a delivered batch.
#[derive(Debug, Clone, PartialEq)]
pub enum Delivered {
    /// An event passed through as it came.
    Event(ProcessEvent),
    /// `count` output events of command `index` on one stream, as `text` joined with `\n`.
    /// `count` is at least 2: a lone event stays an [`Delivered::Event`].
    Lines { index: u32, stderr: bool, text: String, count: u32 },
}

/// What kind of output event `event` is, with its text: `(index, stderr, text)`.
fn output_of(event: &ProcessEvent) -> Option<(u32, bool, &str)> {
    match event {
        ProcessEvent::Stdout { index, text } => Some((*index, false, text)),
        ProcessEvent::Stderr { index, text } => Some((*index, true, text)),
        _ => None,
    }
}

/// Whether `event` can be folded into a group at all. The text of a folded event must not contain
/// the `\n` the host splits on. Lines never do, but a pty delivers raw chunks that can, and those
/// stay events of their own.
fn is_foldable(event: &ProcessEvent) -> bool {
    output_of(event).is_some_and(|(_, _, text)| !text.contains('\n'))
}

/// Fold adjacent output events that share a command and a stream into [`Delivered::Lines`],
/// keeping the order of everything. A group holds at most [`MAX_GROUP_BYTES`] of text (a single
/// longer line is its own group) and each is passed through as the original event when it is alone.
pub fn group_output(events: Vec<ProcessEvent>) -> Vec<Delivered> {
    let mut delivered: Vec<Delivered> = Vec::with_capacity(events.len());

    for event in events {
        if is_foldable(&event) {
            if let Some(Delivered::Lines { .. } | Delivered::Event(_)) = delivered.last() {
                if try_fold(delivered.last_mut().expect("just matched a last item"), &event) {
                    continue;
                }
            }
        }

        delivered.push(Delivered::Event(event));
    }

    delivered
}

/// Add `event` to `last` when they belong to the same group. A lone event becomes a group the
/// moment a second joins it. False when `event` does not belong.
fn try_fold(last: &mut Delivered, event: &ProcessEvent) -> bool {
    let Some((index, stderr, text)) = output_of(event) else {
        return false;
    };

    match last {
        Delivered::Lines { index: last_index, stderr: last_stderr, text: joined, count } => {
            if *last_index != index || *last_stderr != stderr || joined.len() + 1 + text.len() > MAX_GROUP_BYTES {
                return false;
            }

            joined.push('\n');
            joined.push_str(text);
            *count += 1;

            true
        }
        Delivered::Event(first) => {
            if !is_foldable(first) {
                return false;
            }

            let Some((first_index, first_stderr, first_text)) = output_of(first) else {
                return false;
            };

            if first_index != index || first_stderr != stderr || first_text.len() + 1 + text.len() > MAX_GROUP_BYTES {
                return false;
            }

            let mut joined = String::with_capacity(first_text.len() + 1 + text.len() + 4096.min(MAX_GROUP_BYTES));

            joined.push_str(first_text);
            joined.push('\n');
            joined.push_str(text);

            *last = Delivered::Lines { index, stderr, text: joined, count: 2 };

            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(index: u32, text: &str) -> ProcessEvent {
        ProcessEvent::Stdout { index, text: text.to_string() }
    }

    fn err(index: u32, text: &str) -> ProcessEvent {
        ProcessEvent::Stderr { index, text: text.to_string() }
    }

    fn lines(index: u32, stderr: bool, text: &str, count: u32) -> Delivered {
        Delivered::Lines { index, stderr, text: text.to_string(), count }
    }

    /// What a host that splits the joined text sees: the original events, in order.
    fn unfold(delivered: Vec<Delivered>) -> Vec<ProcessEvent> {
        delivered
            .into_iter()
            .flat_map(|item| match item {
                Delivered::Event(event) => vec![event],
                Delivered::Lines { index, stderr, text, count } => {
                    let parts: Vec<&str> = text.split('\n').collect();

                    assert_eq!(parts.len(), count as usize, "count must match the number of joined lines");

                    parts.into_iter().map(|part| if stderr { err(index, part) } else { out(index, part) }).collect()
                }
            })
            .collect()
    }

    #[test]
    fn adjacent_lines_of_one_stream_become_one_group() {
        let grouped = group_output(vec![out(0, "a"), out(0, "b"), out(0, "c")]);

        assert_eq!(grouped, vec![lines(0, false, "a\nb\nc", 3)]);
    }

    #[test]
    fn a_lone_line_stays_an_event() {
        assert_eq!(group_output(vec![out(0, "a")]), vec![Delivered::Event(out(0, "a"))]);
    }

    #[test]
    fn another_stream_or_command_ends_the_group() {
        let grouped = group_output(vec![out(0, "a"), out(0, "b"), err(0, "c"), err(0, "d"), err(1, "e"), out(1, "f")]);

        assert_eq!(
            grouped,
            vec![
                lines(0, false, "a\nb", 2),
                lines(0, true, "c\nd", 2),
                Delivered::Event(err(1, "e")),
                Delivered::Event(out(1, "f")),
            ]
        );
    }

    #[test]
    fn a_lifecycle_event_is_never_folded_over() {
        let started = ProcessEvent::Started { index: 0, pid: Some(1) };
        let grouped = group_output(vec![
            started.clone(),
            out(0, "a"),
            out(0, "b"),
            ProcessEvent::Error { index: 0, message: "m".to_string() },
            out(0, "c"),
        ]);

        assert_eq!(
            grouped,
            vec![
                Delivered::Event(started),
                lines(0, false, "a\nb", 2),
                Delivered::Event(ProcessEvent::Error { index: 0, message: "m".to_string() }),
                Delivered::Event(out(0, "c")),
            ]
        );
    }

    #[test]
    fn empty_lines_survive_the_round_trip() {
        let input = vec![out(0, ""), out(0, "a"), out(0, ""), out(0, "")];

        assert_eq!(unfold(group_output(input.clone())), input);
    }

    #[test]
    fn a_chunk_with_a_newline_in_it_is_never_joined() {
        // A pty chunk can hold newlines, so joining it with `\n` would not split back to it.
        let grouped = group_output(vec![out(0, "a"), out(0, "b\r\nc\r\n"), out(0, "d"), out(0, "e")]);

        assert_eq!(
            grouped,
            vec![Delivered::Event(out(0, "a")), Delivered::Event(out(0, "b\r\nc\r\n")), lines(0, false, "d\ne", 2),]
        );
    }

    #[test]
    fn a_group_stops_at_the_byte_cap_and_a_longer_line_stands_alone() {
        let half = "x".repeat(MAX_GROUP_BYTES / 2 - 1);
        let huge = "y".repeat(MAX_GROUP_BYTES + 1);
        let input = vec![out(0, &half), out(0, &half), out(0, &half), out(0, &huge), out(0, "z")];
        let grouped = group_output(input.clone());

        assert!(matches!(&grouped[0], Delivered::Lines { count: 2, .. }), "{grouped:?}");
        assert_eq!(grouped[1], Delivered::Event(out(0, &half)));
        assert_eq!(grouped[2], Delivered::Event(out(0, &huge)));
        assert_eq!(grouped[3], Delivered::Event(out(0, "z")));
        assert_eq!(unfold(grouped), input);
    }

    #[test]
    fn grouping_keeps_every_event_once_in_order() {
        let mut input = Vec::new();

        for round in 0..300 {
            let index = round % 3;

            for line in 0..(round % 7 + 1) {
                input.push(if round % 2 == 0 {
                    out(index, &format!("{round}-{line}"))
                } else {
                    err(index, &format!("{round}-{line}"))
                });
            }

            if round % 50 == 0 {
                input.push(ProcessEvent::Started { index, pid: None });
            }
        }

        assert_eq!(unfold(group_output(input.clone())), input);
    }
}
