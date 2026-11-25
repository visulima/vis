//! Wire format of the injected file-access trackers.
//!
//! The macOS dylib and the Windows DLL run inside the tracked process and report
//! each access to the parent as one message: `[u8 op][path bytes]`. On macOS a
//! message is one `SOCK_DGRAM` datagram, on Windows one `PIPE_TYPE_MESSAGE`
//! record, so the transport already frames it and there is no length prefix.
//!
//! This crate is the single owner of that format: the opcodes, the frame
//! encode/decode, the size caps and the names both ends must agree on. The
//! encode path never allocates and never panics, because it runs inside
//! arbitrary processes, where a panic would take the host down.
//!
//! Path bytes are opaque here. The macOS parent treats them as raw OS bytes and
//! the Windows parent as (lossy) UTF-8, so interpreting them stays with the
//! caller.
//!
//! The Linux tracker has no injected library: the kernel delivers
//! notifications, so it has nothing to share.

/// One-byte opcode that prefixes every message: what the tracked process did to
/// the path.
pub mod op {
    pub const READ: u8 = 0;
    pub const WRITE: u8 = 1;
    pub const STAT: u8 = 2;
    pub const READDIR: u8 = 3;
    /// A lookup that failed with `ENOENT`: the path did not exist when probed.
    /// Only the macOS tracker sends it.
    pub const MISSING: u8 = 4;
}

/// Bytes the opcode takes at the start of a message.
pub const HEADER_LEN: usize = 1;

/// Longest path a macOS datagram carries (`PATH_MAX`). A longer path is
/// truncated by the sender; the parent treats the result as a best-effort hint.
pub const DATAGRAM_PATH_MAX: usize = 1024;

/// Size of the buffer that holds one macOS datagram, for both the sender and
/// the receiver.
pub const DATAGRAM_MAX: usize = HEADER_LEN + DATAGRAM_PATH_MAX;

/// Size of the buffer the Windows parent reads one pipe message into.
pub const PIPE_MESSAGE_MAX: usize = HEADER_LEN + 32 * 1024;

/// Environment variable that tells the macOS dylib which inherited fd is the
/// reporting socket, as the parent sets it.
pub const ENV_MACOS_FD: &str = "FSPY_MACOS_FD";

/// [`ENV_MACOS_FD`] as a NUL-terminated C string, for `getenv` in the dylib
/// (which must not allocate while it initialises).
pub const ENV_MACOS_FD_C: &[u8] = b"FSPY_MACOS_FD\0";

/// The kind of access an opcode stands for, in the vocabulary the TypeScript
/// caller uses. An opcode this version does not know reads as `"read"`, so a
/// newer sender never makes the parent drop a path.
pub fn kind_name(op: u8) -> &'static str {
    match op {
        op::WRITE => "write",
        op::STAT => "stat",
        op::READDIR => "readdir",
        op::MISSING => "missing",
        _ => "read",
    }
}

/// Name of the per-spawn named pipe for the tracked process `pid`. The parent
/// creates the server before it resumes the suspended child, and the DLL
/// derives the same name from its own PID, so no environment plumbing is needed.
pub fn pipe_name(pid: u32) -> String {
    format!(r"\\.\pipe\fspy-{pid}")
}

/// Write `op` at the start of `buf` and return the rest of it, where the caller
/// can build the path in place. The frame is then `buf[..HEADER_LEN + n]` for
/// `n` path bytes written. Returns an empty slice when `buf` has no room for
/// the opcode.
pub fn begin(buf: &mut [u8], op: u8) -> &mut [u8] {
    match buf.split_first_mut() {
        Some((head, rest)) => {
            *head = op;

            rest
        }
        None => &mut [],
    }
}

/// Write `[op][path]` into `out` and return the frame length. A path that does
/// not fit is truncated to what does. Returns `0` (nothing written) when `out`
/// is empty.
pub fn encode(out: &mut [u8], op: u8, path: &[u8]) -> usize {
    let room = begin(out, op);
    let n = path.len().min(room.len());

    room[..n].copy_from_slice(&path[..n]);

    if out.is_empty() {
        0
    } else {
        HEADER_LEN + n
    }
}

/// A message split into its opcode and (opaque) path bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame<'a> {
    /// The raw opcode, never reduced to a kind: callers de-duplicate on it, and
    /// two opcodes that map to the same [`kind_name`] stay distinct.
    pub op: u8,
    pub path: &'a [u8],
}

/// Split a received message. `None` for a message with no path (empty, or an
/// opcode alone): there is nothing to report, so the receivers skip it.
pub fn decode(message: &[u8]) -> Option<Frame<'_>> {
    match message.split_first() {
        Some((&op, path)) if !path.is_empty() => Some(Frame { op, path }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_then_decode_round_trips_every_opcode() {
        for op in [op::READ, op::WRITE, op::STAT, op::READDIR, op::MISSING, 200] {
            let mut buf = [0_u8; DATAGRAM_MAX];
            let n = encode(&mut buf, op, b"/work/src/main.rs");

            let frame = decode(&buf[..n]).unwrap();

            assert_eq!(frame, Frame { op, path: b"/work/src/main.rs" });
        }
    }

    #[test]
    fn the_wire_layout_is_the_opcode_then_the_path_bytes() {
        let mut buf = [0xff_u8; 8];
        let n = encode(&mut buf, op::STAT, b"ab");

        assert_eq!(&buf[..n], [2, b'a', b'b']);
        // Bytes past the frame are untouched.
        assert_eq!(buf[n], 0xff);
    }

    #[test]
    fn opcodes_keep_their_wire_values() {
        // The injected library and the parent are built and shipped separately.
        assert_eq!([op::READ, op::WRITE, op::STAT, op::READDIR, op::MISSING], [0, 1, 2, 3, 4]);
    }

    #[test]
    fn a_path_that_does_not_fit_is_truncated_not_dropped() {
        let mut buf = [0_u8; 4];
        let n = encode(&mut buf, op::READ, b"abcdef");

        assert_eq!(&buf[..n], [0, b'a', b'b', b'c']);
    }

    #[test]
    fn a_path_of_exactly_the_cap_is_not_truncated() {
        let path = [b'x'; DATAGRAM_PATH_MAX];
        let mut buf = [0_u8; DATAGRAM_MAX];
        let n = encode(&mut buf, op::WRITE, &path);

        assert_eq!(n, DATAGRAM_MAX);
        assert_eq!(decode(&buf[..n]).unwrap().path, path);
    }

    #[test]
    fn encode_never_panics_on_degenerate_buffers() {
        assert_eq!(encode(&mut [], op::READ, b"abc"), 0);
        assert_eq!(encode(&mut [9], op::READ, b"abc"), 1);
        assert_eq!(encode(&mut [9, 9], op::READ, b""), 1);
    }

    #[test]
    fn begin_writes_the_opcode_and_hands_back_the_payload_area() {
        let mut buf = [0_u8; 4];
        let room = begin(&mut buf, op::READDIR);

        assert_eq!(room.len(), 3);

        room[0] = b'p';

        assert_eq!(buf, [3, b'p', 0, 0]);
        assert!(begin(&mut [], op::READ).is_empty());
    }

    #[test]
    fn a_message_without_a_path_does_not_decode() {
        assert_eq!(decode(&[]), None);
        assert_eq!(decode(&[op::WRITE]), None);
        assert_eq!(decode(&[op::WRITE, b'a']).unwrap().path, b"a");
    }

    #[test]
    fn decode_keeps_non_utf8_path_bytes() {
        let frame = decode(&[op::READ, 0xff, 0xfe, b'/']).unwrap();

        assert_eq!(frame.path, [0xff, 0xfe, b'/']);
    }

    #[test]
    fn kind_names_match_what_the_typescript_side_expects() {
        assert_eq!(kind_name(op::READ), "read");
        assert_eq!(kind_name(op::WRITE), "write");
        assert_eq!(kind_name(op::STAT), "stat");
        assert_eq!(kind_name(op::READDIR), "readdir");
        assert_eq!(kind_name(op::MISSING), "missing");
        // Unknown opcodes read as "read".
        assert_eq!(kind_name(5), "read");
        assert_eq!(kind_name(255), "read");
    }

    #[test]
    fn opcodes_that_share_a_kind_stay_distinct_in_the_frame() {
        let a = decode(&[5, b'p']).unwrap();
        let b = decode(&[op::READ, b'p']).unwrap();

        assert_eq!(kind_name(a.op), kind_name(b.op));
        assert_ne!(a.op, b.op);
    }

    #[test]
    fn the_pipe_name_is_derived_from_the_pid() {
        assert_eq!(pipe_name(4242), r"\\.\pipe\fspy-4242");
    }

    #[test]
    fn the_c_string_env_name_matches_the_str_one() {
        assert_eq!(ENV_MACOS_FD_C, format!("{ENV_MACOS_FD}\0").as_bytes());
    }
}
