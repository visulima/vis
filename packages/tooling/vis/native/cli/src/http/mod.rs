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
//! | `VIS_HTTP_TIMEOUT` | Seconds a whole request may take, all its redirect hops and the body included. Default 30 (a command may pick another default). |
//! | `VIS_HTTP_CONNECT_TIMEOUT` | Seconds the connection (DNS, TCP, TLS) may take. Default 10 (a command may pick another default). |
//! | `ALL_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (and lower case) | Read by `ureq`, which tunnels every request through the proxy with `CONNECT`. |
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
use std::time::{Duration, Instant};

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
    /// `false` returns [`HttpError::Redirect`] for a redirect instead of following it, for a caller that has to
    /// hand the run to something that follows redirects differently.
    pub follow_redirects: bool,
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
            follow_redirects: true,
            extra_ca_files: Vec::new(),
            proxy: None,
            user_agent: "vis".to_owned(),
        }
    }
}

impl HttpConfig {
    /// The settings from the environment. `global_timeout` and `connect_timeout` are the limits when
    /// `VIS_HTTP_TIMEOUT` and `VIS_HTTP_CONNECT_TIMEOUT` are not set, for a caller that has to match limits of its
    /// own.
    pub(crate) fn from_env(global_timeout: Duration, connect_timeout: Duration) -> Self {
        let version = env::var("VIS_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned());

        Self {
            proxy: Proxy::try_from_env(),
            user_agent: format!("vis/{version}"),
            ..Self::from_lookup(&|name| env::var_os(name), global_timeout, connect_timeout)
        }
    }

    /// The settings that come from named variables, read through `lookup` (the proxy is not one of them).
    pub(crate) fn from_lookup(
        lookup: &dyn Fn(&str) -> Option<OsString>,
        global_timeout: Duration,
        connect_timeout: Duration,
    ) -> Self {
        let seconds = |name: &str, default: Duration| {
            lookup(name)
                .and_then(|value| value.to_str().and_then(|text| text.trim().parse::<u64>().ok()))
                .filter(|seconds| *seconds > 0)
                .map_or(default, Duration::from_secs)
        };

        Self {
            global_timeout: seconds("VIS_HTTP_TIMEOUT", global_timeout),
            connect_timeout: seconds("VIS_HTTP_CONNECT_TIMEOUT", connect_timeout),
            extra_ca_files: tls::extra_ca_files(lookup),
            ..Self::default()
        }
    }
}

/// A successful (2xx) response, the body already decompressed.
#[derive(Debug)]
pub(crate) struct Response {
    pub body: Vec<u8>,
}

impl Response {
    pub(crate) fn text(&self) -> Result<&str, HttpError> {
        std::str::from_utf8(&self.body).map_err(|error| HttpError::Decode(format!("the body is not UTF-8: {error}")))
    }

    #[allow(dead_code, reason = "the commands that read a JSON answer are not native yet; the tests cover it")]
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
    #[allow(dead_code, reason = "the commands that POST are not native yet; the tests cover it")]
    pub(crate) fn post_json(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<Response, HttpError> {
        self.send(url, headers, Some(body))
    }

    /// Sends the request and follows redirects itself, because `ureq` would pass every caller header (an API key,
    /// say) on to whatever host a redirect names. See [`next_hop`] for what a hop keeps.
    fn send(&self, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Response, HttpError> {
        let mut url = url.to_owned();
        let mut headers = headers.to_vec();
        let mut body = body;
        // One limit for the whole call: every hop gets what the earlier ones left, not a fresh limit.
        let deadline = Instant::now() + self.config.global_timeout;

        for _ in 0..=MAX_REDIRECTS {
            let host = host_of(&url).to_owned();
            let remaining = deadline.saturating_duration_since(Instant::now());

            if remaining.is_zero() {
                return Err(HttpError::Timeout("global".to_owned()));
            }

            let mut response =
                self.send_once(&url, &headers, body, remaining).map_err(|error| HttpError::from_ureq(error, &host))?;
            let status = response.status().as_u16();
            let location = response.headers().get("location").and_then(|value| value.to_str().ok()).map(str::to_owned);

            if let (true, Some(location)) = (matches!(status, 301 | 302 | 303 | 307 | 308), location) {
                if !self.config.follow_redirects {
                    return Err(HttpError::Redirect(status));
                }

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
                return Ok(Response { body });
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
        time_left: Duration,
    ) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        match body {
            None => {
                let mut request = self.agent().get(url).config().timeout_global(Some(time_left)).build();

                for (name, value) in headers {
                    request = request.header(*name, *value);
                }

                request.call()
            }
            Some(body) => {
                let mut request = self
                    .agent()
                    .post(url)
                    .config()
                    .timeout_global(Some(time_left))
                    .build()
                    .header("content-type", "application/json");

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
/// there; a hop from https to http is refused. A 301, 302 or 303 turns a POST into a GET.
fn next_hop(from: &str, to: &str, status: u16, has_body: bool) -> Result<Hop, HttpError> {
    let (from_origin, to_origin) = (origin(from), origin(to));
    let same_origin = from_origin == to_origin;

    if from_origin.0 == "https" && to_origin.0 != "https" {
        return Err(HttpError::Request(format!("redirect from https to {} refused", to_origin.0)));
    }

    let keeps_method = matches!(status, 307 | 308);

    if has_body && keeps_method && !same_origin {
        return Err(HttpError::Request("redirect of a POST to another origin refused".to_owned()));
    }

    Ok(Hop { keep_headers: same_origin, keep_body: has_body && keeps_method })
}

/// The scheme of `url` and what follows `://` (the whole text, with an empty scheme, when there is none).
fn split_scheme(url: &str) -> (&str, &str) {
    url.split_once("://").unwrap_or(("", url))
}

/// The `host[:port]` of the authority at the start of `rest` (the text after `://`), without a user name or password.
fn host_part(rest: &str) -> &str {
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);

    authority.rsplit_once('@').map_or(authority, |(_, host)| host)
}

/// The lower-cased scheme and `host[:port]` of `url`.
fn origin(url: &str) -> (String, String) {
    let (scheme, rest) = split_scheme(url);

    (scheme.to_ascii_lowercase(), host_part(rest).to_ascii_lowercase())
}

/// `location` resolved against the URL `base` it came from (RFC 3986 section 5.2, without the fragment).
fn resolve(base: &str, location: &str) -> String {
    let has_scheme = location
        .split_once(':')
        .is_some_and(|(scheme, _)| !scheme.is_empty() && scheme.bytes().all(|byte| byte.is_ascii_alphabetic()));

    if has_scheme {
        return location.to_owned();
    }

    let (scheme, rest) = match split_scheme(base) {
        ("", rest) => ("http", rest),
        split => split,
    };
    let (authority, target) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    let location = location.split('#').next().unwrap_or("");

    if let Some(network_path) = location.strip_prefix("//") {
        return format!("{scheme}://{network_path}");
    }

    let (base_path, base_query) = {
        let target = target.split('#').next().unwrap_or("");

        target.split_once('?').map_or((target, ""), |(path, query)| (path, query))
    };
    let base_path = if base_path.is_empty() { "/" } else { base_path };
    let (path, query) = if location.is_empty() {
        (base_path, if base_query.is_empty() { String::new() } else { format!("?{base_query}") })
    } else if let Some((path, query)) = location.split_once('?') {
        (path, format!("?{query}"))
    } else {
        (location, String::new())
    };

    let merged = if path.is_empty() {
        base_path.to_owned()
    } else if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{}{path}", &base_path[..=base_path.rfind('/').unwrap_or(0)])
    };

    format!("{scheme}://{authority}{}{query}", remove_dot_segments(&merged))
}

/// RFC 3986 section 5.2.4 for a path that starts with `/`.
fn remove_dot_segments(path: &str) -> String {
    let segments: Vec<&str> = path.split('/').collect();
    let mut kept: Vec<&str> = Vec::new();

    for (index, segment) in segments.iter().enumerate().skip(1) {
        let last = index == segments.len() - 1;

        match *segment {
            "." if last => kept.push(""),
            "." => {}
            ".." => {
                kept.pop();

                if last {
                    kept.push("");
                }
            }
            other => kept.push(other),
        }
    }

    format!("/{}", kept.join("/"))
}

/// The `host[:port]` of `url` for messages, without a user name or password.
fn host_of(url: &str) -> &str {
    host_part(split_scheme(url).1)
}
