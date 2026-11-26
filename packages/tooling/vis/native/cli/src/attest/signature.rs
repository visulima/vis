//! `verifyEcdsaSignature` of `src/security/marshalls/verify-ecdsa.ts`: an ECDSA P-256 / SHA-256 signature, in the DER
//! form npm sends it, over `name@version:integrity`, against the registry's SPKI key.
//!
//! Node wraps the key in PEM, lets OpenSSL read it and answers `false` for anything that does not verify, including a
//! key or signature that cannot be read. This module answers the same for the shapes it reads the way OpenSSL does and
//! gives the reason for a hand-off for the rest: a base64 text that is not canonical (Node's decoder skips what it
//! does not know), a key that is not the 91 bytes of a P-256 SPKI, which OpenSSL may still use for another curve.

use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};

/// The DER prefix of an SPKI holding a prime256v1 key: `SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 },
/// BIT STRING (66 bytes, no unused bits) }`, up to the 65 bytes of the uncompressed point.
const SPKI_P256_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
    0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/// Standard base64 with padding and no other character: the only text Node's decoder and this one read alike.
fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();

    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }

    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();

    if padding > 2 {
        return None;
    }

    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);

    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index == bytes.len() / 4 - 1;
        let mut value = 0_u32;
        let mut missing = 0;

        for (position, byte) in chunk.iter().enumerate() {
            let sextet = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' if last && position >= 4 - padding => {
                    missing += 1;
                    0
                }
                _ => return None,
            };

            value = value << 6 | u32::from(sextet);
        }

        let triple = value.to_be_bytes();

        out.extend_from_slice(&triple[1..4 - missing]);

        // The bits a padded group does not use must be zero, or Node's decoder and the canonical form differ.
        if missing > 0 && triple[4 - missing..].iter().any(|byte| *byte != 0) {
            return None;
        }
    }

    Some(out)
}

/// Whether `signature_base64` verifies over `message` against `key_base64`, or the reason this module leaves the
/// decision to Node.
pub(super) fn verifies(key_base64: &str, message: &str, signature_base64: &str) -> Result<bool, String> {
    // `wrapSpkiPem` drops every whitespace character before it cuts the text into lines.
    let key_text: String = key_base64.chars().filter(|character| !character.is_whitespace()).collect();
    let key = decode(&key_text).ok_or("a registry key that is not canonical base64")?;
    let point = key
        .strip_prefix(&SPKI_P256_PREFIX[..])
        .filter(|point| point.len() == 65 && point[0] == 4)
        .ok_or("a registry key that is not a P-256 SPKI")?;
    let signature = decode(signature_base64).ok_or("a signature that is not canonical base64")?;

    Ok(UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, point).verify(message.as_bytes(), &signature).is_ok())
}

/// Signing keys and signatures for the tests of this module and of [`super::verify`].
#[cfg(test)]
pub(super) mod support {
    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};

    use super::SPKI_P256_PREFIX;

    pub(in crate::attest) fn encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();

        for chunk in bytes.chunks(3) {
            let value = chunk
                .iter()
                .enumerate()
                .fold(0_u32, |value, (index, byte)| value | u32::from(*byte) << (16 - 8 * index));

            for position in 0..4 {
                if position <= chunk.len() {
                    out.push(char::from(ALPHABET[(value >> (18 - 6 * position) & 63) as usize]));
                } else {
                    out.push('=');
                }
            }
        }

        out
    }

    /// A fresh key pair: the SPKI of the public key, and a signer of messages.
    pub(in crate::attest) struct Signer {
        pub(in crate::attest) key_base64: String,
        pair: EcdsaKeyPair,
        random: SystemRandom,
    }

    impl Signer {
        pub(in crate::attest) fn new() -> Self {
            let random = SystemRandom::new();
            let document = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &random).unwrap();
            let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, document.as_ref(), &random).unwrap();
            let spki = [SPKI_P256_PREFIX.as_slice(), pair.public_key().as_ref()].concat();

            Self { key_base64: encode(&spki), pair, random }
        }

        pub(in crate::attest) fn sign(&self, message: &str) -> String {
            encode(self.pair.sign(&self.random, message.as_bytes()).unwrap().as_ref())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::support::{encode, Signer};
    use super::*;

    fn signed(message: &str) -> (String, String) {
        let signer = Signer::new();

        (signer.key_base64.clone(), signer.sign(message))
    }

    #[test]
    fn base64_is_read_in_the_canonical_form_only() {
        assert_eq!(decode("TWFu").unwrap(), b"Man");
        assert_eq!(decode("TWE=").unwrap(), b"Ma");
        assert_eq!(decode("TQ==").unwrap(), b"M");

        for odd in ["", "TWF", "TWFu\n", "TW=u", "TWE", "T===", "TWF-", "TQ=A", "TR==", "TWH="] {
            assert!(decode(odd).is_none(), "{odd:?}");
        }

        for bytes in [&b""[..], b"a", b"ab", b"abc", b"abcd", &[0xff, 0x00, 0xfe, 0x01, 0xfd]] {
            if !bytes.is_empty() {
                assert_eq!(decode(&encode(bytes)).unwrap(), bytes);
            }
        }
    }

    #[test]
    fn a_signature_verifies_over_its_message_only() {
        let message = "pkg@1.0.0:sha512-abc";
        let (key, signature) = signed(message);

        assert_eq!(verifies(&key, message, &signature), Ok(true));
        assert_eq!(verifies(&key, "pkg@1.0.1:sha512-abc", &signature), Ok(false));

        // A signature that is not DER fails the way it does in OpenSSL.
        assert_eq!(verifies(&key, message, &encode(&[1, 2, 3])), Ok(false));

        // Whitespace in the key is dropped, as `wrapSpkiPem` drops it.
        let wrapped = format!("{}\n{}", &key[..40], &key[40..]);

        assert_eq!(verifies(&wrapped, message, &signature), Ok(true));
    }

    #[test]
    fn what_openssl_may_read_differently_is_handed_over() {
        let (key, signature) = signed("m");

        assert!(verifies("not base64!", "m", &signature).is_err());
        assert!(verifies(&encode(&[0x30, 0x03, 0x02, 0x01, 0x00]), "m", &signature).is_err());
        assert!(verifies(&key, "m", "not base64!").is_err());
        assert!(verifies(&key, "m", "").is_err());
    }
}
