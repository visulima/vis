//! The three marshalls that ask a service other than the registry: `downloads` (the npm stats API), `archivedRepo`
//! (GitHub) and `expiredDomains` (DNS), each with the 24 hour disk cache Node keeps for it.
//!
//! Each answers with the cache changes of a run that found nothing, or `Err(reason)`: a finding (which `vis add` shows as a
//! table and may prompt about, so it is Node's), an answer these checks do not read as Node does, a cache file Node
//! would delete or fail on. The one outcome that is clean without being an answer is the GitHub lookup that fails
//! (rate limit, a 5xx, no connection): Node reports nothing for it, and neither does this.
//!
//! The addresses are fixed like Node's; the tests reach the code with the address of a stub server instead.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::dns;
use crate::http::{HttpClient, HttpError};
use crate::inspect::CacheAction;
use crate::js::{iso_now, json_number, json_string};

/// `DEFAULT_TTL_MS` of the three modules: a day.
const TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// `DEFAULT_WARN_THRESHOLD`: a package with fewer downloads in a month is a finding.
const WARN_THRESHOLD: f64 = 10_000.0;

pub(super) const DOWNLOADS_BASE: &str = "https://api.npmjs.org/downloads/point/last-month";
pub(super) const GITHUB_BASE: &str = "https://api.github.com/repos";

/// What a cache file holds.
enum Entry {
    Missing,
    Fresh(Value),
    /// Past its time to live: Node deletes it and asks the service.
    Expired,
}

pub(super) struct Services {
    pub(super) cache_dir: PathBuf,
    pub(super) now_ms: u64,
    pub(super) downloads_base: String,
    pub(super) github_base: String,
    pub(super) github_token: Option<String>,
    pub(super) servers: Vec<SocketAddr>,
    pub(super) client: HttpClient,
    repositories: HashSet<String>,
    domains: HashSet<String>,
    packages: HashSet<String>,
}

/// `encodeURIComponent` for a package name: letters, digits and `-._~` stay, `@` and `/` are the only others a name has.
fn encode(name: &str) -> String {
    name.replace('@', "%40").replace('/', "%2F")
}

impl Services {
    pub(super) fn new(
        cache_dir: PathBuf,
        now_ms: u64,
        client: HttpClient,
        downloads_base: &str,
        github_base: &str,
        github_token: Option<String>,
        servers: Vec<SocketAddr>,
    ) -> Self {
        Self {
            cache_dir,
            now_ms,
            downloads_base: downloads_base.to_owned(),
            github_base: github_base.to_owned(),
            github_token,
            servers,
            client,
            repositories: HashSet::new(),
            domains: HashSet::new(),
            packages: HashSet::new(),
        }
    }

    /// The entry of a cache file as `readCached*` reads it.
    fn read(&self, file: &Path) -> Result<Entry, String> {
        match fs::metadata(file) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Err("a cache path that is not a regular file".to_owned()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Entry::Missing),
            Err(error) => return Err(format!("a cache file cannot be read: {error}")),
        }

        let text = fs::read_to_string(file).map_err(|error| format!("a cache file cannot be read: {error}"))?;
        let entry: Value = serde_json::from_str(&text).map_err(|_| "a cache file that is not JSON".to_owned())?;
        let number = |name: &str| {
            entry.get(name).and_then(Value::as_f64).ok_or_else(|| format!("a cache file without a numeric {name}"))
        };

        Ok(if self.now_ms as f64 - number("createdAt")? > number("ttlMs")? {
            Entry::Expired
        } else {
            Entry::Fresh(entry)
        })
    }

    /// The change a cache file gets when its entry is past its time to live.
    fn expire(file: &Path, entry: &Entry) -> Vec<CacheAction> {
        if matches!(entry, Entry::Expired) {
            vec![CacheAction::Remove(file.to_owned())]
        } else {
            Vec::new()
        }
    }

    /// `runDownloadsMarshall` for one package.
    pub(super) fn downloads(&mut self, name: &str) -> Result<Vec<CacheAction>, String> {
        if !self.packages.insert(name.to_owned()) {
            return Ok(Vec::new());
        }

        let file = self.cache_dir.join("downloads").join(format!("{}.json", encode(name)));
        let entry = self.read(&file)?;
        let mut actions = Self::expire(&file, &entry);

        if let Entry::Fresh(cached) = &entry {
            let downloads =
                cached.get("downloads").and_then(Value::as_f64).ok_or("a cached download count that is no number")?;

            return if downloads < WARN_THRESHOLD {
                Err(format!("{name} has {downloads} downloads a month, a finding"))
            } else {
                Ok(actions)
            };
        }

        let url = format!("{}/{}", self.downloads_base, encode(name));
        let response =
            self.client.get(&url, &[]).map_err(|error| format!("the download count cannot be had: {error}"))?;
        let body: Value = serde_json::from_str(response.text().map_err(|error| error.to_string())?)
            .map_err(|_| "a download answer that is not JSON".to_owned())?;
        let downloads = body.get("downloads").and_then(Value::as_f64).ok_or("a download answer without a count")?;

        if downloads < WARN_THRESHOLD {
            return Err(format!("{name} has {downloads} downloads a month, a finding"));
        }

        actions.push(CacheAction::Write {
            file,
            text: format!(
                "{{\"createdAt\":{},\"downloads\":{},\"observedAt\":{},\"ttlMs\":{TTL_MS}}}",
                self.now_ms,
                json_number(downloads),
                json_string(&iso_now())
            ),
        });

        Ok(actions)
    }

    /// `runArchivedRepoMarshall` for one repository (a repository is asked for once).
    pub(super) fn repository(&mut self, owner: &str, repo: &str) -> Result<Vec<CacheAction>, String> {
        if !self.repositories.insert(format!("{owner}/{repo}")) {
            return Ok(Vec::new());
        }

        let file = self.cache_dir.join("archived-repo").join(format!("{owner}__{repo}.json"));
        let entry = self.read(&file)?;
        let mut actions = Self::expire(&file, &entry);

        if let Entry::Fresh(cached) = &entry {
            let missing = cached.get("missing") == Some(&Value::Bool(true));
            let archived = cached.get("archived") == Some(&Value::Bool(true));

            return if missing || archived {
                Err(format!("{owner}/{repo} is archived or missing, a finding"))
            } else {
                Ok(actions)
            };
        }

        let url = format!("{}/{owner}/{repo}", self.github_base);
        let mut headers = vec![("accept", "application/vnd.github+json"), ("user-agent", "visulima-vis-marshall")];
        let authorization = self.github_token.as_ref().map(|token| format!("Bearer {token}"));

        if let Some(authorization) = &authorization {
            headers.push(("authorization", authorization));
        }

        let response = match self.client.get(&url, &headers) {
            Ok(response) => response,
            Err(HttpError::Status { code: 404, .. }) => return Err(format!("{owner}/{repo} is missing, a finding")),
            Err(error @ (HttpError::Redirect(_) | HttpError::TooLarge { .. })) => return Err(error.to_string()),
            // A rate limit, a server error or no connection: Node reports nothing and writes nothing.
            Err(_) => return Ok(actions),
        };
        let parsed = response.text().ok().and_then(|text| serde_json::from_str::<Value>(text).ok());

        // An answer that is not an object throws in Node, which is the same as a failed request.
        let Some(Value::Object(body)) = parsed else { return Ok(actions) };

        if body.get("archived") == Some(&Value::Bool(true)) {
            return Err(format!("{owner}/{repo} is archived, a finding"));
        }

        let archived_at =
            body.get("archived_at").and_then(Value::as_str).map(|at| format!(",\"archivedAt\":{}", json_string(at)));

        actions.push(CacheAction::Write {
            file,
            text: format!(
                "{{\"createdAt\":{},\"ttlMs\":{TTL_MS},\"archived\":false{}}}",
                self.now_ms,
                archived_at.unwrap_or_default()
            ),
        });

        Ok(actions)
    }

    /// `runExpiredDomainsMarshall` for one maintainer domain (a domain is looked up once).
    pub(super) fn domain(&mut self, domain: &str) -> Result<Vec<CacheAction>, String> {
        if !self.domains.insert(domain.to_owned()) {
            return Ok(Vec::new());
        }

        let digest = Sha256::digest(domain.as_bytes());
        let name: String = digest.iter().take(6).map(|byte| format!("{byte:02x}")).collect();
        let file = self.cache_dir.join("expired-domains").join(format!("{name}.json"));
        let entry = self.read(&file)?;
        let mut actions = Self::expire(&file, &entry);

        if let Entry::Fresh(cached) = &entry {
            return if cached.get("outcome").and_then(Value::as_str) == Some("ok") {
                Ok(actions)
            } else {
                Err(format!("the domain {domain} is recorded as expired, a finding"))
            };
        }

        if !dns::has_ns_records(domain, &self.servers, dns::BUDGET) {
            return Err(format!("the domain {domain} has no name servers, or none answered"));
        }

        actions.push(CacheAction::Write {
            file,
            text: format!("{{\"createdAt\":{},\"outcome\":\"ok\",\"ttlMs\":{TTL_MS}}}", self.now_ms),
        });

        Ok(actions)
    }
}
