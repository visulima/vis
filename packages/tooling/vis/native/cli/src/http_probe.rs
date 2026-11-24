//! Spike only: `vis __http-probe <url> [post-body]` — a hidden developer subcommand that forces the
//! HTTP client to link so its binary-size and startup cost can be measured. It is not in the manifest,
//! not in help and not routed anywhere else. Do not ship.

use std::time::{Duration, Instant};

use ureq::tls::{parse_pem, PemItem, RootCerts, TlsConfig};

pub fn run(args: &[String]) -> i32 {
    let Some(url) = args.get(1) else {
        eprintln!("usage: vis __http-probe <url> [post-body]");
        return 2;
    };

    let mut tls = TlsConfig::builder();
    // `NODE_EXTRA_CA_CERTS`-style: a PEM bundle of extra roots. NOTE: ureq's `Specific` roots REPLACE the
    // bundled roots rather than extend them; see the PR notes.
    if let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS") {
        match std::fs::read(&path) {
            Ok(pem) => {
                let certs: Vec<_> = parse_pem(&pem)
                    .filter_map(Result::ok)
                    .filter_map(|item| match item {
                        PemItem::Certificate(cert) => Some(cert.to_owned()),
                        _ => None,
                    })
                    .collect();
                tls = tls.root_certs(RootCerts::new_with_certs(&certs));
            }
            Err(error) => {
                eprintln!("NODE_EXTRA_CA_CERTS: {error}");
                return 1;
            }
        }
    }

    // Proxy settings come from the default config (ALL_PROXY / HTTPS_PROXY / HTTP_PROXY + NO_PROXY).
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .timeout_connect(Some(Duration::from_secs(10)))
        .max_redirects(5)
        .tls_config(tls.build())
        .build()
        .into();

    let started = Instant::now();
    let result = match args.get(2) {
        Some(body) => agent
            .post(url)
            .header("content-type", "application/json")
            .send(body.as_bytes()),
        None => agent.get(url).header("accept", "application/vnd.npm.install-v1+json").call(),
    };

    let mut response = match result {
        Ok(response) => response,
        Err(error) => {
            eprintln!("request failed: {error}");
            return 1;
        }
    };
    let status = response.status().as_u16();
    let encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("-")
        .to_owned();
    let body = match response.body_mut().with_config().limit(64 * 1024 * 1024).read_to_string() {
        Ok(body) => body,
        Err(error) => {
            eprintln!("body failed: {error}");
            return 1;
        }
    };
    let elapsed = started.elapsed();
    let json = serde_json::from_str::<serde_json::Value>(&body).is_ok();
    println!(
        "status={status} bytes={} content-encoding={encoding} json={json} wall_ms={}",
        body.len(),
        elapsed.as_millis()
    );
    0
}
