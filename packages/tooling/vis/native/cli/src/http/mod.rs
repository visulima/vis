//! The blocking HTTPS client behind the commands that talk to a registry or an advisory service.
//!
//! It is built on `ureq` with rustls (the `ring` provider), the bundled Mozilla roots and transparent gzip.
//! Nothing here runs at start-up: [`HttpClient::new`] only keeps the settings, and the agent (the connection
//! pool and the TLS configuration, including the OS trust store when one is asked for) is built on the first
//! request. `vis --version` and every command that makes no request never touch it.
//!
//! # Environment
//!
//! | Variable | Effect |
//! | --- | --- |
//! | `VIS_HTTP_TIMEOUT` | Seconds a whole request may take, redirects and body included. Default 30 (a command may pick another default). |
//! | `VIS_HTTP_CONNECT_TIMEOUT` | Seconds the connection (DNS, TCP, TLS) may take. Default 10. |
//! | `ALL_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (and lower case) | Read by `ureq` as curl and Node's proxy agents do. |
//! | `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` | A PEM file added to the OS trust store (see `tls`). |
//!
//! A value that is not a positive whole number of seconds is ignored and the default applies.

mod error;
mod tls;

#[cfg(test)]
mod tests;

use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use ureq::{Agent, Proxy};

pub(crate) use error::HttpError;

const DEFAULT_GLOBAL_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The largest response body read, after decompression.
const DEFAULT_MAX_BODY: u64 = 64 * 1024 * 1024;
/// As many redirects as `fetch` follows, so a command that replaces a `fetch` call gives up at the same hop.
const MAX_REDIRECTS: u32 = 20;

#[derive(Clone, Debug)]
pub(crate) struct HttpConfig {
    pub global_timeout: Duration,
    pub connect_timeout: Duration,
    pub max_body: u64,
    pub extra_ca_files: Vec<PathBuf>,
    /// `None` sends every request direct. [`HttpConfig::from_env`] fills it from the proxy variables.
    pub proxy: Option<Proxy>,
    pub user_agent: String,
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            global_timeout: DEFAULT_GLOBAL_TIMEOUT,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            max_body: DEFAULT_MAX_BODY,
            extra_ca_files: Vec::new(),
            proxy: None,
            user_agent: format!("vis/{}", env!("CARGO_PKG_VERSION")),
        }
    }
}

impl HttpConfig {
    /// The settings from the environment. `global_timeout` is the whole-request limit when `VIS_HTTP_TIMEOUT` is
    /// not set, for a caller that has to match a limit of its own.
    pub(crate) fn from_env(global_timeout: Duration) -> Self {
        Self { proxy: Proxy::try_from_env(), ..Self::from_lookup(&|name| env::var_os(name), global_timeout) }
    }

    /// The settings that come from named variables, read through `lookup` (the proxy is not one of them).
    pub(crate) fn from_lookup(lookup: &dyn Fn(&str) -> Option<OsString>, global_timeout: Duration) -> Self {
        let seconds = |name: &str, default: Duration| {
            lookup(name)
                .and_then(|value| value.to_str().and_then(|text| text.trim().parse::<u64>().ok()))
                .filter(|seconds| *seconds > 0)
                .map_or(default, Duration::from_secs)
        };

        Self {
            global_timeout: seconds("VIS_HTTP_TIMEOUT", global_timeout),
            connect_timeout: seconds("VIS_HTTP_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT),
            extra_ca_files: tls::extra_ca_files(lookup),
            ..Self::default()
        }
    }
}

/// A successful (2xx) response, the body already decompressed.
#[derive(Debug)]
pub(crate) struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    pub(crate) fn text(&self) -> Result<&str, HttpError> {
        std::str::from_utf8(&self.body).map_err(|error| HttpError::Decode(format!("the body is not UTF-8: {error}")))
    }

    pub(crate) fn json(&self) -> Result<serde_json::Value, HttpError> {
        serde_json::from_slice(&self.body).map_err(|error| HttpError::Decode(format!("the body is not JSON: {error}")))
    }
}

pub(crate) struct HttpClient {
    config: HttpConfig,
    agent: OnceLock<Agent>,
}

impl HttpClient {
    /// Keeps `config`; builds nothing.
    pub(crate) fn new(config: HttpConfig) -> Self {
        Self { config, agent: OnceLock::new() }
    }

    /// Whether the first request has built the agent yet.
    #[cfg(test)]
    fn is_built(&self) -> bool {
        self.agent.get().is_some()
    }

    fn agent(&self) -> &Agent {
        self.agent.get_or_init(|| {
            Agent::config_builder()
                .timeout_global(Some(self.config.global_timeout))
                .timeout_connect(Some(self.config.connect_timeout))
                .max_redirects(0)
                .max_redirects_will_error(false)
                .http_status_as_error(false)
                .user_agent(self.config.user_agent.as_str())
                .proxy(self.config.proxy.clone())
                .tls_config(tls::tls_config(&self.config.extra_ca_files))
                .build()
                .into()
        })
    }

    pub(crate) fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, HttpError> {
        self.send(url, headers, None)
    }

    /// POSTs `body`, already serialised, with `content-type: application/json`.
    pub(crate) fn post_json(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<Response, HttpError> {
        self.send(url, headers, Some(body))
    }

    /// Sends the request and follows redirects itself, because `ureq` would pass every caller header (an API key,
    /// say) on to whatever host a redirect names. See [`next_hop`] for what a hop keeps.
    fn send(&self, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Response, HttpError> {
        let mut url = url.to_owned();
        let mut headers = headers.to_vec();
        let mut body = body;

        for _ in 0..=MAX_REDIRECTS {
            let host = host_of(&url).to_owned();
            let mut response =
                self.send_once(&url, &headers, body).map_err(|error| HttpError::from_ureq(error, &host))?;
            let status = response.status().as_u16();
            let location = response.headers().get("location").and_then(|value| value.to_str().ok()).map(str::to_owned);

            if let (true, Some(location)) = (matches!(status, 301 | 302 | 303 | 307 | 308), location) {
                let target = resolve(&url, &location);
                let hop = next_hop(&url, &target, status, body.is_some())?;

                if !hop.keep_headers {
                    headers.retain(|(name, _)| name.eq_ignore_ascii_case("accept"));
                }

                if !hop.keep_body {
                    body = None;
                }

                url = target;
                continue;
            }

            let body = response
                .body_mut()
                .with_config()
                .limit(self.config.max_body)
                .read_to_vec()
                .map_err(|error| HttpError::from_ureq(error, &host))?;

            if (200..300).contains(&status) {
                return Ok(Response { status, body });
            }

            return Err(HttpError::Status { code: status, body: String::from_utf8_lossy(&body).into_owned() });
        }

        Err(HttpError::Request("too many redirects".to_owned()))
    }

    fn send_once(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        match body {
            None => {
                let mut request = self.agent().get(url);

                for (name, value) in headers {
                    request = request.header(*name, *value);
                }

                request.call()
            }
            Some(body) => {
                let mut request = self.agent().post(url).header("content-type", "application/json");

                for (name, value) in headers {
                    request = request.header(*name, *value);
                }

                request.send(body.as_bytes())
            }
        }
    }
}

/// What the next request of a redirect keeps from the one before.
struct Hop {
    keep_headers: bool,
    keep_body: bool,
}

/// How to follow a redirect from `from` to `to` with `status`. A hop to another origin (scheme, host or port)
/// keeps no caller header but `accept`, so a credential never leaves its origin, and a body is not re-sent
/// there; a hop from https to http is refused. As in curl, a 301, 302 or 303 turns a POST into a GET.
fn next_hop(from: &str, to: &str, status: u16, has_body: bool) -> Result<Hop, HttpError> {
    let same_origin = origin(from) == origin(to);

    if origin(from).0 == "https" && origin(to).0 != "https" {
        return Err(HttpError::Request(format!("redirect from https to {} refused", origin(to).0)));
    }

    let keeps_method = matches!(status, 307 | 308);

    if has_body && keeps_method && !same_origin {
        return Err(HttpError::Request("redirect of a POST to another origin refused".to_owned()));
    }

    Ok(Hop { keep_headers: same_origin, keep_body: has_body && keeps_method })
}

/// The lower-cased scheme and `host[:port]` of `url`, without a user name or password.
fn origin(url: &str) -> (String, String) {
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));

    (scheme.to_ascii_lowercase(), host_of(rest).to_ascii_lowercase())
}

/// `location` resolved against the URL `base` it came from. Dot segments are left for the server.
fn resolve(base: &str, location: &str) -> String {
    let has_scheme = location
        .split_once(':')
        .is_some_and(|(scheme, _)| !scheme.is_empty() && scheme.bytes().all(|byte| byte.is_ascii_alphabetic()));

    if has_scheme {
        return location.to_owned();
    }

    let (scheme, rest) = base.split_once("://").unwrap_or(("http", base));
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(authority_end);

    if let Some(network_path) = location.strip_prefix("//") {
        return format!("{scheme}://{network_path}");
    }

    if location.starts_with('/') {
        return format!("{scheme}://{authority}{location}");
    }

    let path = path.split(['?', '#']).next().unwrap_or("");
    let directory = &path[..path.rfind('/').map_or(0, |index| index + 1)];

    format!("{scheme}://{authority}{}{location}", if directory.is_empty() { "/" } else { directory })
}

/// The `host[:port]` of `url` for messages, without a user name or password.
fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);

    authority.rsplit_once('@').map_or(authority, |(_, host)| host)
}

/// The process-wide client, configured from the environment on first use.
pub(crate) fn shared() -> &'static HttpClient {
    static CLIENT: OnceLock<HttpClient> = OnceLock::new();

    CLIENT.get_or_init(|| HttpClient::new(HttpConfig::from_env(DEFAULT_GLOBAL_TIMEOUT)))
}
