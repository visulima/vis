//! Every request goes to a stub on 127.0.0.1: a `TcpListener` thread for HTTP, redirects, gzip, POST,
//! timeouts and proxies, and the same behind rustls with a certificate generated here for TLS. Nothing leaves
//! the machine.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use ureq::{Proxy, ProxyProtocol};

use super::{host_of, next_hop, resolve, tls, HttpClient, HttpConfig, HttpError};

#[derive(Clone, Debug)]
struct Seen {
    request_line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

struct Stub {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Stub {
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn read_request(stream: &mut impl Read) -> Option<Seen> {
    let mut data = Vec::new();
    let mut chunk = [0_u8; 1024];

    let head_end = loop {
        if let Some(index) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }

        let read = stream.read(&mut chunk).ok()?;

        if read == 0 {
            return None;
        }

        data.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .collect();
    let length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = data[head_end..].to_vec();

    while body.len() < length {
        let read = stream.read(&mut chunk).ok()?;

        if read == 0 {
            break;
        }

        body.extend_from_slice(&chunk[..read]);
    }

    Some(Seen { request_line, headers, body })
}

fn reply(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n", body.len()).into_bytes();

    for (name, value) in headers {
        out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
    }

    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out
}

fn ok(body: &str) -> Vec<u8> {
    reply("200 OK", &[], body.as_bytes())
}

fn spawn(handler: impl Fn(&Seen) -> Vec<u8> + Send + Sync + 'static) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let handler = Arc::new(handler);
    let log = Arc::clone(&seen);

    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let handler = Arc::clone(&handler);
            let log = Arc::clone(&log);

            thread::spawn(move || {
                if let Some(request) = read_request(&mut stream) {
                    let response = handler(&request);

                    log.lock().unwrap().push(request);
                    let _ = stream.write_all(&response);
                }
            });
        }
    });

    Stub { port, seen }
}

fn client() -> HttpClient {
    HttpClient::new(HttpConfig { global_timeout: Duration::from_secs(10), ..HttpConfig::default() })
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0_u32;

    for byte in data {
        crc ^= u32::from(*byte);

        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }

    !crc
}

/// A gzip member holding `data` in one stored deflate block (valid, just not smaller).
fn gzip(data: &[u8]) -> Vec<u8> {
    let length = u16::try_from(data.len()).unwrap();
    let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff, 1];

    out.extend_from_slice(&length.to_le_bytes());
    out.extend_from_slice(&(!length).to_le_bytes());
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
    out
}

#[test]
fn building_a_client_does_not_build_the_agent() {
    let client = client();

    assert!(!client.is_built());

    let stub = spawn(|_| ok("hi"));

    client.get(&stub.url("/"), &[]).unwrap();
    assert!(client.is_built());
}

#[test]
fn get_returns_status_and_body_and_sends_the_headers() {
    let stub = spawn(|_| ok("{\"a\":1}"));
    let response = client().get(&stub.url("/pkg?x=1"), &[("accept", "application/json")]).unwrap();

    assert_eq!(response.text().unwrap(), "{\"a\":1}");
    assert_eq!(response.json().unwrap()["a"], 1);

    let seen = &stub.requests()[0];

    assert_eq!(seen.request_line, "GET /pkg?x=1 HTTP/1.1");
    assert_eq!(seen.header("accept"), Some("application/json"));
    assert_eq!(seen.header("user-agent"), Some("vis"));
}

#[test]
fn get_follows_redirects() {
    let stub = spawn(|seen| {
        if seen.request_line.starts_with("GET /start") {
            reply("302 Found", &[("location", "/middle")], b"")
        } else if seen.request_line.starts_with("GET /middle") {
            reply("301 Moved Permanently", &[("location", "/end")], b"")
        } else {
            ok("arrived")
        }
    });

    assert_eq!(client().get(&stub.url("/start"), &[]).unwrap().text().unwrap(), "arrived");
    assert_eq!(stub.requests().len(), 3);
}

#[test]
fn a_redirect_to_another_origin_keeps_no_header_but_accept() {
    let far = spawn(|_| ok("far"));
    let far_url = far.url("/landed");
    let near = spawn(move |seen| {
        if seen.request_line.starts_with("GET /back") {
            reply("302 Found", &[("location", "/same")], b"")
        } else if seen.request_line.starts_with("GET /same") {
            ok("near")
        } else {
            reply("302 Found", &[("location", &far_url)], b"")
        }
    });
    let headers = [("accept", "application/json"), ("x-api-key", "secret"), ("authorization", "Bearer t")];

    assert_eq!(client().get(&near.url("/out"), &headers).unwrap().text().unwrap(), "far");

    let landed = &far.requests()[0];

    assert_eq!(landed.header("accept"), Some("application/json"));
    assert_eq!(landed.header("x-api-key"), None);
    assert_eq!(landed.header("authorization"), None);

    // The same origin keeps all of them.
    assert_eq!(client().get(&near.url("/back"), &headers).unwrap().text().unwrap(), "near");
    assert_eq!(near.requests().last().unwrap().header("x-api-key"), Some("secret"));
}

#[test]
fn a_post_redirected_with_303_becomes_a_get_and_with_307_is_not_sent_elsewhere() {
    let target = spawn(|_| ok("target"));
    let target_url = target.url("/t");
    let origin = spawn(move |seen| {
        let status = if seen.request_line.contains("/see-other") { "303 See Other" } else { "307 Temporary Redirect" };

        reply(status, &[("location", &target_url)], b"")
    });

    let converted = client().post_json(&origin.url("/see-other"), &[], "{\"a\":1}").unwrap();

    assert_eq!(converted.text().unwrap(), "target");
    assert_eq!(target.requests()[0].request_line, "GET /t HTTP/1.1");
    assert!(target.requests()[0].body.is_empty());

    let refused = client().post_json(&origin.url("/temporary"), &[], "{\"a\":1}").unwrap_err();

    assert_eq!(refused.to_string(), "request: redirect of a POST to another origin refused");
    assert_eq!(target.requests().len(), 1);
}

#[test]
fn a_redirect_from_https_to_http_is_refused() {
    assert_eq!(
        next_hop("https://a.test/x", "http://a.test/y", 302, false).err().unwrap().to_string(),
        "request: redirect from https to http refused"
    );
    assert!(!next_hop("http://a.test/x", "https://a.test/y", 302, false).unwrap().keep_headers);
    // A spelled-out default port is another origin here: the check errs on the side of dropping headers.
    assert!(!next_hop("https://a.test/x", "https://A.test:443/y", 302, false).unwrap().keep_headers);
    assert!(next_hop("https://a.test/x", "https://a.test/y", 302, false).unwrap().keep_headers);
}

#[test]
fn a_url_in_a_query_does_not_make_two_origins_one() {
    let hop = next_hop("https://a.test/x", "https://sso.test/login?return=https://a.test/x", 302, false).unwrap();

    assert!(!hop.keep_headers);
    assert!(
        !next_hop("https://a.test/x?back=https://sso.test/y", "https://sso.test/z", 302, false).unwrap().keep_headers
    );
    assert!(next_hop("https://a.test/x?back=https://sso.test/y", "https://a.test/z", 302, false).unwrap().keep_headers);
}

#[test]
fn a_redirect_is_reported_when_following_is_off() {
    let stub = spawn(|_| reply("302 Found", &[("location", "/elsewhere")], b""));
    let strict = HttpClient::new(HttpConfig { follow_redirects: false, ..HttpConfig::default() });
    let error = strict.get(&stub.url("/"), &[]).unwrap_err();

    assert!(matches!(error, HttpError::Redirect(302)), "{error:?}");
    assert_eq!(error.to_string(), "redirect: status 302 not followed");
    assert_eq!(stub.requests().len(), 1);
}

#[test]
fn a_location_is_resolved_against_the_url_it_came_from() {
    let base = "https://reg.test:8443/a/b/c?q=1#f";

    assert_eq!(resolve(base, "https://other.test/z"), "https://other.test/z");
    assert_eq!(resolve(base, "//cdn.test/z"), "https://cdn.test/z");
    assert_eq!(resolve(base, "/root?x=http://y"), "https://reg.test:8443/root?x=http://y");
    assert_eq!(resolve(base, "d"), "https://reg.test:8443/a/b/d");
    assert_eq!(resolve("https://reg.test", "d"), "https://reg.test/d");
    assert_eq!(resolve(base, "?page=2"), "https://reg.test:8443/a/b/c?page=2");
    assert_eq!(resolve(base, "#frag"), "https://reg.test:8443/a/b/c?q=1");
    assert_eq!(resolve(base, ""), "https://reg.test:8443/a/b/c?q=1");
    assert_eq!(resolve(base, "../d"), "https://reg.test:8443/a/d");
    assert_eq!(resolve(base, "../../../d?x=1#f"), "https://reg.test:8443/d?x=1");
    assert_eq!(resolve(base, "./e/./f/.."), "https://reg.test:8443/a/b/e/");
    assert_eq!(resolve(base, "/p/../q"), "https://reg.test:8443/q");
    assert_eq!(resolve("https://reg.test/a/b?x=1", "c"), "https://reg.test/a/c");
}

#[test]
fn a_redirect_loop_ends_in_an_error() {
    let stub = spawn(|_| reply("302 Found", &[("location", "/again")], b""));

    assert!(
        matches!(client().get(&stub.url("/again"), &[]), Err(HttpError::Request(message)) if message.contains("redirects"))
    );
}

#[test]
fn post_json_sends_the_body_and_the_content_type() {
    let stub = spawn(|_| ok("{}"));
    client().post_json(&stub.url("/bulk"), &[("x-key", "v")], "{\"a\":[1,2]}").unwrap();

    let seen = &stub.requests()[0];

    assert_eq!(seen.request_line, "POST /bulk HTTP/1.1");
    assert_eq!(seen.header("content-type"), Some("application/json"));
    assert_eq!(seen.header("x-key"), Some("v"));
    assert_eq!(seen.body, b"{\"a\":[1,2]}");
}

#[test]
fn a_gzip_body_is_decoded_and_the_request_asks_for_it() {
    let stub = spawn(|_| reply("200 OK", &[("content-encoding", "gzip")], &gzip(b"{\"zipped\":true}")));
    let response = client().get(&stub.url("/"), &[]).unwrap();

    assert_eq!(response.json().unwrap()["zipped"], true);
    assert!(stub.requests()[0].header("accept-encoding").unwrap().contains("gzip"));
}

#[test]
fn a_broken_gzip_body_is_a_decode_error() {
    let stub = spawn(|_| reply("200 OK", &[("content-encoding", "gzip")], b"definitely not gzip"));
    let error = client().get(&stub.url("/"), &[]).unwrap_err();

    assert!(matches!(error, HttpError::Decode(_)), "{error:?}");
    assert!(error.to_string().starts_with("decode: "));
}

#[test]
fn a_body_that_is_not_the_asked_for_type_is_a_decode_error() {
    let stub = spawn(|_| reply("200 OK", &[], &[0xff, 0xfe, b'x']));
    let response = client().get(&stub.url("/"), &[]).unwrap();

    assert!(matches!(response.text(), Err(HttpError::Decode(_))));
    assert!(matches!(response.json(), Err(HttpError::Decode(_))));
}

#[test]
fn a_non_2xx_status_is_an_error_that_keeps_the_body() {
    let stub = spawn(|_| reply("404 Not Found", &[], b"nope"));
    let error = client().get(&stub.url("/missing"), &[]).unwrap_err();

    assert!(matches!(error, HttpError::Status { code: 404, .. }));
    assert_eq!(error.to_string(), "http status: 404");
    assert!(matches!(&error, HttpError::Status { body, .. } if body == "nope"));
}

#[test]
fn a_slow_server_hits_the_global_timeout() {
    let stub = spawn(|_| {
        thread::sleep(Duration::from_secs(3));
        ok("late")
    });
    let slow = HttpClient::new(HttpConfig { global_timeout: Duration::from_millis(300), ..HttpConfig::default() });
    let error = slow.get(&stub.url("/"), &[]).unwrap_err();

    assert!(matches!(error, HttpError::Timeout(_)), "{error:?}");
    assert!(error.to_string().starts_with("timeout: "));
}

#[test]
fn a_body_over_the_cap_is_too_large() {
    let stub = spawn(|_| ok(&"x".repeat(100)));
    let small = HttpClient::new(HttpConfig { max_body: 10, ..HttpConfig::default() });
    let error = small.get(&stub.url("/"), &[]).unwrap_err();

    assert!(matches!(error, HttpError::TooLarge { limit: 10 }), "{error:?}");
    assert_eq!(error.to_string(), "response larger than 10 bytes");
}

#[test]
fn a_refused_connection_is_a_connect_error() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();

        listener.local_addr().unwrap().port()
    };
    let error = client().get(&format!("http://127.0.0.1:{port}/"), &[]).unwrap_err();

    assert!(matches!(error, HttpError::Connect(_)), "{error:?}");
    assert!(error.to_string().starts_with("connect: "));
}

#[test]
fn the_resolver_failing_is_a_dns_error() {
    // What `std` reports for a failed lookup: an uncategorised error with the platform's text after this prefix.
    let lookup = std::io::Error::other("failed to lookup address information: Name or service not known");
    let error = HttpError::from_ureq(ureq::Error::Io(lookup), "registry.example");

    assert_eq!(error.to_string(), "dns: could not resolve registry.example");
    assert!(matches!(HttpError::from_ureq(ureq::Error::Io(std::io::Error::other("boom")), "h"), HttpError::Request(_)));
}

/// Asks a real resolver, so it stays out of the default run.
#[test]
#[ignore = "sends one DNS query"]
fn an_unresolvable_host_is_a_dns_error() {
    // `.invalid` never resolves (RFC 6761), so the lookup fails without anything being reachable.
    let error = client().get("http://nothing.invalid/", &[]).unwrap_err();

    assert!(matches!(&error, HttpError::Dns { host } if host == "nothing.invalid"), "{error:?}");
    assert_eq!(error.to_string(), "dns: could not resolve nothing.invalid");
}

#[test]
fn ureq_errors_map_to_stable_messages() {
    use ureq::Timeout;

    let host = host_of("https://user:secret@registry.example:8443/path?q=1");

    assert_eq!(host, "registry.example:8443");
    assert_eq!(
        HttpError::from_ureq(ureq::Error::HostNotFound, host).to_string(),
        "dns: could not resolve registry.example:8443"
    );
    assert_eq!(HttpError::from_ureq(ureq::Error::Timeout(Timeout::Connect), host).to_string(), "timeout: connect");
    assert_eq!(HttpError::from_ureq(ureq::Error::Timeout(Timeout::Global), host).to_string(), "timeout: global");
    assert_eq!(HttpError::from_ureq(ureq::Error::ConnectionFailed, host).to_string(), "connect: connection failed");
    assert_eq!(HttpError::from_ureq(ureq::Error::Tls("handshake failed"), host).to_string(), "tls: handshake failed");
    assert_eq!(
        HttpError::from_ureq(ureq::Error::BodyExceedsLimit(5), host).to_string(),
        "response larger than 5 bytes"
    );
    assert_eq!(HttpError::from_ureq(ureq::Error::TooManyRedirects, host).to_string(), "request: too many redirects");
}

#[test]
fn timeouts_come_from_one_variable_each() {
    let from = |pairs: &[(&str, &str)]| {
        let map: HashMap<String, OsString> =
            pairs.iter().map(|(key, value)| ((*key).to_owned(), OsString::from(value))).collect();

        HttpConfig::from_lookup(&move |name| map.get(name).cloned(), Duration::from_secs(30), Duration::from_secs(10))
    };

    let defaults = from(&[]);
    let own_default = HttpConfig::from_lookup(&|_| None, Duration::from_secs(15), Duration::from_secs(12));

    assert_eq!(
        (own_default.global_timeout, own_default.connect_timeout),
        (Duration::from_secs(15), Duration::from_secs(12))
    );

    assert_eq!((defaults.global_timeout, defaults.connect_timeout), (Duration::from_secs(30), Duration::from_secs(10)));
    assert_eq!(defaults.max_body, 64 * 1024 * 1024);

    let set = from(&[("VIS_HTTP_TIMEOUT", "90"), ("VIS_HTTP_CONNECT_TIMEOUT", " 3 ")]);

    assert_eq!((set.global_timeout, set.connect_timeout), (Duration::from_secs(90), Duration::from_secs(3)));

    for bad in ["0", "-1", "1.5", "soon", ""] {
        let config = from(&[("VIS_HTTP_TIMEOUT", bad), ("VIS_HTTP_CONNECT_TIMEOUT", bad)]);

        assert_eq!(
            (config.global_timeout, config.connect_timeout),
            (Duration::from_secs(30), Duration::from_secs(10)),
            "{bad:?}"
        );
    }
}

#[test]
fn extra_ca_files_come_from_the_two_variables_when_set_and_not_empty() {
    let lookup = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| OsString::from(value))
    };

    assert!(tls::extra_ca_files(&lookup(&[])).is_empty());
    assert!(tls::extra_ca_files(&lookup(&[("NODE_EXTRA_CA_CERTS", "")])).is_empty());
    assert_eq!(tls::extra_ca_files(&lookup(&[("SSL_CERT_FILE", "/etc/a.pem")])), [PathBuf::from("/etc/a.pem")]);
    assert_eq!(
        tls::extra_ca_files(&lookup(&[("NODE_EXTRA_CA_CERTS", "/x.pem"), ("SSL_CERT_FILE", "/y.pem")])),
        [PathBuf::from("/x.pem"), PathBuf::from("/y.pem")]
    );
}

fn proxy_to(port: u16, no_proxy: Option<&str>) -> Proxy {
    let mut builder = Proxy::builder(ProxyProtocol::Http).host("127.0.0.1").port(port);

    if let Some(expression) = no_proxy {
        builder = builder.no_proxy(expression);
    }

    builder.build().unwrap()
}

#[test]
fn a_request_goes_through_the_proxy_and_no_proxy_bypasses_it() {
    let origin = spawn(|_| ok("from origin"));
    // `ureq` tunnels every request through a proxy with CONNECT, so the stub answers CONNECT and copies the bytes
    // to the origin stub, whatever host the client asked for.
    let proxy = spawn_connect_proxy(origin.port);

    // A host that does not resolve proves the request was sent to the proxy.
    let proxied = HttpClient::new(HttpConfig { proxy: Some(proxy_to(proxy.port, None)), ..HttpConfig::default() });

    assert_eq!(proxied.get("http://origin.invalid/path", &[]).unwrap().text().unwrap(), "from origin");
    assert_eq!(proxy.requests()[0].request_line, "CONNECT origin.invalid:80 HTTP/1.1");
    assert_eq!(origin.requests()[0].request_line, "GET /path HTTP/1.1");

    let bypassed =
        HttpClient::new(HttpConfig { proxy: Some(proxy_to(proxy.port, Some("127.0.0.1"))), ..HttpConfig::default() });

    assert_eq!(bypassed.get(&origin.url("/direct"), &[]).unwrap().text().unwrap(), "from origin");
    assert_eq!(proxy.requests().len(), 1);
    assert_eq!(origin.requests().len(), 2);
}

/// The child half of [`the_proxy_variables_are_read_from_the_environment`]: only does anything when the parent
/// started it, with the variables set before the process began.
#[test]
fn proxy_env_child() {
    let Ok(url) = std::env::var("VIS_HTTP_TEST_URL") else { return };
    let response =
        HttpClient::new(HttpConfig::from_env(Duration::from_secs(30), Duration::from_secs(10))).get(&url, &[]).unwrap();

    println!("BODY={}", response.text().unwrap());
}

#[test]
fn the_proxy_variables_are_read_from_the_environment() {
    let origin = spawn(|_| ok("from origin"));
    let proxy = spawn_connect_proxy(origin.port);
    let proxy_url = format!("http://127.0.0.1:{}", proxy.port);

    let run = |url: &str, extra: &[(&str, &str)]| {
        let mut command = Command::new(std::env::current_exe().unwrap());

        command
            .args(["--exact", "http::tests::proxy_env_child", "--nocapture", "--test-threads=1"])
            .env("VIS_HTTP_TEST_URL", url);

        for name in
            ["ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]
        {
            command.env_remove(name);
        }

        for (name, value) in extra {
            command.env(name, value);
        }

        let output = command.output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();

        assert!(output.status.success(), "{stdout}{}", String::from_utf8_lossy(&output.stderr));
        stdout
    };

    // The host does not resolve, so only the proxy can have answered.
    assert!(run("http://origin.invalid/a", &[("HTTP_PROXY", &proxy_url)]).contains("BODY=from origin"));
    assert!(run("http://origin.invalid/a", &[("ALL_PROXY", &proxy_url)]).contains("BODY=from origin"));
    assert_eq!(proxy.requests().len(), 2);

    assert!(
        run(&origin.url("/b"), &[("HTTP_PROXY", &proxy_url), ("NO_PROXY", "127.0.0.1")]).contains("BODY=from origin")
    );
    assert!(run(&origin.url("/c"), &[]).contains("BODY=from origin"));
    assert_eq!(proxy.requests().len(), 2);
    assert_eq!(origin.requests().len(), 4);
}

#[test]
fn without_an_extra_file_only_the_bundled_roots_are_used() {
    assert!(matches!(tls::tls_config(&[]).root_certs(), ureq::tls::RootCerts::WebPki));
}

#[test]
fn an_extra_file_adds_to_the_os_store_instead_of_replacing_it() {
    let ureq::tls::RootCerts::Specific(without) =
        tls::tls_config(&[PathBuf::from("/nonexistent.pem")]).root_certs().clone()
    else {
        panic!("an extra file switches to an explicit list");
    };
    let generated = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_owned()]).unwrap();
    let file = std::env::temp_dir().join(format!("vis-http-test-{}-added.pem", std::process::id()));

    std::fs::write(&file, generated.cert.pem()).unwrap();

    let ureq::tls::RootCerts::Specific(with) = tls::tls_config(&[file]).root_certs().clone() else {
        panic!("explicit list")
    };

    assert_eq!(with.len(), without.len() + 1);
    // Every machine this runs on has a trust store; a bare container may be the exception, so only macOS asserts it.
    #[cfg(target_os = "macos")]
    assert!(without.len() > 50, "{}", without.len());
}

mod tls_stub {
    use std::sync::Arc;

    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::{ServerConfig, ServerConnection, StreamOwned};

    use super::*;

    pub struct TlsStub {
        pub port: u16,
        pub ca_pem: String,
    }

    /// A TLS server on 127.0.0.1 with a fresh self-signed certificate for that address.
    pub fn spawn_tls(body: &'static str) -> TlsStub {
        let generated = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_owned()]).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = Arc::new(
            ServerConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(generated.cert.der().to_vec())],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(generated.key_pair.serialize_der())),
                )
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let config = Arc::clone(&config);

                thread::spawn(move || {
                    let Ok(connection) = ServerConnection::new(config) else { return };
                    let mut stream = StreamOwned::new(connection, stream);

                    // A client that rejects the certificate ends the handshake here, which is the point.
                    if read_request(&mut stream).is_some() {
                        let _ = stream.write_all(&ok(body));
                        stream.conn.send_close_notify();
                        let _ = stream.flush();
                    }
                });
            }
        });

        TlsStub { port, ca_pem: generated.cert.pem() }
    }
}

fn with_extra_ca(pem: &str, name: &str) -> HttpClient {
    let file = std::env::temp_dir().join(format!("vis-http-test-{}-{name}.pem", std::process::id()));

    std::fs::write(&file, pem).unwrap();
    HttpClient::new(HttpConfig {
        extra_ca_files: vec![file],
        global_timeout: Duration::from_secs(10),
        ..HttpConfig::default()
    })
}

#[test]
fn the_default_roots_reject_a_self_signed_server() {
    let stub = tls_stub::spawn_tls("secret");
    let error = client().get(&format!("https://127.0.0.1:{}/", stub.port), &[]).unwrap_err();

    assert!(matches!(&error, HttpError::Tls(message) if message.contains("UnknownIssuer")), "{error:?}");
    assert!(error.to_string().starts_with("tls: "));
}

#[test]
fn an_extra_ca_file_makes_the_same_server_trusted() {
    let stub = tls_stub::spawn_tls("secret");
    let trusting = with_extra_ca(&stub.ca_pem, "trusted");
    let response = trusting.get(&format!("https://127.0.0.1:{}/", stub.port), &[]).unwrap();

    assert_eq!(response.text().unwrap(), "secret");
}

#[test]
fn an_unrelated_extra_ca_file_does_not_make_it_trusted() {
    let stub = tls_stub::spawn_tls("secret");
    let other = tls_stub::spawn_tls("other");
    let trusting = with_extra_ca(&other.ca_pem, "unrelated");

    assert!(matches!(trusting.get(&format!("https://127.0.0.1:{}/", stub.port), &[]), Err(HttpError::Tls(_))));
}

#[test]
fn an_unreadable_extra_ca_file_is_ignored_like_node_does() {
    let stub = tls_stub::spawn_tls("secret");
    let missing = HttpClient::new(HttpConfig {
        extra_ca_files: vec![std::env::temp_dir().join("vis-http-test-no-such-file.pem")],
        ..HttpConfig::default()
    });

    assert!(matches!(missing.get(&format!("https://127.0.0.1:{}/", stub.port), &[]), Err(HttpError::Tls(_))));
}

#[test]
fn https_goes_through_a_connect_proxy() {
    let stub = tls_stub::spawn_tls("tunnelled");
    let target_port = stub.port;
    let proxy = spawn_connect_proxy(target_port);
    let trusting = with_extra_ca(&stub.ca_pem, "tunnel");
    let config = HttpConfig { proxy: Some(proxy_to(proxy.port, None)), ..trusting.config.clone() };
    let through = HttpClient::new(config);

    assert_eq!(through.get(&format!("https://127.0.0.1:{target_port}/"), &[]).unwrap().text().unwrap(), "tunnelled");
    assert!(proxy.seen.lock().unwrap()[0].request_line.starts_with("CONNECT 127.0.0.1:"));
}

/// A proxy that answers `CONNECT` and then copies bytes both ways to the stub on `target_port`.
fn spawn_connect_proxy(target_port: u16) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);

    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut client) = stream else { continue };
            let log = Arc::clone(&log);

            thread::spawn(move || {
                let Some(request) = read_request(&mut client) else { return };

                log.lock().unwrap().push(request);

                let Ok(upstream) = TcpStream::connect(("127.0.0.1", target_port)) else { return };

                if client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").is_err() {
                    return;
                }

                let (mut client_read, mut upstream_write) =
                    (client.try_clone().unwrap(), upstream.try_clone().unwrap());
                let (mut upstream_read, mut client_write) = (upstream, client);

                thread::spawn(move || {
                    let _ = std::io::copy(&mut client_read, &mut upstream_write);
                });
                let _ = std::io::copy(&mut upstream_read, &mut client_write);
            });
        }
    });

    Stub { port, seen }
}
