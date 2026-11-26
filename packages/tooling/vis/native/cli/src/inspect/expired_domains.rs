//! The `expiredDomains` marshall: `src/security/marshalls/expired-domains.ts` for one package.
//!
//! Node takes the maintainer addresses of the inspected version (`_npmUser`, then `maintainers`), looks at the domain of
//! each, and asks a resolver for its NS records: records mean the domain is registered, "no such domain" (NXDOMAIN) or "no
//! data" (NOERROR without NS records) mean it lapsed, and every other failure is a warning that the domain could not be
//! verified. The answer per domain is cached for 24 hours (`<cache>/expired-domains/<first 12 hex of sha256(domain)>.json`)
//! except a failure.
//!
//! # The resolver
//!
//! Node does not use the system resolver: `new Resolver()` with `setServers(["1.1.1.1", "8.8.8.8"])` (c-ares) sends the NS
//! query of the domain, as written, to the first server over UDP. `/etc/hosts`, the search domains and the system's own
//! servers play no part. This module sends the same query (one question, type NS, class IN, recursion desired, no EDNS)
//! to the first server and reads the answer the way c-ares does for the three answers it classifies, which was checked
//! against Node's own resolver (see `__tests__/native/inspect-dns.test.ts` and `tests/fixtures/dns-scenarios.json`):
//!
//! | answer | Node |
//! | --- | --- |
//! | NOERROR with NS records in the answer section | registered |
//! | NXDOMAIN | lapsed |
//! | NOERROR with no answer record (an NS record only in the authority section, or none) | lapsed |
//!
//! Node asks the first server only; it asks the second when the first does not answer in time (checked with two stubs in
//! `inspect-dns.test.ts`: a clean answer of the first is final whatever the second says, and so is a SERVFAIL, which
//! is a failure that Node reports as "could not verify"). So the first server's clean answer is Node's answer. Everything
//! else goes to Node before anything is printed or written: no answer in time (Node would ask the second server), a
//! failed send, a truncated answer (Node retries over TCP), SERVFAIL, REFUSED or any other code, an answer whose id,
//! question or records are not read strictly, an answer record that is not an NS record of the domain (a CNAME), a domain
//! that is not a plain ASCII host name of two or more labels (Node hands c-ares whatever it is, and c-ares fails on some of
//! them), and a machine whose resolver settings rotate the servers (`RES_OPTIONS` set, or `rotate` in `/etc/resolv.conf`),
//! where Node does not ask the first server first. The search list and `LOCALDOMAIN` play no part (`resolveNs` asks the
//! name as written; checked). A domain with a fresh cache entry needs no query, so it is read from the cache whatever it
//! looks like, as long as it is ASCII.

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::archived_repo::version_entry;
use super::marshalls::{Finding, Severity, Target};
use super::packument::{Cached, View};
use super::{service_cache, CacheAction};
use crate::js::trim;
use crate::keys_refresh::Js;

/// `DEFAULT_TTL_MS`: 24 hours.
const TTL_MS: u64 = 24 * 60 * 60 * 1000;

/// The resolver Node asks first (`DEFAULT_DNS_SERVERS[0]`).
pub(super) const SERVER: &str = "1.1.1.1:53";

/// How long one query waits for the answer. Node waits 4 seconds for a domain in all; an answer later than this is Node's.
pub(super) const WAIT: Duration = Duration::from_secs(2);

/// What a lookup found out about a domain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    Registered,
    Lapsed,
}

pub(super) fn cache_file(cache_dir: &str, domain: &str) -> PathBuf {
    let digest = Sha256::digest(domain.as_bytes());
    let name: String = digest.iter().take(6).map(|byte| format!("{byte:02x}")).collect();

    Path::new(cache_dir).join("expired-domains").join(format!("{name}.json"))
}

/// The wire form of DNS, for one NS question and the answers this module reads.
mod wire {
    use super::Outcome;

    const TYPE_NS: u16 = 2;
    const CLASS_IN: u16 = 1;

    /// A host name of two or more labels of letters, digits and hyphens (none starting or ending with one), at most 253
    /// characters: what every resolver reads the same way.
    pub(super) fn is_plain_name(name: &str) -> bool {
        let labels: Vec<&str> = name.split('.').collect();

        name.len() <= 253
            && labels.len() >= 2
            && labels.iter().all(|label| {
                (1..=63).contains(&label.len())
                    && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    && !label.starts_with('-')
                    && !label.ends_with('-')
            })
    }

    /// The query: header (id, recursion desired, one question), then the name, the type and the class.
    pub(super) fn query(id: u16, name: &str) -> Vec<u8> {
        let mut out = Vec::with_capacity(18 + name.len());

        out.extend_from_slice(&id.to_be_bytes());
        out.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);

        for label in name.split('.') {
            out.push(label.len() as u8);
            out.extend_from_slice(label.as_bytes());
        }

        out.push(0);
        out.extend_from_slice(&TYPE_NS.to_be_bytes());
        out.extend_from_slice(&CLASS_IN.to_be_bytes());

        out
    }

    /// The name at `at` (compression pointers followed), lower-cased and dotted, and the offset after it in the message.
    fn read_name(message: &[u8], mut at: usize) -> Option<(String, usize)> {
        let mut labels: Vec<String> = Vec::new();
        let mut after = None;
        let mut hops = 0;

        loop {
            let length = usize::from(*message.get(at)?);

            match length {
                0 => {
                    return Some((labels.join("."), after.unwrap_or(at + 1)));
                }
                1..=63 => {
                    let label = message.get(at + 1..at + 1 + length)?;

                    labels.push(String::from_utf8_lossy(label).to_ascii_lowercase());
                    at += 1 + length;
                }
                192..=255 => {
                    let low = usize::from(*message.get(at + 1)?);

                    after.get_or_insert(at + 2);
                    hops += 1;

                    if hops > 16 {
                        return None;
                    }

                    at = ((length & 0x3f) << 8) | low;
                }
                _ => return None,
            }
        }
    }

    /// What the answer to the question about `name` (id `id`) says, or the reason to hand the run to Node.
    pub(super) fn read_answer(message: &[u8], id: u16, name: &str) -> Result<Outcome, String> {
        let word = |at: usize| message.get(at..at + 2).map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]));
        let (flags, questions, answers) = (word(2).ok_or("a short DNS answer")?, word(4), word(6));

        if word(0) != Some(id) {
            return Err("a DNS answer with another id".to_owned());
        }

        if flags & 0x8000 == 0 || flags & 0x7800 != 0 {
            return Err("a DNS message that is not the answer to a standard query".to_owned());
        }

        if flags & 0x0200 != 0 {
            return Err("a truncated DNS answer, which Node asks again over TCP".to_owned());
        }

        let rcode = flags & 0x000f;

        if rcode != 0 && rcode != 3 {
            return Err(format!("a DNS answer with response code {rcode}, which Node reports as a failed lookup"));
        }

        if questions != Some(1) {
            return Err("a DNS answer that does not repeat the one question".to_owned());
        }

        let (asked, mut at) = read_name(message, 12).ok_or("a DNS question that is not readable")?;

        if asked != name || word(at) != Some(TYPE_NS) || word(at + 2) != Some(CLASS_IN) {
            return Err("a DNS answer to another question".to_owned());
        }

        if rcode == 3 {
            return Ok(Outcome::Lapsed);
        }

        at += 4;

        let answers = answers.ok_or("a short DNS answer")?;

        if answers == 0 {
            return Ok(Outcome::Lapsed);
        }

        for _ in 0..answers {
            let (owner, next) = read_name(message, at).ok_or("an answer record whose name is not readable")?;
            let (kind, class, length) = (word(next), word(next + 2), word(next + 8));
            let (Some(kind), Some(class), Some(length)) = (kind, class, length) else {
                return Err("a short DNS answer record".to_owned());
            };
            let data = next + 10;

            if owner != name || kind != TYPE_NS || class != CLASS_IN {
                return Err("an answer record that is not an NS record of the domain".to_owned());
            }

            read_name(message, data)
                .filter(|(_, end)| *end <= data + usize::from(length))
                .ok_or("an NS record whose target is not readable")?;
            at = data + usize::from(length);
        }

        Ok(Outcome::Registered)
    }
}

/// The servers a run asks and how long it waits for each answer.
pub(super) struct Resolver {
    pub servers: Vec<SocketAddr>,
    pub wait: Duration,
    /// Why no lookup may be made on this machine, when something in its resolver settings changes which server Node asks.
    pub declined: Option<String>,
}

/// Whether the settings c-ares reads rotate its servers: `RES_OPTIONS` (any value: it may say `rotate`) or a `rotate`
/// option in `resolv_conf`'s text.
fn rotation(options: Option<&std::ffi::OsStr>, resolv_conf: &str) -> Option<String> {
    if options.is_some() {
        return Some("RES_OPTIONS is set, and may rotate the servers Node asks".to_owned());
    }

    resolv_conf
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("options"))
        .any(|line| line.split_whitespace().any(|word| word == "rotate"))
        .then(|| "/etc/resolv.conf rotates the servers Node asks".to_owned())
}

impl Resolver {
    pub(super) fn production() -> Self {
        let resolv_conf = std::fs::read_to_string("/etc/resolv.conf").unwrap_or_default();

        Self {
            servers: vec![SERVER.parse().expect("a socket address")],
            wait: WAIT,
            declined: rotation(std::env::var_os("RES_OPTIONS").as_deref(), &resolv_conf),
        }
    }

    /// `resolver.resolveNs(domain)` classified as `resolveDomain` classifies it, or the reason to hand the run to Node.
    pub(super) fn lookup(&self, domain: &str) -> Result<Outcome, String> {
        if let Some(reason) = &self.declined {
            return Err(reason.clone());
        }

        if !wire::is_plain_name(domain) {
            return Err(format!("the domain {domain:?} is not a plain host name of two or more labels"));
        }

        let server = *self.servers.first().ok_or("no DNS server")?;
        let id = {
            use std::hash::{BuildHasher, Hasher};

            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();

            hasher.write_u32(std::process::id());
            hasher.finish() as u16
        };
        let socket = UdpSocket::bind(if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" })
            .map_err(|error| format!("a DNS socket cannot be opened: {error}"))?;

        socket.connect(server).map_err(|error| format!("{server} cannot be reached: {error}"))?;
        socket.send(&wire::query(id, domain)).map_err(|error| format!("a DNS query cannot be sent: {error}"))?;

        let deadline = Instant::now() + self.wait;
        let mut buffer = [0_u8; 4096];

        loop {
            let left = deadline.saturating_duration_since(Instant::now());

            if left.is_zero() {
                return Err(format!("no DNS answer from {server} in time"));
            }

            socket.set_read_timeout(Some(left)).map_err(|error| format!("a DNS socket cannot wait: {error}"))?;

            let length = match socket.recv(&mut buffer) {
                Ok(length) => length,
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                    return Err(format!("no DNS answer from {server} in time"));
                }
                Err(error) => return Err(format!("a DNS answer cannot be read: {error}")),
            };
            let message = &buffer[..length];

            // c-ares ignores a message that is not the answer to its query (another id) and waits on.
            if message.get(..2) != Some(&id.to_be_bytes()) {
                continue;
            }

            return wire::read_answer(message, id, domain);
        }
    }
}

/// `extractDomain`: the part after the last `@`, trimmed and lower-cased. `Ok(None)` for no domain; the reason to hand
/// the run to Node for one with a character whose case JavaScript and Rust fold differently.
fn extract_domain(email: &str) -> Result<Option<String>, String> {
    let Some(at) = email.rfind('@') else { return Ok(None) };

    if at + 1 == email.len() {
        return Ok(None);
    }

    let domain = trim(&email[at + 1..]);

    if !domain.is_ascii() {
        return Err(format!("the domain {domain:?} is not ASCII"));
    }

    Ok((!domain.is_empty()).then(|| domain.to_ascii_lowercase()))
}

/// `collectMaintainers`' emails, in its order: `_npmUser`, then each of `maintainers`.
fn emails<'a>(entry: &'a Js) -> Result<Vec<&'a str>, String> {
    let mut out = Vec::new();
    let mut take = |maintainer: &'a Js| match maintainer {
        // `maintainer.email` of null throws.
        Js::Null => Err("a maintainer that is null".to_owned()),
        other => {
            if let Some(Js::String(email)) = other.member("email") {
                out.push(email.as_str());
            }

            Ok(())
        }
    };

    if let Some(user) = entry.member("_npmUser") {
        take(user)?;
    }

    match entry.member("maintainers") {
        None | Some(Js::Null) => {}
        Some(Js::Array(items)) => {
            for item in items {
                take(item)?;
            }
        }
        Some(_) => return Err("`maintainers` is not an array".to_owned()),
    }

    Ok(out)
}

fn cache_entry(outcome: Outcome, now_ms: u64) -> String {
    let word = if outcome == Outcome::Registered { "ok" } else { "expired" };

    format!("{{\"createdAt\":{now_ms},\"outcome\":\"{word}\",\"ttlMs\":{TTL_MS}}}")
}

/// The findings of `runExpiredDomainsMarshall` for the target and the cache changes that go with them.
pub(super) fn run(
    resolver: &Resolver,
    cache_dir: &str,
    view: &View,
    target: &Target,
    now_ms: u64,
) -> Result<(Vec<Finding>, Vec<CacheAction>), String> {
    let Some(entry) = version_entry(view, target.version)? else { return Ok((Vec::new(), Vec::new())) };
    let mut seen: Vec<(String, &str)> = Vec::new();
    let mut known: HashMap<String, Outcome> = HashMap::new();
    let mut findings = Vec::new();
    let mut cache = Vec::new();

    for email in emails(entry)? {
        let Some(domain) = extract_domain(email)? else { continue };

        // One finding per domain and address.
        if seen.iter().any(|(seen_domain, seen_email)| *seen_domain == domain && *seen_email == email) {
            continue;
        }

        seen.push((domain.clone(), email));

        let outcome = match known.get(&domain) {
            Some(outcome) => *outcome,
            None => {
                let file = cache_file(cache_dir, &domain);
                let outcome = match service_cache::read(&file, now_ms as f64)? {
                    Cached::Fresh(found) => {
                        if matches!(found.member("outcome"), Some(Js::String(word)) if word == "ok") {
                            Outcome::Registered
                        } else {
                            Outcome::Lapsed
                        }
                    }
                    Cached::Fetch { stale_file } => {
                        if stale_file {
                            cache.push(CacheAction::Remove(file.clone()));
                        }

                        let outcome = resolver.lookup(&domain)?;

                        cache.push(CacheAction::Write { file, text: cache_entry(outcome, now_ms) });

                        outcome
                    }
                };

                known.insert(domain.clone(), outcome);

                outcome
            }
        };

        if outcome == Outcome::Lapsed {
            findings.push(Finding {
                marshall: "expiredDomains",
                message: format!(
                    "Maintainer email domain {domain} ({email}) is unregistered \u{2014} potential hijack risk."
                ),
                package: target.name.to_owned(),
                severity: Severity::Error,
            });
        }
    }

    Ok((findings, cache))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_domain_is_what_follows_the_last_at_sign() {
        for (email, expected) in [
            ("amy@Example.TEST", Some("example.test")),
            ("a@b@c.example", Some("c.example")),
            ("amy@ example.test \u{a0}", Some("example.test")),
            ("amy@", None),
            ("amy", None),
            ("@", None),
            ("amy@ ", None),
        ] {
            assert_eq!(extract_domain(email), Ok(expected.map(str::to_owned)), "{email:?}");
        }

        assert!(extract_domain("amy@exämple.test").is_err());
    }

    #[test]
    fn a_plain_name_has_two_or_more_clean_labels() {
        for plain in ["example.test", "a.b.c", "xn--bcher-kva.example", "1.2.3.4", "a-b.example"] {
            assert!(wire::is_plain_name(plain), "{plain}");
        }

        for odd in [
            "localhost",
            "",
            ".",
            "a..b",
            "a.b.",
            "-a.example",
            "a-.example",
            "a_b.example",
            "a b.example",
            "é.example",
            &format!("{}.example", "a".repeat(64)),
        ] {
            assert!(!wire::is_plain_name(odd), "{odd}");
        }
    }

    #[test]
    fn the_query_is_the_one_c_ares_sends() {
        assert_eq!(
            wire::query(0xabcd, "example.com"),
            [
                0xab, 0xcd, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 3, b'c',
                b'o', b'm', 0, 0, 2, 0, 1
            ]
        );
    }

    #[test]
    fn rotation_is_read_from_the_environment_and_the_resolver_file() {
        assert!(rotation(None, "nameserver 1.1.1.1\nsearch corp.example\noptions ndots:2 timeout:1\n").is_none());
        assert!(rotation(None, "options ndots:2 rotate\n").is_some());
        assert!(rotation(None, "  options rotate").is_some());
        assert!(rotation(None, "# options rotate\nnameserver 8.8.8.8").is_none());
        assert!(rotation(Some(std::ffi::OsStr::new("ndots:1")), "").is_some());
    }

    #[test]
    fn the_cache_file_is_named_by_the_hash_of_the_domain() {
        assert_eq!(
            cache_file("/c", "example.test"),
            Path::new("/c/expired-domains")
                .join(format!("{}.json", &format!("{:x}", Sha256::digest(b"example.test"))[..12]))
        );
        assert_eq!(cache_entry(Outcome::Registered, 7), r#"{"createdAt":7,"outcome":"ok","ttlMs":86400000}"#);
        assert_eq!(cache_entry(Outcome::Lapsed, 7), r#"{"createdAt":7,"outcome":"expired","ttlMs":86400000}"#);
    }
}
