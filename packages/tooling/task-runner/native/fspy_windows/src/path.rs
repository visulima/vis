//! Path normalization for Win32-API paths.
//!
//! Win32 file APIs hand us paths in several shapes: drive paths
//! (`C:\dir\file`), the extended-length prefix (`\\?\C:\dir\file`), the
//! device-namespace prefix (`\\.\…`), and UNC paths (`\\server\share`). The
//! supervisor normalizes them to a forward-slash form so the downstream
//! cache-keying code never sees a Windows-specific shape, mirroring what the
//! Linux/macOS trackers already emit.

use std::path::{Path, PathBuf};

/// Strip the extended-length (`\\?\`) and device (`\\.\`) prefixes and map
/// backslashes to forward slashes. UNC roots are preserved as `//server/share`.
///
/// - `\\?\C:\a\b`        → `C:/a/b`
/// - `\\?\UNC\srv\share` → `//srv/share`
/// - `\\.\C:\a`          → `C:/a`
/// - `C:\a\b`            → `C:/a/b`
/// - `\\srv\share\a`     → `//srv/share/a`
pub fn normalize(path: &Path) -> PathBuf {
    PathBuf::from(normalize_str(&path.to_string_lossy()))
}

/// String form used by the injected DLL's hot path (it already has the path as
/// a `String` from the UTF-16/ANSI argument and only needs the normalized
/// string to put on the wire).
pub fn normalize_win(s: &str) -> String {
    normalize_str(s)
}

fn normalize_str(raw: &str) -> String {
    // `\\?\UNC\server\share` is the extended form of a UNC path — drop the
    // `\\?\UNC\` and re-introduce the `\\` UNC root so it normalizes the same
    // as a plain `\\server\share`.
    if let Some(rest) = strip_prefix_ci(raw, r"\\?\UNC\") {
        return format!("//{}", rest.replace('\\', "/"));
    }

    // Extended-length and device prefixes are interchangeable for our
    // purposes; strip either.
    let stripped = raw.strip_prefix(r"\\?\").or_else(|| raw.strip_prefix(r"\\.\")).unwrap_or(raw);

    stripped.replace('\\', "/")
}

/// Case-insensitive `strip_prefix` — Windows path prefixes are
/// case-insensitive (`\\?\unc\` vs `\\?\UNC\`).
///
/// Compares bytes: slicing `s[..prefix.len()]` panics when that index falls
/// inside a multi-byte character, and a panic here runs inside an injected hook.
/// `prefix` is ASCII, so a matching byte prefix ends on a character boundary and
/// `s.get(n..)` is always `Some` on a match.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let n = prefix.len();

    if s.as_bytes().get(..n)?.eq_ignore_ascii_case(prefix.as_bytes()) {
        s.get(n..)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_str;

    // `\\?\UNC\` is 8 bytes; a multi-byte character straddling byte 8 used to
    // make `&s[..8]` panic inside the injected hook, aborting the host.
    #[test]
    fn non_ascii_path_straddling_the_prefix_boundary() {
        assert_eq!(normalize_str(r"C:\a\äö"), "C:/a/äö");
        assert_eq!(normalize_str(r"C:\ab\ö"), "C:/ab/ö");
    }

    #[test]
    fn non_ascii_paths_of_every_shape() {
        assert_eq!(normalize_str(r"\\?\C:\ünï\日本語.txt"), "C:/ünï/日本語.txt");
        assert_eq!(normalize_str(r"\\?\UNC\srv\shäre\日本"), "//srv/shäre/日本");
        assert_eq!(normalize_str(r"\\srv\sh\😀"), "//srv/sh/😀");
        assert_eq!(normalize_str("😀"), "😀");
        assert_eq!(normalize_str(""), "");
    }

    #[test]
    fn every_truncation_point_of_a_multibyte_path_is_safe() {
        // The ANSI hook decodes arbitrary bytes lossily, so cut at every byte.
        for s in [r"\\?\UNC\äö", "ä\\ö\\日本語\\😀", r"\\?\ÜNC\x"] {
            for end in 0..=s.len() {
                let _ = normalize_str(&String::from_utf8_lossy(&s.as_bytes()[..end]));
            }
        }
    }

    #[test]
    fn strips_extended_length_prefix() {
        assert_eq!(normalize_str(r"\\?\C:\a\b"), "C:/a/b");
    }

    #[test]
    fn strips_device_prefix() {
        assert_eq!(normalize_str(r"\\.\C:\a"), "C:/a");
    }

    #[test]
    fn rewrites_extended_unc() {
        assert_eq!(normalize_str(r"\\?\UNC\srv\share\f"), "//srv/share/f");
        assert_eq!(normalize_str(r"\\?\unc\srv\share"), "//srv/share");
    }

    #[test]
    fn preserves_plain_unc() {
        assert_eq!(normalize_str(r"\\srv\share\a"), "//srv/share/a");
    }

    #[test]
    fn plain_drive_path() {
        assert_eq!(normalize_str(r"C:\dir\file.txt"), "C:/dir/file.txt");
    }
}
