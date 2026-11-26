//! The NS lookup of the expired-domains marshall (`resolveNs` of Node's resolver, against `1.1.1.1` then `8.8.8.8`),
//! reduced to what `vis add` needs: whether the domain has name servers.
//!
//! The marshall reports a domain that has none (an error) and one it could not look up (a warning), and either makes
//! `vis add` show a table, which is Node's. So the lookup answers `true` only for a clean answer, an NS record in the
//! answer section of a `NOERROR` reply, and `false` for everything else: no record, another status, a truncated or malformed
//! reply, and no answer in time. A lookup that ends without a record is left to Node, which finds the same answer or the same
//! silence and reports it.

use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

/// `DEFAULT_DNS_SERVERS`.
pub(super) const SERVERS: [&str; 2] = ["1.1.1.1:53", "8.8.8.8:53"];
/// `DEFAULT_PER_DOMAIN_TIMEOUT_MS`: the time the whole lookup may take.
pub(super) const BUDGET: Duration = Duration::from_millis(4000);

const TYPE_NS: u16 = 2;
const CLASS_IN: u16 = 1;

/// The query for the NS records of `domain`: a header with the recursion-desired flag, and one question. `None` for a
/// name that is not made of plain labels.
fn query(id: u16, domain: &str) -> Option<Vec<u8>> {
    if domain.is_empty() || domain.len() > 253 {
        return None;
    }

    let mut packet = Vec::with_capacity(18 + domain.len());

    packet.extend_from_slice(&id.to_be_bytes());
    // Standard query, recursion desired; one question and nothing else.
    packet.extend_from_slice(&[0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    for label in domain.split('.') {
        let valid = (1..=63).contains(&label.len())
            && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-');

        if !valid {
            return None;
        }

        packet.push(u8::try_from(label.len()).ok()?);
        packet.extend_from_slice(label.as_bytes());
    }

    packet.push(0);
    packet.extend_from_slice(&TYPE_NS.to_be_bytes());
    packet.extend_from_slice(&CLASS_IN.to_be_bytes());

    Some(packet)
}

/// The offset after the name that starts at `at`: labels up to a zero byte, or a compression pointer.
fn skip_name(packet: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let length = *packet.get(at)?;

        match length {
            0 => return Some(at + 1),
            length if length & 0xC0 == 0xC0 => return packet.get(at + 1).map(|_| at + 2),
            length if length & 0xC0 == 0 => at += 1 + usize::from(length),
            _ => return None,
        }
    }
}

/// Whether `reply` answers the query with `id` for `domain` with at least one NS record and no error.
fn has_name_servers(reply: &[u8], id: u16) -> bool {
    let word = |at: usize| reply.get(at..at + 2).map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]));
    let Some((reply_id, flags, questions, answers)) =
        word(0).zip(word(2)).zip(word(4)).zip(word(6)).map(|(((a, b), c), d)| (a, b, c, d))
    else {
        return false;
    };
    // A response, to this query, with no error and nothing cut off.
    let is_clean = reply_id == id && flags & 0x8000 != 0 && flags & 0x0200 == 0 && flags & 0x000F == 0;

    if !is_clean || questions != 1 {
        return false;
    }

    let Some(mut at) = skip_name(reply, 12).map(|end| end + 4) else { return false };

    for _ in 0..answers {
        let Some(after_name) = skip_name(reply, at) else { return false };
        let (Some(kind), Some(length)) = (word(after_name), word(after_name + 8)) else { return false };

        if kind == TYPE_NS && word(after_name + 2) == Some(CLASS_IN) {
            return true;
        }

        at = after_name + 10 + usize::from(length);
    }

    false
}

/// Asks each server in turn, for what is left of `budget`, and answers `true` as soon as one reports name servers.
pub(super) fn has_ns_records(domain: &str, servers: &[SocketAddr], budget: Duration) -> bool {
    let mut id_bytes = [0_u8; 16];

    if crate::js::fill_random(&mut id_bytes).is_none() {
        return false;
    }

    let id = u16::from_be_bytes([id_bytes[0], id_bytes[1]]);
    let Some(packet) = query(id, domain) else { return false };
    let deadline = Instant::now() + budget;

    for server in servers {
        let left = deadline.saturating_duration_since(Instant::now());

        if left.is_zero() {
            return false;
        }

        let bind = if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
        let Ok(socket) = UdpSocket::bind(bind) else { return false };

        // Each server gets half of what is left, so a silent first one does not use up the second one's time.
        if socket.set_read_timeout(Some(left / 2 + Duration::from_millis(1))).is_err()
            || socket.send_to(&packet, server).is_err()
        {
            continue;
        }

        let mut reply = [0_u8; 1500];

        while let Ok((length, from)) = socket.recv_from(&mut reply) {
            if from == *server {
                if has_name_servers(&reply[..length], id) {
                    return true;
                }

                break;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use std::thread;

    use super::*;

    /// A reply to `query` with the given status and answers (as `(type, rdata)`), the owner name compressed.
    fn reply(query: &[u8], rcode: u8, answers: &[(u16, &[u8])]) -> Vec<u8> {
        let mut packet = query.to_vec();

        packet[2] = 0x81;
        packet[3] = 0x80 | rcode;
        packet[6..8].copy_from_slice(&u16::try_from(answers.len()).unwrap().to_be_bytes());

        for (kind, data) in answers {
            packet.extend_from_slice(&[0xC0, 12]);
            packet.extend_from_slice(&kind.to_be_bytes());
            packet.extend_from_slice(&CLASS_IN.to_be_bytes());
            packet.extend_from_slice(&[0, 0, 0, 60]);
            packet.extend_from_slice(&u16::try_from(data.len()).unwrap().to_be_bytes());
            packet.extend_from_slice(data);
        }

        packet
    }

    #[test]
    fn the_query_is_one_ns_question() {
        assert_eq!(
            query(0x1234, "example.test").unwrap(),
            [
                &[0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0][..],
                &[7],
                b"example",
                &[4],
                b"test",
                &[0, 0, 2, 0, 1],
            ]
            .concat()
        );

        for odd in
            ["", "a..b", "-a.test", "a-.test", "caf\u{e9}.test", &"a".repeat(64), &format!("{}.test", "a.".repeat(130))]
        {
            assert!(query(1, odd).is_none(), "{odd:?}");
        }
    }

    #[test]
    fn only_a_clean_answer_with_an_ns_record_counts() {
        let packet = query(7, "example.test").unwrap();
        let ns = [3, b'n', b's', b'1', 0];
        let counts = |reply: &[u8]| has_name_servers(reply, 7);

        assert!(counts(&reply(&packet, 0, &[(TYPE_NS, &ns)])));
        // An A record before the NS record, and a compressed name server.
        assert!(counts(&reply(&packet, 0, &[(1, &[1, 2, 3, 4]), (TYPE_NS, &[0xC0, 12])])));

        assert!(!counts(&reply(&packet, 0, &[])));
        assert!(!counts(&reply(&packet, 0, &[(1, &[1, 2, 3, 4])])));
        assert!(!counts(&reply(&packet, 3, &[])));
        assert!(!counts(&reply(&packet, 2, &[(TYPE_NS, &ns)])));
        assert!(!has_name_servers(&reply(&packet, 0, &[(TYPE_NS, &ns)]), 8));

        // Cut off, not a response, truncated, or garbage.
        let mut truncated = reply(&packet, 0, &[(TYPE_NS, &ns)]);

        truncated[2] |= 0x02;

        assert!(!counts(&truncated));

        let mut query_only = reply(&packet, 0, &[(TYPE_NS, &ns)]);

        query_only[2] &= 0x7F;

        assert!(!counts(&query_only));
        assert!(!counts(&reply(&packet, 0, &[(TYPE_NS, &ns)])[..20]));
        assert!(!counts(&[]));
    }

    /// A UDP server on loopback that answers each query with `answer(query)`, or not at all for `None`.
    fn serve(answer: impl Fn(&[u8]) -> Option<Vec<u8>> + Send + 'static) -> SocketAddr {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let address = socket.local_addr().unwrap();

        thread::spawn(move || {
            let mut buffer = [0_u8; 512];

            while let Ok((length, from)) = socket.recv_from(&mut buffer) {
                if let Some(reply) = answer(&buffer[..length]) {
                    drop(socket.send_to(&reply, from));
                }
            }
        });

        address
    }

    #[test]
    fn the_lookup_asks_each_server_in_turn_within_its_budget() {
        let ns = [3, b'n', b's', b'1', 0];
        let good = serve(move |query| Some(reply(query, 0, &[(TYPE_NS, &ns)])));
        let missing = serve(|query| Some(reply(query, 3, &[])));
        let silent = serve(|_| None);
        let budget = Duration::from_millis(1500);

        assert!(has_ns_records("example.test", &[good], budget));
        // A server that is silent or that says no does not end the lookup while another has an answer.
        assert!(has_ns_records("example.test", &[silent, good], budget));
        assert!(has_ns_records("example.test", &[missing, good], budget));
        assert!(!has_ns_records("example.test", &[missing], budget));
        assert!(!has_ns_records("example.test", &[silent], Duration::from_millis(300)));
        assert!(!has_ns_records("not a name", &[good], budget));
    }
}
