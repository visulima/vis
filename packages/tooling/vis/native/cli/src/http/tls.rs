//! The TLS root strategy.
//!
//! By default a request trusts the bundled Mozilla roots only, and the OS trust store is never read, so a run
//! that does not need a custom root pays nothing for one. When `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` names a
//! PEM file, the roots become the OS trust store plus that file, which is how Node treats
//! `NODE_EXTRA_CA_CERTS`: the file adds to the default store. `ureq`'s own API only replaces the bundled roots
//! with the list it is given, so the combined list is built here.
//!
//! The OS store is read through `rustls-native-certs`, except on macOS: that crate links the Security and
//! CoreFoundation frameworks, and the dynamic loader would then load them on every start (about +11 M
//! instructions, +50%, for `vis --version`). There the `security` tool prints the keychains' certificates
//! instead, which costs a process only on this path.

use std::fs;
use std::path::PathBuf;

use ureq::tls::{parse_pem, Certificate, PemItem, RootCerts, TlsConfig};

/// The PEM files named by `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` (each when set and not empty).
pub(super) fn extra_ca_files(lookup: &dyn Fn(&str) -> Option<std::ffi::OsString>) -> Vec<PathBuf> {
    ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]
        .iter()
        .filter_map(|name| lookup(name))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// The TLS settings for a client whose extra CA files are `extra`.
pub(super) fn tls_config(extra: &[PathBuf]) -> TlsConfig {
    if extra.is_empty() {
        return TlsConfig::default();
    }

    let mut certs = os_roots();

    // Node warns about a file it cannot read and carries on with the default store, so an unreadable file or a
    // malformed block adds nothing here either.
    for file in extra {
        if let Ok(pem) = fs::read(file) {
            certs.extend(certificates(&pem));
        }
    }

    TlsConfig::builder().root_certs(RootCerts::new_with_certs(&certs)).build()
}

#[cfg(not(target_os = "macos"))]
fn os_roots() -> Vec<Certificate<'static>> {
    // Errors are dropped: a store that is partly unreadable still adds what could be read.
    rustls_native_certs::load_native_certs()
        .certs
        .iter()
        .map(|der| Certificate::from_der(der.as_ref()).to_owned())
        .collect()
}

/// The certificates in the system root, system and login keychains. Unlike the trust evaluation behind
/// `rustls-native-certs`, this does not apply per-certificate trust settings, so a certificate a user marked as
/// "never trust" is still accepted when it is in a keychain.
#[cfg(target_os = "macos")]
fn os_roots() -> Vec<Certificate<'static>> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let keychains = [
        Some(PathBuf::from("/System/Library/Keychains/SystemRootCertificates.keychain")),
        Some(PathBuf::from("/Library/Keychains/System.keychain")),
        home.map(|home| home.join("Library/Keychains/login.keychain-db")),
    ];
    let Ok(output) = std::process::Command::new("/usr/bin/security")
        .args(["find-certificate", "-a", "-p"])
        .args(keychains.iter().flatten().filter(|keychain| keychain.exists()))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return Vec::new();
    };

    certificates(&output.stdout)
}

/// The certificate blocks of a PEM file; anything else in it is skipped.
fn certificates(pem: &[u8]) -> Vec<Certificate<'static>> {
    parse_pem(pem)
        .filter_map(Result::ok)
        .filter_map(|item| match item {
            PemItem::Certificate(cert) => Some(cert.to_owned()),
            _ => None,
        })
        .collect()
}
