//! The `signatures` marshall: `src/security/marshalls/signatures.ts` for one package (it runs with `--only signatures`
//! and never by default).
//!
//! Node reads npm's signing keys (`~/.vis/cache/registry-keys/npmjs.json`, 24 hours, else `VIS_NPM_KEYS_URL` or
//! `https://registry.npmjs.org/-/npm/v1/keys`), then checks each `dist.signatures` entry of the inspected version: a
//! missing signature or integrity is a warning, a keyid the registry does not list an error, an expired key a warning,
//! and a signature over `name@version:integrity` that does not verify an error. A keys request that gets a status
//! other than 2xx falls back to the old keys, or ends in a `fetch-failed` warning.
//!
//! The signature is checked with `ring` (ECDSA P-256 over SHA-256, DER signature), which is already linked through
//! `rustls`. The module answers only for a signature that verifies. A key or signature this module cannot read
//! strictly, and any signature that does not verify, are Node's: `createPublicKey` and `Buffer.from(…, "base64")` read
//! leniently, so "does not verify here" is not evidence that Node says the same, and the `invalid-signature` report is
//! for Node to make.
//!
//! Also Node's, before anything is printed or written: a keys request that fails before an answer, a redirect, a keys
//! file or answer that is not what Node reads, a key whose `expires` is not in the form registries write, and a
//! `VIS_NPM_KEYS_URL` that is not text or not a plain URL.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};

use super::archived_repo::version_entry;
use super::js_format::parse_date;
use super::marshalls::{Finding, Severity, Target};
use super::packument::View;
use super::CacheAction;
use crate::http::{HttpClient, HttpError};
use crate::keys_refresh::{cache_entry, fetched_keys, Js};

/// The DER prefix of a SubjectPublicKeyInfo that holds an uncompressed P-256 point: `SEQUENCE { SEQUENCE { OID
/// ecPublicKey, OID prime256v1 }, BIT STRING 0x00 || point }`, 91 bytes with the 65-byte point.
const SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
    0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

pub(super) fn cache_file(cache_dir: &str) -> PathBuf {
    Path::new(cache_dir).join("registry-keys").join("npmjs.json")
}

/// The standard-alphabet base64 of `text` when it is canonical: padded, no whitespace, and no stray bits. Anything else
/// is read differently by `Buffer.from` and OpenSSL, so it is not read here.
fn base64_strict(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();

    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }

    let value = |byte: u8| -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some(u32::from(byte - b'A')),
            b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();

    if padding > 2 {
        return None;
    }

    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);

    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index == bytes.len() / 4 - 1;
        let pad = if last { padding } else { 0 };
        let mut group = 0_u32;

        for (position, byte) in chunk.iter().enumerate() {
            group <<= 6;

            if position < 4 - pad {
                group |= value(*byte)?;
            } else if *byte != b'=' {
                return None;
            }
        }

        let triple = group.to_be_bytes();

        // The bits a padded group does not use must be zero, or another text decodes to the same bytes.
        match pad {
            0 => out.extend_from_slice(&triple[1..]),
            1 if triple[3] == 0 => out.extend_from_slice(&triple[1..3]),
            2 if triple[2] == 0 && triple[3] == 0 => out.push(triple[1]),
            _ => return None,
        }
    }

    Some(out)
}

/// The uncompressed point of a base64 SPKI public key for P-256, or `None` for any other key or encoding.
fn point_of(key_base64: &str) -> Option<Vec<u8>> {
    let der = base64_strict(key_base64)?;

    (der.len() == SPKI_PREFIX.len() + 65 && der.starts_with(&SPKI_PREFIX) && der[SPKI_PREFIX.len()] == 0x04)
        .then(|| der[SPKI_PREFIX.len()..].to_vec())
}

/// Whether `signature_base64` is a valid ECDSA P-256 / SHA-256 signature of `message` under `key_base64`.
fn verifies(key_base64: &str, message: &str, signature_base64: &str) -> bool {
    let (Some(point), Some(signature)) = (point_of(key_base64), base64_strict(signature_base64)) else { return false };

    UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, &point).verify(message.as_bytes(), &signature).is_ok()
}

/// The registry's keys, by keyid (a later key of the same keyid replaces an earlier one, as `Map.set` does).
struct Keys<'a> {
    by_id: HashMap<&'a str, &'a Js>,
}

impl<'a> Keys<'a> {
    fn new(list: &'a Js) -> Result<Self, String> {
        let Js::Array(items) = list else { return Err("the registry keys are not an array".to_owned()) };
        let mut by_id = HashMap::new();

        for item in items {
            let keyid = item.member("keyid").and_then(Js::text).ok_or("a registry key has no text keyid")?;

            by_id.insert(keyid, item);
        }

        Ok(Self { by_id })
    }
}

/// What `fetchRegistryKeys` gives: the keys, or nothing (a failed fetch and no cache).
struct Fetched {
    keys: Option<Js>,
    cache: Vec<CacheAction>,
}

/// The keys file as Node reads it: `Ok(None)` for no file, `(keys, expired)` for an entry with a numeric `createdAt` and
/// `ttlMs` and a `keys` array; the reason for a hand-off for anything else.
fn read_cache(file: &Path, now_ms: f64) -> Result<Option<(Js, bool)>, String> {
    match std::fs::metadata(file) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("the keys cache path is not a regular file".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("the keys cache cannot be read: {error}")),
    }

    let text = std::fs::read_to_string(file).map_err(|error| format!("the keys cache cannot be read: {error}"))?;
    let entry: Js =
        serde_json::from_str(&text).map_err(|_| "the keys cache is not JSON this module reads".to_owned())?;
    let number = |key: &str| match entry.member(key) {
        Some(Js::Number(number)) => Some(*number),
        _ => None,
    };
    let (Some(created), Some(ttl)) = (number("createdAt"), number("ttlMs")) else {
        return Err("the keys cache has no numeric createdAt and ttlMs".to_owned());
    };
    let Js::Object(entries) = entry else { return Err("the keys cache is not an object".to_owned()) };
    let keys = entries
        .into_iter()
        .find(|(name, _)| name == "keys")
        .map(|(_, keys)| keys)
        .filter(|keys| matches!(keys, Js::Array(_)))
        .ok_or("the keys cache has no keys array")?;

    Ok(Some((keys, now_ms - created > ttl)))
}

/// `fetchRegistryKeys`.
fn registry_keys(client: &HttpClient, url: &str, cache_dir: &str, now_ms: u64) -> Result<Fetched, String> {
    let file = cache_file(cache_dir);
    let cached = read_cache(&file, now_ms as f64)?;

    if let Some((keys, false)) = cached {
        return Ok(Fetched { keys: Some(keys), cache: Vec::new() });
    }

    let stale = cached.map(|(keys, _)| keys);

    match client.get(url, &[("accept", "application/json")]) {
        Ok(response) => {
            let text = response.text().map_err(|error| format!("the keys answer is not UTF-8 text: {error}"))?;
            let fetched = fetched_keys(text).ok_or("the keys answer is not a JSON object Node reads the same way")?;
            let keys =
                serde_json::from_str::<Js>(&fetched.raw).map_err(|_| "the keys cannot be read again".to_owned())?;
            let text = cache_entry(&fetched, u128::from(now_ms));

            Ok(Fetched { keys: Some(keys), cache: vec![CacheAction::Write { file, text }] })
        }
        // A status other than 2xx: the old keys, or none.
        Err(HttpError::Status { .. }) => Ok(Fetched { keys: stale, cache: Vec::new() }),
        Err(error) => Err(format!("the keys request failed: {error}")),
    }
}

fn finding(target: &Target, severity: Severity, message: String) -> Finding {
    target.finding("signatures", severity, message)
}

/// `isKeyExpired`: a key without `expires` (or with an empty or `null` one: `Date.parse(null)` is `NaN`, and npm's current
/// key has one) never expires; the others are read in the one form registries write.
fn expired(key: &Js, now_ms: f64) -> Result<Option<&str>, String> {
    match key.member("expires") {
        None | Some(Js::Null) => Ok(None),
        Some(Js::String(text)) if text.is_empty() => Ok(None),
        Some(Js::String(text)) => {
            let at = parse_date(text).ok_or_else(|| format!("the expiry {text:?} is not in the registry's form"))?;

            Ok((at <= now_ms).then_some(text.as_str()))
        }
        Some(_) => Err("a key's `expires` is not text".to_owned()),
    }
}

/// The findings of `runSignatureMarshall` for the target and the cache change that goes with them.
pub(super) fn run(
    client: &HttpClient,
    url: Option<&str>,
    cache_dir: &str,
    view: &View,
    target: &Target,
    now_ms: u64,
) -> Result<(Vec<Finding>, Vec<CacheAction>), String> {
    let url = url.ok_or("VIS_NPM_KEYS_URL is not text")?;

    if !crate::http::node_fetch::url_is_plain(url) {
        return Err(format!("the keys address {url:?} is not a URL `fetch` and the client read alike"));
    }

    let Fetched { keys, cache } = registry_keys(client, url, cache_dir, now_ms)?;
    let Some(keys) = keys else {
        let message = "Could not fetch registry signing keys.".to_owned();

        return Ok((vec![finding(target, Severity::Warning, message)], cache));
    };
    let keys = Keys::new(&keys)?;
    let Some(entry) = version_entry(view, target.version)? else { return Ok((Vec::new(), cache)) };
    let dist = entry.member("dist");
    let signatures = match dist.and_then(|dist| dist.member("signatures")) {
        None => &[][..],
        Some(Js::Array(items)) => items.as_slice(),
        Some(_) => return Err("`dist.signatures` is not an array".to_owned()),
    };
    let (name, version) = (target.name, target.version);

    if signatures.is_empty() {
        let message = format!("Package {name}@{version} has no dist.signatures from the registry.");

        return Ok((vec![finding(target, Severity::Warning, message)], cache));
    }

    let integrity = match dist.and_then(|dist| dist.member("integrity")) {
        Some(Js::String(text)) if !text.is_empty() => text,
        _ => {
            let message = format!("Package {name}@{version} has signatures but no dist.integrity to verify against.");

            return Ok((vec![finding(target, Severity::Warning, message)], cache));
        }
    };
    let signed = format!("{name}@{version}:{integrity}");
    let mut found = Vec::new();

    for signature in signatures {
        let keyid = signature.member("keyid").and_then(Js::text).ok_or("a signature has no text keyid")?;

        let Some(key) = keys.by_id.get(keyid) else {
            let message = format!("Package {name}@{version} was signed with an unrecognized keyid ({keyid}).");

            found.push(finding(target, Severity::Error, message));

            continue;
        };

        if let Some(at) = expired(key, now_ms as f64)? {
            let message = format!("Package {name}@{version} was signed with an expired key ({keyid}, expired {at}).");

            found.push(finding(target, Severity::Warning, message));

            continue;
        }

        let verified = match (key.member("key"), signature.member("sig")) {
            (Some(Js::String(key)), Some(Js::String(sig))) => verifies(key, &signed, sig),
            _ => false,
        };

        if !verified {
            return Err(format!("the signature of {keyid} does not verify here, which Node judges"));
        }
    }

    Ok((found, cache))
}

/// A signing key made at test time, for the tests of this module and of `inspect`.
#[cfg(test)]
pub(super) mod fixtures {
    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};

    use super::SPKI_PREFIX;

    pub(in crate::inspect) fn base64_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();

        for chunk in bytes.chunks(3) {
            let group =
                chunk.iter().enumerate().fold(0_u32, |group, (at, byte)| group | u32::from(*byte) << (16 - 8 * at));

            for position in 0..4 {
                if position <= chunk.len() {
                    out.push(char::from(ALPHABET[(group >> (18 - 6 * position) & 63) as usize]));
                } else {
                    out.push('=');
                }
            }
        }

        out
    }

    pub(in crate::inspect) struct TestKey {
        pair: EcdsaKeyPair,
        pub point: Vec<u8>,
        rng: SystemRandom,
    }

    impl TestKey {
        pub(in crate::inspect) fn new() -> Self {
            let rng = SystemRandom::new();
            let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
            let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap();
            let point = pair.public_key().as_ref().to_vec();

            Self { pair, point, rng }
        }

        /// The key as `/-/npm/v1/keys` carries it.
        pub(in crate::inspect) fn spki_base64(&self) -> String {
            base64_encode(&[SPKI_PREFIX.as_slice(), &self.point].concat())
        }

        /// A DER signature of `message`, in base64.
        pub(in crate::inspect) fn sign(&self, message: &str) -> String {
            base64_encode(self.pair.sign(&self.rng, message.as_bytes()).unwrap().as_ref())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_is_read_only_when_canonical() {
        assert_eq!(base64_strict("TWFu").unwrap(), b"Man");
        assert_eq!(base64_strict("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_strict("TQ==").unwrap(), b"M");
        assert_eq!(base64_strict("+/+/").unwrap(), [0xfb, 0xff, 0xbf]);

        for odd in ["", "TWE", "TW E", "TWFu\n", "TWF=", "TR==", "T===", "TWFu=", "TQ=A", "-_-_", "TW=u", "====", "é"]
        {
            assert!(base64_strict(odd).is_none(), "{odd:?}");
        }
    }

    #[test]
    fn a_signature_verifies_only_for_its_message_and_key() {
        let key = fixtures::TestKey::new();
        let other = fixtures::TestKey::new();
        let signature = key.sign("pkg@1.0.0:sha512-abc");

        assert!(verifies(&key.spki_base64(), "pkg@1.0.0:sha512-abc", &signature));
        assert!(!verifies(&key.spki_base64(), "pkg@1.0.0:sha512-abd", &signature));
        assert!(!verifies(&other.spki_base64(), "pkg@1.0.0:sha512-abc", &signature));
        // Not canonical base64, a point that is not on the curve, and a key of another shape.
        assert!(!verifies(&key.spki_base64(), "pkg@1.0.0:sha512-abc", &format!("{signature}\n")));
        assert!(!verifies(&key.spki_base64(), "pkg@1.0.0:sha512-abc", "AAAA"));
        assert!(!verifies("AAAA", "m", &signature));
    }

    #[test]
    fn the_key_is_the_p256_point() {
        let key = fixtures::TestKey::new();
        let point = point_of(&key.spki_base64()).unwrap();

        assert_eq!((point.len(), point[0]), (65, 0x04));
        assert_eq!(point, key.point);
        assert!(point_of(key.spki_base64().trim_end_matches('=')).is_none());
        assert!(point_of("AAAA").is_none());
    }

    #[test]
    fn expiry_is_read_in_the_form_registries_write() {
        let key = |text: &str| serde_json::from_str::<Js>(text).unwrap();

        assert_eq!(expired(&key("{}"), 10.0), Ok(None));
        assert_eq!(expired(&key(r#"{"expires":""}"#), 10.0), Ok(None));
        assert_eq!(
            expired(&key(r#"{"expires":"1970-01-01T00:00:00.000Z"}"#), 10.0),
            Ok(Some("1970-01-01T00:00:00.000Z"))
        );
        assert_eq!(
            expired(&key(r#"{"expires":"1970-01-01T00:00:00.010Z"}"#), 10.0),
            Ok(Some("1970-01-01T00:00:00.010Z"))
        );
        assert_eq!(expired(&key(r#"{"expires":"1970-01-01T00:00:00.011Z"}"#), 10.0), Ok(None));
        assert!(expired(&key(r#"{"expires":"2030"}"#), 10.0).is_err());
        assert_eq!(expired(&key(r#"{"expires":null}"#), 10.0), Ok(None));
        assert!(expired(&key(r#"{"expires":5}"#), 10.0).is_err());
    }
}
