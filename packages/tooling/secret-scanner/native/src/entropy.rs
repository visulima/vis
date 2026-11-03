// Shannon entropy in bits/symbol, computed over Unicode scalar values.
// Port of gitleaks/detect/utils.go::shannonEntropy (char-based since gitleaks #2230).

use std::collections::HashMap;

pub fn shannon(data: &str) -> f32 {
    if data.is_empty() {
        return 0.0;
    }

    // ASCII fast path: one byte == one char, so a 256-bucket histogram gives the
    // exact char-based result without hashing. Keeps ASCII results bit-identical.
    if data.is_ascii() {
        let mut counts = [0u32; 256];
        for &b in data.as_bytes() {
            counts[b as usize] += 1;
        }
        return entropy_from_counts(counts.iter().copied(), data.len());
    }

    // Non-ASCII: count chars, not bytes. A multibyte char is one symbol, so `"ääää"`
    // scores 0.0 instead of the 1.0 a byte histogram would give.
    let mut counts: HashMap<char, u32> = HashMap::new();
    let mut len = 0usize;
    for c in data.chars() {
        *counts.entry(c).or_insert(0) += 1;
        len += 1;
    }
    entropy_from_counts(counts.into_values(), len)
}

fn entropy_from_counts(counts: impl Iterator<Item = u32>, len: usize) -> f32 {
    let len = len as f32;
    let mut entropy = 0.0f32;
    for c in counts {
        if c == 0 {
            continue;
        }
        let p = c as f32 / len;
        entropy -= p * p.log2();
    }
    entropy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_is_zero() {
        assert_eq!(shannon(""), 0.0);
    }

    #[test]
    fn uniform_high() {
        // Base64 alphabet chunk: high entropy
        let e = shannon("MIIEpAIBAAKCAQEA7f1h4uQ5");
        assert!(e > 3.5, "got {e}");
    }

    #[test]
    fn repeated_low() {
        assert!(shannon("aaaaaaaa") < 0.1);
    }

    #[test]
    fn ascii_matches_byte_histogram() {
        // Reference: the pre-#2230 byte-based implementation. ASCII must stay identical.
        fn byte_shannon(data: &str) -> f32 {
            let mut counts = [0u32; 256];
            for &b in data.as_bytes() {
                counts[b as usize] += 1;
            }
            let len = data.len() as f32;
            let mut e = 0.0f32;
            for &c in &counts {
                if c > 0 {
                    let p = c as f32 / len;
                    e -= p * p.log2();
                }
            }
            e
        }
        for s in [concat!("ghp_aB3dE4fG5hI6jK7l", "M8nO9pQ0rS1tU2vW3xY4zA5b"), concat!("sk_live_4eC39HqL", "yjWDarjtT1zdp7dc"), "abcabc"] {
            assert_eq!(shannon(s).to_bits(), byte_shannon(s).to_bits(), "{s}");
        }
    }

    #[test]
    fn non_ascii_counts_chars_not_bytes() {
        // Bytes would see 0xC3 0xA4 alternating -> 1.0 bit; per char it is a single symbol.
        assert_eq!(shannon("ääää"), 0.0);
        // Two distinct chars, equal frequency -> exactly 1 bit.
        assert!((shannon("äöäö") - 1.0).abs() < f32::EPSILON);
        // Same symbol distribution as an ASCII string of equal shape.
        assert!((shannon("pässwört") - shannon("passwort")).abs() < 1e-6);
    }
}
