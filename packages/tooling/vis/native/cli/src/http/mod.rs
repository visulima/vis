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
//! | `VIS_HTTP_TIMEOUT` | Seconds a whole request may take, redirects and body included. Default 30. |
//! | `VIS_HTTP_CONNECT_TIMEOUT` | Seconds the connection (DNS, TCP, TLS) may take. Default 10. |
//! | `ALL_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (and lower case) | Read by `ureq` as curl and Node's proxy agents do. |
//! | `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` | A PEM file added to the OS trust store (see [`tls`]). |
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
const MAX_REDIRECTS: u32 = 10;

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
    pub(crate) fn from_env() -> Self {
        Self { proxy: Proxy::try_from_env(), ..Self::from_lookup(&|name| env::var_os(name)) }
    }

    /// The settings that come from named variables, read through `lookup` (the proxy is not one of them).
    pub(crate) fn from_lookup(lookup: &dyn Fn(&str) -> Option<OsString>) -> Self {
        let seconds = |name: &str, default: Duration| {
            lookup(name)
                .and_then(|value| value.to_str().and_then(|text| text.trim().parse::<u64>().ok()))
                .filter(|seconds| *seconds > 0)
                .map_or(default, Duration::from_secs)
        };

        Self {
            global_timeout: seconds("VIS_HTTP_TIMEOUT", DEFAULT_GLOBAL_TIMEOUT),
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
                .max_redirects(MAX_REDIRECTS)
                .http_status_as_error(false)
                .user_agent(self.config.user_agent.as_str())
                .proxy(self.config.proxy.clone())
                .tls_config(tls::tls_config(&self.config.extra_ca_files))
                .build()
                .into()
        })
    }

    pub(crate) fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, HttpError> {
        let mut request = self.agent().get(url);

        for (name, value) in headers {
            request = request.header(*name, *value);
        }

        self.finish(url, request.call())
    }

    /// POSTs `body`, already serialised, with `content-type: application/json`.
    pub(crate) fn post_json(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<Response, HttpError> {
        let mut request = self.agent().post(url).header("content-type", "application/json");

        for (name, value) in headers {
            request = request.header(*name, *value);
        }

        self.finish(url, request.send(body.as_bytes()))
    }

    fn finish(
        &self,
        url: &str,
        sent: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    ) -> Result<Response, HttpError> {
        let host = host_of(url);
        let mut response = sent.map_err(|error| HttpError::from_ureq(error, host))?;
        let status = response.status().as_u16();

        let body = response
            .body_mut()
            .with_config()
            .limit(self.config.max_body)
            .read_to_vec()
            .map_err(|error| HttpError::from_ureq(error, host))?;

        if (200..300).contains(&status) {
            return Ok(Response { status, body });
        }

        Err(HttpError::Status { code: status, body: String::from_utf8_lossy(&body).into_owned() })
    }
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

    CLIENT.get_or_init(|| HttpClient::new(HttpConfig::from_env()))
}
