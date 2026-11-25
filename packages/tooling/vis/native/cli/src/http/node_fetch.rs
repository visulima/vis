//! What a command that replaces a Node `fetch` call has to check before it answers: the environment and the URL
//! must lead `fetch` and this client to the same server the same way, and the limits and redirects must be `fetch`'s.
//! A run that fails a check is handed to Node whole.

use std::env;
use std::time::Duration;

use super::HttpConfig;

/// `fetch` refuses a fixed list of ports, and the highest on it is 10080.
const LOWEST_UNBLOCKED_PORT: u32 = 10081;

/// Variables that change how Node's `fetch` reaches a server or whom it trusts, or that this client reads
/// differently: the proxy variables (and Node's switch for reading them), the CA files, and the Node options.
/// `NO_PROXY` alone changes nothing. The launcher keeps the same list in `networkEnvironmentIsPlain`
/// (`bin/route.mjs`); the shared cases of `native/cli/tests/fixtures/routing.json` fail when the two differ.
const NETWORK_VARIABLES: [&str; 12] = [
    "ALL_PROXY",
    "all_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NODE_USE_ENV_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_OPTIONS",
];

/// Whether none of [`NETWORK_VARIABLES`] is set.
pub(crate) fn network_environment_is_plain() -> bool {
    NETWORK_VARIABLES.iter().all(|name| env::var_os(name).is_none())
}

/// `config` with the one fixed limit a Node module gives its `fetch` (`limit`) whatever `VIS_HTTP_TIMEOUT` and
/// `VIS_HTTP_CONNECT_TIMEOUT` say, and with redirects left to Node: `fetch` follows a different set of them than
/// the client does (https to http, the ports and credentials of the target), so a run that meets one is handed
/// over whole.
pub(crate) fn fetch_config(config: HttpConfig, limit: Duration) -> HttpConfig {
    HttpConfig { follow_redirects: false, global_timeout: limit, connect_timeout: limit, ..config }
}

/// A URL `fetch` and this client read the same way: lower-case `http` or `https`, printable ASCII without
/// backslashes, a fragment or an IPv6 literal, no user name or password, and no port from the list `fetch` refuses.
pub(crate) fn url_is_plain(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) else {
        return false;
    };

    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    let port_is_allowed = authority
        .rsplit_once(':')
        .is_none_or(|(_, port)| port.parse::<u32>().is_ok_and(|port| port >= LOWEST_UNBLOCKED_PORT));

    !authority.is_empty()
        && !authority.contains(['@', '['])
        && port_is_allowed
        && url.bytes().all(|byte| byte.is_ascii_graphic() && byte != b'\\' && byte != b'#')
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMIT: Duration = Duration::from_secs(15);

    #[test]
    fn the_request_keeps_the_fixed_limit_whatever_the_environment_says() {
        let from_environment = HttpConfig::from_lookup(
            &|name| match name {
                "VIS_HTTP_TIMEOUT" => Some("90".into()),
                "VIS_HTTP_CONNECT_TIMEOUT" => Some("3".into()),
                _ => None,
            },
            LIMIT,
            LIMIT,
        );

        assert_eq!(from_environment.global_timeout, Duration::from_secs(90));

        let config = fetch_config(from_environment, LIMIT);

        assert_eq!((config.global_timeout, config.connect_timeout), (LIMIT, LIMIT));
        assert!(!config.follow_redirects);
    }

    #[test]
    fn a_url_must_be_plain() {
        for plain in [
            "https://registry.npmjs.org/-/npm/v1/keys",
            "http://127.0.0.1:49152/keys",
            "http://localhost/keys?a=1",
            "https://example.test:443/x",
        ] {
            assert!(url_is_plain(plain) == !plain.ends_with(":443/x"), "{plain}");
        }

        for odd in [
            "",
            "HTTP://a.test/",
            "file:///etc/passwd",
            "ftp://a.test/",
            "https://user:pw@a.test/",
            "http://a.test:6667/",
            "http://a.test:80/",
            "http://a.test/ x",
            "http://a.test/#f",
            "http://a.test\\x",
            "http://[::1]:49152/",
            "http://",
            "/relative",
        ] {
            assert!(!url_is_plain(odd), "{odd}");
        }
    }
}
