//! The marshall check of `vis add` (`runMarshallPipeline` after `resolveExplicitPackages`, in
//! `src/commands/add/handler.ts`): before it installs, Node looks every package up in the registry and runs the
//! marshalls, and shows a table (and may prompt) for any finding.
//!
//! This module answers only the run with no finding, which shows nothing: `Ok` with the cache changes the checks made, to be
//! written once the run is sure to answer. A finding, and everything the checks do not read as Node does, is `Err`, and the
//! run is Node's. It runs the marshalls of the pipeline for a project with no config (every one on but `signatures`, which is
//! opt-in): `author`, `provenance`, `s1ngularity`, `newBin` and `metadata` (as `vis inspect` runs them), `deprecation` and
//! `packageAge` over the packument, `downloads` over the npm stats API, `archivedRepo` over GitHub and `expiredDomains`
//! over DNS. The services keep Node's disk caches (see [`services`]).
//!
//! `MARSHALL_DISABLE_<NAME>` turns a marshall off in the environment, as in Node; `MARSHALL_DISABLE_ALL` and any other
//! `MARSHALL_*` variable also switch off the typosquat scan and the security notice, which the caller leaves to Node.

mod dns;
pub(crate) mod resolve;
mod services;

use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::Path;
use std::sync::OnceLock;

use regex::bytes::Regex;

use crate::cache::dirs::vis_cache_dir;
use crate::http::node_fetch::fetch_config;
use crate::http::{HttpClient, HttpConfig};
use crate::inspect::{entry_or_latest, first_finding, CacheAction, Checks, Packuments, View};
use crate::keys_refresh::{Js, FETCH_TIMEOUT};
use services::Services;

/// The marshalls this module runs, by the camel-case name Node's `MARSHALL_DISABLE_*` variables derive from.
const NAMES: [&str; 10] = [
    "archivedRepo",
    "author",
    "deprecation",
    "downloads",
    "expiredDomains",
    "metadata",
    "newBin",
    "packageAge",
    "provenance",
    "s1ngularity",
];

/// The variables that switch one of those off, which the add gate lets through.
pub(crate) fn disable_variables() -> Vec<String> {
    NAMES.iter().map(|name| disable_variable(name)).collect()
}

/// `envVarFor`: `MARSHALL_DISABLE_` and the name with an underscore before each capital, upper-cased.
fn disable_variable(name: &str) -> String {
    let mut variable = String::from("MARSHALL_DISABLE_");

    for character in name.chars() {
        if character.is_ascii_uppercase() {
            variable.push('_');
        }

        variable.push(character.to_ascii_uppercase());
    }

    variable
}

/// Which marshalls the environment leaves on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Enabled {
    packument: Checks,
    downloads: bool,
    archived_repo: bool,
    expired_domains: bool,
}

/// `isMarshallDisabled` for each marshall, through `lookup`. `Err` for a variable that is not plain ASCII text (JavaScript's
/// `trim` and Rust's differ beyond it) and for `MARSHALL_DISABLE_ALL`.
fn enabled(lookup: &dyn Fn(&str) -> Option<OsString>) -> Result<Enabled, String> {
    let on = |name: &str| -> Result<bool, String> {
        match lookup(&disable_variable(name)) {
            None => Ok(true),
            Some(value) => {
                let text = value
                    .to_str()
                    .filter(|text| text.is_ascii())
                    .ok_or("a MARSHALL_DISABLE_* value that is not ASCII")?;

                Ok(!crate::dlx::is_truthy(text))
            }
        }
    };

    if lookup("MARSHALL_DISABLE_ALL").is_some() {
        return Err("MARSHALL_DISABLE_ALL is set".to_owned());
    }

    Ok(Enabled {
        packument: Checks {
            author: on("author")?,
            provenance: on("provenance")?,
            s1ngularity: on("s1ngularity")?,
            new_bin: on("newBin")?,
            metadata: on("metadata")?,
            deprecation: on("deprecation")?,
            package_age: on("packageAge")?,
        },
        downloads: on("downloads")?,
        archived_repo: on("archivedRepo")?,
        expired_domains: on("expiredDomains")?,
    })
}

/// `parseGitHubUrl`: the owner and repository of a `repository.url`, for the URL shapes it reads. `Ok(None)` for a URL
/// that is not GitHub's; `Err` for one outside printable ASCII (JavaScript's `.` and `trim` differ beyond it) and for an
/// owner or repository that `encodeURIComponent` would change.
fn parse_github_url(raw: &str) -> Result<Option<(String, String)>, String> {
    static PATTERNS: OnceLock<[Regex; 3]> = OnceLock::new();

    // Printable ASCII only, so the byte classes below read a repository URL as JavaScript's expressions do.

    if !raw.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
        return Err("a repository URL that is not printable ASCII".to_owned());
    }

    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(?i-u)^git@github\.com:([^/]+)/(.+?)(?:\.git)?/?$",
            r"(?i-u)^ssh://git@github\.com/([^/]+)/(.+?)(?:\.git)?/?$",
            r"(?i-u)^https?://(?:www\.)?github\.com/([^/]+)/([^/?#]+?)(?:\.git)?/?$",
        ]
        .map(|pattern| Regex::new(pattern).expect("the GitHub expression compiles"))
    });
    let trimmed = raw.trim_matches(|character: char| character == ' ');
    let candidate = trimmed.strip_prefix("git+").unwrap_or(trimmed);

    if raw.trim().is_empty() {
        return Ok(None);
    }

    for pattern in patterns {
        if let Some(found) = pattern.captures(candidate.as_bytes()) {
            let text = |index: usize| String::from_utf8(found[index].to_vec()).expect("the URL is ASCII");
            let (owner, repo) = (text(1), text(2));
            let plain = |part: &str| {
                part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            };

            return if plain(&owner) && plain(&repo) {
                Ok(Some((owner, repo)))
            } else {
                Err("a repository name that needs encoding".to_owned())
            };
        }
    }

    Ok(None)
}

/// `extractDomain`: the text after the last `@` of an email, trimmed and lower-cased; `Err` outside ASCII.
fn email_domain(email: &Js) -> Result<Option<String>, String> {
    let Js::String(email) = email else { return Ok(None) };

    if !email.is_ascii() {
        return Err("a maintainer email that is not ASCII".to_owned());
    }

    Ok(email
        .rfind('@')
        .filter(|at| *at + 1 < email.len())
        .map(|at| email[at + 1..].trim().to_ascii_lowercase())
        .filter(|domain| !domain.is_empty()))
}

/// The domains of `entry._npmUser` and `entry.maintainers`, in Node's order.
fn maintainer_domains(entry: &Js) -> Result<Vec<String>, String> {
    let mut domains = Vec::new();
    let mut take = |maintainer: &Js| -> Result<(), String> {
        match maintainer {
            // `maintainer.email` of null throws, which Node swallows for the whole marshall.
            Js::Null => Err("a maintainer that is null".to_owned()),
            Js::Object(_) => {
                domains.extend(maintainer.member("email").map(email_domain).transpose()?.flatten());

                Ok(())
            }
            _ => Ok(()),
        }
    };

    if let Some(user) = entry.member("_npmUser") {
        take(user)?;
    }

    match entry.member("maintainers") {
        None | Some(Js::Null) => {}
        Some(Js::Array(list)) => list.iter().try_for_each(&mut take)?,
        Some(_) => return Err("`maintainers` is not a list".to_owned()),
    }

    Ok(domains)
}

/// What a package's packument says that the services need.
#[derive(Default)]
struct Needs {
    repositories: Vec<(String, String)>,
    domains: Vec<String>,
}

/// The repository and maintainer domains of the version's entry.
fn needs_of(view: &View, version: &str, enabled: Enabled) -> Result<Needs, String> {
    let mut needs = Needs::default();

    if !enabled.archived_repo && !enabled.expired_domains {
        return Ok(needs);
    }

    let Some(entry) = entry_or_latest(view, version)? else { return Ok(needs) };

    if enabled.archived_repo {
        if let Some(Js::String(url)) = entry.member("repository").and_then(|repository| repository.member("url")) {
            needs.repositories.extend(parse_github_url(url)?);
        }
    }

    if enabled.expired_domains {
        needs.domains = maintainer_domains(entry)?;
    }

    Ok(needs)
}

/// The checks over the resolved packages, with the services given: the cache changes of a run with no finding, or the
/// reason it has one or cannot be told.
fn run_checks(
    packuments: &Packuments,
    services: &mut Services,
    resolved: &[(String, String)],
    enabled: Enabled,
    now_ms: u64,
) -> Result<Vec<CacheAction>, String> {
    let mut actions = Vec::new();
    let mut names: Vec<&str> = Vec::new();
    let mut versions: HashMap<&str, Vec<&str>> = HashMap::new();

    for (name, version) in resolved {
        let known = versions.entry(name).or_default();

        if known.is_empty() {
            names.push(name);
        }

        if !known.contains(&version.as_str()) {
            known.push(version);
        }
    }

    for name in names {
        // The pipeline reads every packument before the marshalls run, whichever of them the environment turned off
        // (only the project's config, which this run has none of, decides that), and caches it.
        let (needs, cache) = packuments.read(name, |view| {
            let mut collected = Needs::default();

            for version in &versions[name] {
                if let Some(check) = first_finding(view, name, version, now_ms, enabled.packument)? {
                    return Err(format!("{name}@{version} has a finding of the {check} check"));
                }

                if let Some(view) = view {
                    let more = needs_of(view, version, enabled)?;

                    collected.repositories.extend(more.repositories);
                    collected.domains.extend(more.domains);
                }
            }

            Ok(collected)
        })?;

        actions.extend(cache);

        if enabled.downloads {
            actions.extend(services.downloads(name)?);
        }

        for (owner, repo) in &needs.repositories {
            actions.extend(services.repository(owner, repo)?);
        }

        for domain in &needs.domains {
            actions.extend(services.domain(domain)?);
        }
    }

    Ok(actions)
}

/// The marshall check for the packages of an `add`, run from `cwd`: the cache changes of a run that finds nothing, or the
/// reason it is Node's.
///
/// `outside_root` is a run outside a workspace root: Node then has no `.npmrc` to read, and asks `registry.npmjs.org`.
pub(crate) fn check(packages: &[String], cwd: &Path, outside_root: bool) -> Result<Vec<CacheAction>, String> {
    // The requests below go where `fetch` would only if no proxy, CA file or Node option is set.
    if !crate::http::node_fetch::network_environment_is_plain() {
        return Err("a proxy, CA or Node option is set in the environment".to_owned());
    }

    let enabled = enabled(&|name| env::var_os(name))?;
    let resolved = resolve::resolve_explicit(packages, &|names| resolve::latest_versions(resolve::LATEST_BASE, names))?;

    // Node runs no pipeline for packages that resolve to none.
    if resolved.is_empty() {
        return Ok(Vec::new());
    }

    let packuments = if outside_root {
        Packuments::new_default_registry(cwd.to_path_buf(), FETCH_TIMEOUT)?
    } else {
        Packuments::new(cwd.to_path_buf(), FETCH_TIMEOUT)?
    };
    let cache_dir = vis_cache_dir().ok_or("no cache directory (HOME is not a plain absolute path)")?;
    let now_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "the clock is before 1970".to_owned())?
            .as_millis(),
    )
    .map_err(|_| "the clock is out of range".to_owned())?;
    let servers: Vec<SocketAddr> =
        dns::SERVERS.iter().filter_map(|server| server.to_socket_addrs().ok()?.next()).collect();
    // `GITHUB_TOKEN`, sent as a bearer token; an empty one is no token, and one that is not plain text is Node's.
    let github_token = match env::var("GITHUB_TOKEN") {
        Ok(token) if token.bytes().all(|byte| byte.is_ascii_graphic()) => Some(token).filter(|token| !token.is_empty()),
        Ok(_) | Err(env::VarError::NotUnicode(_)) => return Err("GITHUB_TOKEN is not a plain token".to_owned()),
        Err(env::VarError::NotPresent) => None,
    };
    let client = HttpClient::new(fetch_config(HttpConfig::from_env(FETCH_TIMEOUT, FETCH_TIMEOUT), FETCH_TIMEOUT));
    let mut services = Services::new(
        cache_dir.into(),
        now_ms,
        client,
        services::DOWNLOADS_BASE,
        services::GITHUB_BASE,
        github_token,
        servers,
    );

    run_checks(&packuments, &mut services, &resolved, enabled, now_ms)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::net::UdpSocket;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::inspect::commit;
    use crate::inspect::tests::{ok, packuments_for, Registry, NOW};

    fn pair(name: &str, version: &str) -> (String, String) {
        (name.to_owned(), version.to_owned())
    }

    fn nothing(_: &str) -> Option<OsString> {
        None
    }

    /// A DNS server on loopback that answers every query with the given status, and an NS record for status 0.
    fn dns(rcode: u8) -> SocketAddr {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let address = socket.local_addr().unwrap();

        std::thread::spawn(move || {
            let mut buffer = [0_u8; 512];

            while let Ok((length, from)) = socket.recv_from(&mut buffer) {
                let mut reply = buffer[..length].to_vec();

                reply[2] = 0x81;
                reply[3] = 0x80 | rcode;

                if rcode == 0 {
                    reply[6..8].copy_from_slice(&[0, 1]);
                    reply.extend_from_slice(&[0xC0, 12, 0, 2, 0, 1, 0, 0, 0, 60, 0, 5, 3, b'n', b's', b'1', 0]);
                }

                drop(socket.send_to(&reply, from));
            }
        });

        address
    }

    struct World {
        registry: Registry,
        packuments: Packuments,
        home: PathBuf,
        dns: SocketAddr,
    }

    impl World {
        /// A registry that knows `pkg` (and the download count and repository the services ask about).
        fn new(extra: &[(&str, (u16, String))]) -> Self {
            let mut answers: crate::inspect::tests::Answers = HashMap::from([
                ("/pkg".to_owned(), ok(&crate::inspect::tests::calm())),
                ("/dl/pkg".to_owned(), ok(&json!({ "downloads": 50_000 }))),
                ("/gh/o/r".to_owned(), ok(&json!({ "archived": false, "archived_at": null }))),
            ]);

            for (path, (status, body)) in extra {
                answers.insert((*path).to_owned(), (*status, body.clone(), Vec::new()));
            }

            let registry = Registry::start(answers);
            let (packuments, home) = packuments_for(&registry);

            Self { registry, packuments, home, dns: dns(0) }
        }

        fn services(&self, token: Option<&str>, dns: SocketAddr) -> Services {
            Services::new(
                self.home.join(".vis").join("cache"),
                NOW,
                HttpClient::new(fetch_config(HttpConfig::default(), FETCH_TIMEOUT)),
                &format!("{}/dl", self.registry.url()),
                &format!("{}/gh", self.registry.url()),
                token.map(str::to_owned),
                vec![dns],
            )
        }

        fn run(&self, enabled: Enabled, dns: SocketAddr) -> Result<Vec<CacheAction>, String> {
            run_checks(&self.packuments, &mut self.services(None, dns), &[pair("pkg", "1.2.0")], enabled, NOW)
        }

        fn requests(&self) -> usize {
            self.registry.requests.load(Ordering::SeqCst)
        }
    }

    /// The cache file name of the domain every fixture maintainer has.
    fn example_digest() -> String {
        Sha256::digest(b"example.test").iter().take(6).map(|byte| format!("{byte:02x}")).collect()
    }

    fn all_on() -> Enabled {
        enabled(&nothing).unwrap()
    }

    fn files_of(actions: &[CacheAction]) -> Vec<String> {
        actions
            .iter()
            .map(|action| match action {
                CacheAction::Write { file, .. } => format!("write {}", file.file_name().unwrap().to_string_lossy()),
                CacheAction::Remove(file) => format!("remove {}", file.file_name().unwrap().to_string_lossy()),
            })
            .collect()
    }

    #[test]
    fn the_marshalls_of_a_clean_package_find_nothing_and_cache_what_node_caches() {
        let world = World::new(&[]);
        let actions = world.run(all_on(), world.dns).unwrap();
        assert_eq!(
            files_of(&actions),
            [
                "write pkg.json",
                "write pkg.json",
                "write o__r.json",
                format!("write {}.json", example_digest()).as_str()
            ]
        );

        let texts: Vec<&str> = actions
            .iter()
            .map(|action| match action {
                CacheAction::Write { text, .. } => text.as_str(),
                CacheAction::Remove(_) => "",
            })
            .collect();

        assert!(texts[0].starts_with("{\"cacheVersion\":3,\"createdAt\":1718452800000,\"packument\":"));
        assert!(texts[1].starts_with("{\"createdAt\":1718452800000,\"downloads\":50000,\"observedAt\":\""));
        assert!(texts[1].ends_with("\",\"ttlMs\":86400000}"));
        assert_eq!(texts[2], "{\"createdAt\":1718452800000,\"ttlMs\":86400000,\"archived\":false}");
        assert_eq!(texts[3], "{\"createdAt\":1718452800000,\"outcome\":\"ok\",\"ttlMs\":86400000}");

        // With the caches written, the next run asks nobody.
        commit(&actions).unwrap();

        let asked = world.requests();

        assert_eq!(world.run(all_on(), dns(3)).unwrap(), Vec::new());
        assert_eq!(world.requests(), asked);
    }

    #[test]
    fn a_service_that_reports_something_ends_the_check() {
        let low = World::new(&[("/dl/pkg", (200, json!({ "downloads": 9_999 }).to_string()))]);

        assert!(low.run(all_on(), low.dns).unwrap_err().contains("downloads"));

        let missing = World::new(&[("/dl/pkg", (404, "{}".to_owned()))]);

        assert!(missing.run(all_on(), missing.dns).is_err());

        let archived = World::new(&[("/gh/o/r", (200, json!({ "archived": true }).to_string()))]);

        assert!(archived.run(all_on(), archived.dns).unwrap_err().contains("archived"));

        let gone = World::new(&[("/gh/o/r", (404, "{}".to_owned()))]);

        assert!(gone.run(all_on(), gone.dns).unwrap_err().contains("missing"));

        // A domain with no name servers, or one that does not answer a lookup that is no expiry.
        let world = World::new(&[]);

        assert!(world.run(all_on(), dns(3)).unwrap_err().contains("name servers"));
        assert!(world.run(all_on(), dns(2)).is_err());
    }

    #[test]
    fn a_failed_github_lookup_is_no_finding_and_writes_nothing() {
        for status in [403, 429, 500] {
            let world = World::new(&[("/gh/o/r", (status, "{}".to_owned()))]);
            let actions = world.run(all_on(), world.dns).unwrap();

            // The packument, the download count and the maintainer domain are cached; the repository is not.
            assert_eq!(
                files_of(&actions),
                ["write pkg.json", "write pkg.json", &format!("write {}.json", example_digest())],
                "{status}"
            );
        }

        // An answer that is no object throws in Node's `.archived` read, which is the same.
        let world = World::new(&[("/gh/o/r", (200, "null".to_owned()))]);

        assert_eq!(world.run(all_on(), world.dns).unwrap().len(), 3);
    }

    #[test]
    fn the_marshalls_the_environment_turns_off_are_not_asked() {
        let world = World::new(&[("/dl/pkg", (500, "{}".to_owned())), ("/gh/o/r", (404, "{}".to_owned()))]);
        let off = enabled(&|name| match name {
            "MARSHALL_DISABLE_DOWNLOADS" | "MARSHALL_DISABLE_ARCHIVED_REPO" => Some("1".into()),
            "MARSHALL_DISABLE_EXPIRED_DOMAINS" => Some(" TRUE ".into()),
            "MARSHALL_DISABLE_NEW_BIN" => Some("no".into()),
            _ => None,
        })
        .unwrap();

        assert!(!off.downloads && !off.archived_repo && !off.expired_domains && off.packument.new_bin);

        let actions = world.run(off, dns(3)).unwrap();

        assert_eq!(files_of(&actions), ["write pkg.json"]);
        assert_eq!(world.requests(), 1);
    }

    #[test]
    fn a_cache_entry_past_its_time_is_removed_and_asked_again_and_an_odd_one_is_node_s() {
        let world = World::new(&[]);
        let cache = world.home.join(".vis").join("cache");

        fs::create_dir_all(cache.join("downloads")).unwrap();
        fs::write(
            cache.join("downloads").join("pkg.json"),
            r#"{"createdAt":1,"downloads":5,"observedAt":"x","ttlMs":2}"#,
        )
        .unwrap();

        let actions = world.run(Enabled { downloads: true, ..all_off() }, world.dns).unwrap();

        // The packument first, then the download count: the old entry is removed and a new one written.
        assert_eq!(files_of(&actions), ["write pkg.json", "remove pkg.json", "write pkg.json"]);

        fs::write(cache.join("downloads").join("pkg.json"), "not json").unwrap();
        assert!(world.run(Enabled { downloads: true, ..all_off() }, world.dns).is_err());

        fs::write(
            cache.join("downloads").join("pkg.json"),
            r#"{"createdAt":1,"downloads":"many","ttlMs":99999999999999}"#,
        )
        .unwrap();
        assert!(world.run(Enabled { downloads: true, ..all_off() }, world.dns).is_err());

        // A fresh entry with a low count is a finding without a request.
        fs::write(
            cache.join("downloads").join("pkg.json"),
            format!(r#"{{"createdAt":{NOW},"downloads":3,"ttlMs":1000}}"#),
        )
        .unwrap();
        assert!(world.run(Enabled { downloads: true, ..all_off() }, world.dns).is_err());
    }

    fn all_off() -> Enabled {
        Enabled { packument: Checks::default(), downloads: false, archived_repo: false, expired_domains: false }
    }

    #[test]
    fn the_github_request_carries_the_headers_node_sends() {
        let world = World::new(&[]);

        world.services(Some("t0k3n"), world.dns).repository("o", "r").unwrap();

        let request = world.registry.paths.lock().unwrap()[0].to_lowercase();

        assert!(request.starts_with("get /gh/o/r "));
        assert!(request.contains("accept: application/vnd.github+json"));
        assert!(request.contains("user-agent: visulima-vis-marshall"));
        assert!(request.contains("authorization: bearer t0k3n"));
        assert_eq!(request.matches("user-agent").count(), 1);
    }

    #[test]
    fn repository_urls_and_maintainer_emails_are_read_as_node_reads_them() {
        let github = |url: &str| parse_github_url(url);
        let repo = |owner: &str, name: &str| Ok(Some((owner.to_owned(), name.to_owned())));

        assert_eq!(github("git+https://github.com/o/r.git"), repo("o", "r"));
        assert_eq!(github("https://www.github.com/o/r/"), repo("o", "r"));
        assert_eq!(github("HTTP://GitHub.com/O/R"), repo("O", "R"));
        assert_eq!(github("git@github.com:o/r.git"), repo("o", "r"));
        assert_eq!(github("ssh://git@github.com/o/r.git/"), repo("o", "r"));
        assert_eq!(github("  git+ssh://git@github.com/o/r  "), repo("o", "r"));
        assert_eq!(github("https://gitlab.com/o/r"), Ok(None));
        assert_eq!(github("https://github.com/o"), Ok(None));
        assert_eq!(github("https://github.com/o/r/tree/main"), Ok(None));
        assert_eq!(github(""), Ok(None));
        assert_eq!(github("   "), Ok(None));
        assert_eq!(github("https://github.com/o/r?x=1"), Ok(None));
        assert!(github("https://github.com/o/caf\u{e9}").is_err());
        assert!(github("https://github.com/o/r%20x").is_err());

        let entry: Js = serde_json::from_str(
            r#"{"_npmUser":{"name":"a","email":"A@Example.TEST "},"maintainers":[{"email":"b@x.test"},{"name":"c"},"d",{"email":"nodomain"},{"email":"e@"},{"email":5}]}"#,
        )
        .unwrap();

        assert_eq!(maintainer_domains(&entry).unwrap(), ["example.test", "x.test"]);

        for odd in [
            r#"{"_npmUser":null}"#,
            r#"{"maintainers":{"a":1}}"#,
            r#"{"maintainers":[null]}"#,
            r#"{"_npmUser":{"email":"café@example.test"}}"#,
        ] {
            assert!(maintainer_domains(&serde_json::from_str(odd).unwrap()).is_err(), "{odd}");
        }
    }

    #[test]
    fn the_disable_variables_are_node_s() {
        assert_eq!(disable_variable("newBin"), "MARSHALL_DISABLE_NEW_BIN");
        assert_eq!(disable_variable("s1ngularity"), "MARSHALL_DISABLE_S1NGULARITY");
        assert!(disable_variables().contains(&"MARSHALL_DISABLE_EXPIRED_DOMAINS".to_owned()));
        assert!(enabled(&|name| (name == "MARSHALL_DISABLE_ALL").then(|| "1".into())).is_err());
        assert!(enabled(&|name| (name == "MARSHALL_DISABLE_AUTHOR").then(|| "\u{a0}1".into())).is_err());
        assert!(!enabled(&|name| (name == "MARSHALL_DISABLE_AUTHOR").then(|| "1".into())).unwrap().packument.author);
        assert!(enabled(&|name| (name == "MARSHALL_DISABLE_AUTHOR").then(|| "false".into())).unwrap().packument.author);
    }

    #[test]
    fn a_package_the_registry_does_not_know_has_nothing_to_report_and_a_broken_registry_is_node_s() {
        let world = World::new(&[]);
        let found: Result<Vec<CacheAction>, String> = run_checks(
            &world.packuments,
            &mut world.services(None, world.dns),
            &[pair("ghost", "1.0.0")],
            all_on(),
            NOW,
        );

        // A 404 leaves no packument cache entry, and the services are asked about the name only.
        assert!(found.is_err_and(|reason| reason.contains("downloads") || reason.contains("download")));

        let broken = World::new(&[("/pkg", (500, "x".to_owned()))]);

        assert!(broken.run(all_on(), broken.dns).is_err());
    }
}
