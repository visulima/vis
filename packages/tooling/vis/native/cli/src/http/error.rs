//! The failures a request can end in, told apart so a caller can print the same text for the same
//! cause on every run. The `Display` strings are part of the contract (parity tests compare them).

use std::fmt;
use std::io;

#[derive(Debug)]
pub(crate) enum HttpError {
    /// The host name did not resolve.
    Dns { host: String },
    /// No connection could be made, or it dropped (refused, reset, aborted, ...).
    Connect(String),
    /// The handshake or the certificate check failed; the text is the verifier's own message.
    Tls(String),
    /// A time limit ran out; the text names the phase (`connect`, `global`, `receive response`, ...).
    Timeout(String),
    /// The server answered outside 200-299 (after following redirects).
    Status {
        code: u16,
        #[allow(dead_code, reason = "the body of an error page is for the commands that print it")]
        body: String,
    },
    /// The body could not be decompressed, or is not the text or JSON the caller asked for.
    Decode(String),
    /// The body is larger than the cap.
    TooLarge { limit: u64 },
    /// A redirect the client was told not to follow.
    Redirect(u16),
    /// Anything else: a bad URL, too many redirects, a protocol error.
    Request(String),
}

impl HttpError {
    /// Maps what `ureq` reports for a request to `host` to one of the cases above.
    pub(crate) fn from_ureq(error: ureq::Error, host: &str) -> Self {
        match error {
            ureq::Error::HostNotFound => Self::Dns { host: host.to_owned() },
            ureq::Error::Timeout(phase) => Self::Timeout(phase.to_string()),
            ureq::Error::ConnectionFailed => Self::Connect("connection failed".to_owned()),
            ureq::Error::Tls(message) => Self::Tls(message.to_owned()),
            ureq::Error::Pem(error) => Self::Tls(format!("invalid certificate: {error:?}")),
            ureq::Error::Rustls(error) => Self::Tls(error.to_string()),
            ureq::Error::BodyExceedsLimit(limit) => Self::TooLarge { limit },
            ureq::Error::Decompress(kind, error) => Self::Decode(format!("{kind} decompression failed: {error}")),
            ureq::Error::Io(error) => Self::from_io(&error, host),
            ureq::Error::ConnectProxyFailed(message) => Self::Connect(format!("proxy: {message}")),
            other => Self::Request(other.to_string()),
        }
    }

    fn from_io(error: &io::Error, host: &str) -> Self {
        // `rustls` reports a failed handshake or certificate check through the stream as an `io::Error`
        // wrapping its own error, so the verifier's message is that error's.
        if let Some(tls) = error.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()) {
            return Self::Tls(tls.to_string());
        }

        if is_lookup_failure(error) {
            return Self::Dns { host: host.to_owned() };
        }

        match error.kind() {
            io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::NotConnected
            | io::ErrorKind::AddrNotAvailable
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::UnexpectedEof => Self::Connect(error.to_string()),
            io::ErrorKind::TimedOut => Self::Timeout("io".to_owned()),
            _ => Self::Request(error.to_string()),
        }
    }
}

/// Whether `error` is the resolver failing. `ureq` resolves through `std`, which reports that as an uncategorised
/// `io::Error` (the platform's text after a fixed prefix), so there is no kind to match on; `WSAHOST_NOT_FOUND`
/// and `WSANO_DATA` are the Windows codes.
fn is_lookup_failure(error: &io::Error) -> bool {
    error.to_string().starts_with("failed to lookup address information")
        || (cfg!(windows) && matches!(error.raw_os_error(), Some(11001 | 11004)))
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Dns { host } => write!(f, "dns: could not resolve {host}"),
            Self::Connect(detail) => write!(f, "connect: {detail}"),
            Self::Tls(detail) => write!(f, "tls: {detail}"),
            Self::Timeout(phase) => write!(f, "timeout: {phase}"),
            Self::Status { code, .. } => write!(f, "http status: {code}"),
            Self::Decode(detail) => write!(f, "decode: {detail}"),
            Self::TooLarge { limit } => write!(f, "response larger than {limit} bytes"),
            Self::Redirect(status) => write!(f, "redirect: status {status} not followed"),
            Self::Request(detail) => write!(f, "request: {detail}"),
        }
    }
}

impl std::error::Error for HttpError {}
