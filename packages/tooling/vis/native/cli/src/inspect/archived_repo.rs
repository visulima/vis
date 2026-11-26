//! The `archivedRepo` marshall: `src/security/marshalls/archived-repo.ts` for one package.
//!
//! Node resolves the version's `repository.url` to a GitHub `owner/repo`, reads the cached state
//! (`<cache>/archived-repo/<owner>__<repo>.json`, 24 hours) or asks `api.github.com/repos/<owner>/<repo>` once, and reports
//! a repository that is archived or that GitHub does not know (404). A repository URL of another host, a rate-limit or
//! server error and a body that is `null` are no finding. A 404, and a 200 whether archived or not, are cached.
//!
//! The request carries what Node's carries: `Accept: application/vnd.github+json`, `User-Agent: visulima-vis-marshall` and
//! `Authorization: Bearer <GITHUB_TOKEN>` when that variable is set and not empty.
//!
//! Handed to Node before anything is printed or written: a request that fails before an answer, a redirect (GitHub answers
//! a renamed repository with one), a body that is not JSON this module reads, a `GITHUB_TOKEN` that is not visible ASCII, an
//! owner or repository outside `[A-Za-z0-9._-]` (what `encodeURIComponent` and the URL parser would rewrite), and a cache
//! file that is not what Node writes.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use super::marshalls::{Finding, Severity, Target};
use super::packument::{Cached, View};
use super::{service_cache, CacheAction};
use crate::http::{HttpClient, HttpError};
use crate::js::{json_string, trim};
use crate::keys_refresh::Js;

/// `DEFAULT_TTL_MS`: 24 hours.
const TTL_MS: u64 = 24 * 60 * 60 * 1000;

/// `GITHUB_API_BASE`.
pub(super) const API: &str = "https://api.github.com/repos";

/// The text after `prefix` when `text` starts with it, ignoring the case of ASCII letters (the `i` flag of a regular
/// expression without `u` folds nothing else).
fn after_prefix<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;

    head.eq_ignore_ascii_case(prefix).then(|| &text[prefix.len()..])
}

/// Splits `rest` into the part before the first `/` (at least one character) and what follows it (at least one).
fn owner_and_rest(rest: &str) -> Option<(&str, &str)> {
    rest.split_once('/').filter(|(owner, after)| !owner.is_empty() && !after.is_empty())
}

/// The shortest non-empty `X` for which `after` is `X` and one of `.git/`, `.git`, `/` or nothing: what the lazy
/// `(.+?)(?:\.git)?\/?$` of the pattern captures.
fn lazy_repository(after: &str) -> &str {
    for suffix in [".git/", ".git", "/"] {
        if let Some(cut) = after.len().checked_sub(suffix.len()).filter(|cut| *cut > 0) {
            if after.get(cut..).is_some_and(|tail| tail.eq_ignore_ascii_case(suffix)) {
                return &after[..cut];
            }
        }
    }

    after
}

/// `parseGitHubUrl`: `Ok(None)` for a URL it does not read (another host, another shape), `Ok(Some((owner, repo)))` for
/// one it does, and the reason for a hand-off for an owner or repository that does not stay as it is in a URL.
fn parse_url(raw: &str) -> Result<Option<(String, String)>, String> {
    let trimmed = trim(raw);

    if trimmed.is_empty() {
        return Ok(None);
    }

    let candidate = trimmed.strip_prefix("git+").unwrap_or(trimmed);
    let found = if let Some(rest) =
        after_prefix(candidate, "git@github.com:").or_else(|| after_prefix(candidate, "ssh://git@github.com/"))
    {
        owner_and_rest(rest).map(|(owner, after)| (owner, lazy_repository(after)))
    } else if let Some(rest) = after_prefix(candidate, "https://").or_else(|| after_prefix(candidate, "http://")) {
        let rest =
            after_prefix(rest, "www.").filter(|after| after_prefix(after, "github.com/").is_some()).unwrap_or(rest);

        after_prefix(rest, "github.com/")
            .and_then(owner_and_rest)
            .map(|(owner, after)| (owner, lazy_repository(after)))
            .filter(|(_, repository)| !repository.contains(['/', '?', '#']))
    } else {
        None
    };
    let Some((owner, repository)) = found else { return Ok(None) };

    if is_plain(owner) && is_plain(repository) {
        Ok(Some((owner.to_owned(), repository.to_owned())))
    } else {
        Err(format!("the repository {owner}/{repository} is not a plain owner and name"))
    }
}

/// An owner or repository `encodeURIComponent` and the URL parser leave as it is.
fn is_plain(part: &str) -> bool {
    part != "."
        && part != ".."
        && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn cache_file(cache_dir: &str, owner: &str, repo: &str) -> PathBuf {
    Path::new(cache_dir).join("archived-repo").join(format!("{owner}__{repo}.json"))
}

/// What is known about a repository.
enum State {
    Missing,
    Known {
        archived: bool,
        archived_at: Option<String>,
    },
    /// A rate limit, a server error: no finding, nothing cached.
    Unknown,
}

fn cached_state(entry: &Js) -> Result<State, String> {
    if matches!(entry.member("missing"), Some(Js::Bool(true))) {
        return Ok(State::Missing);
    }

    let archived = matches!(entry.member("archived"), Some(Js::Bool(true)));
    let archived_at = match entry.member("archivedAt") {
        None => None,
        Some(Js::String(stamp)) => Some(stamp.clone()),
        Some(_) if !archived => None,
        Some(_) => return Err("a cached archivedAt is not text".to_owned()),
    };

    Ok(State::Known { archived, archived_at })
}

fn fetch(client: &HttpClient, url: &str, token: Option<&str>) -> Result<State, String> {
    let bearer = token.map(|token| format!("Bearer {token}"));
    let mut headers = vec![("accept", "application/vnd.github+json"), ("user-agent", "visulima-vis-marshall")];

    if let Some(bearer) = &bearer {
        headers.push(("authorization", bearer));
    }

    let response = match client.get(url, &headers) {
        Ok(response) => response,
        Err(HttpError::Status { code: 404, .. }) => return Ok(State::Missing),
        Err(HttpError::Status { .. }) => return Ok(State::Unknown),
        Err(error) => return Err(format!("the GitHub request failed: {error}")),
    };
    let text = response.text().map_err(|error| format!("the GitHub answer is not UTF-8 text: {error}"))?;

    if text.starts_with('\u{feff}') {
        return Err("the GitHub answer starts with a byte-order mark".to_owned());
    }

    match serde_json::from_str::<Js>(text).map_err(|_| "the GitHub answer is not JSON this module reads".to_owned())? {
        // `body.archived` of `null` throws, which Node reads as a failed request.
        Js::Null => Ok(State::Unknown),
        body => Ok(State::Known {
            archived: matches!(body.member("archived"), Some(Js::Bool(true))),
            archived_at: body.member("archived_at").and_then(Js::text).map(str::to_owned),
        }),
    }
}

/// The token Node reads from `GITHUB_TOKEN`: none when unset or empty, and the reason for a hand-off for one that
/// `fetch` could read differently.
fn bearer_token(value: Option<&OsStr>) -> Result<Option<&str>, String> {
    let Some(value) = value else { return Ok(None) };
    let text = value.to_str().ok_or("GITHUB_TOKEN is not text")?;

    if text.is_empty() {
        return Ok(None);
    }

    if text.bytes().all(|byte| byte.is_ascii_graphic()) {
        Ok(Some(text))
    } else {
        Err("GITHUB_TOKEN holds a character other than visible ASCII".to_owned())
    }
}

/// `entry = versions[version] ?? versions[resolveLatestVersion(...)]`.
fn version_entry<'a>(view: &View<'a>, version: &str) -> Result<Option<&'a Js>, String> {
    if let Some(entry) = view.entry(version) {
        return Ok(Some(entry));
    }

    let latest = view.tag("latest")?.filter(|tag| view.entry(tag).is_some()).or_else(|| view.last_version());

    Ok(latest.and_then(|name| view.entry(name)))
}

/// What `archived_at` of a cache entry adds to the file.
fn cache_entry(state: &State, now_ms: u64) -> Option<String> {
    let head = format!("{{\"createdAt\":{now_ms},\"ttlMs\":{TTL_MS}");

    match state {
        State::Missing => Some(format!("{head},\"archived\":false,\"missing\":true}}")),
        State::Known { archived, archived_at } => {
            let at = archived_at
                .as_deref()
                .map_or_else(String::new, |stamp| format!(",\"archivedAt\":{}", json_string(stamp)));

            Some(format!("{head},\"archived\":{archived}{at}}}"))
        }
        State::Unknown => None,
    }
}

/// The finding of `runArchivedRepoMarshall` for the target, if any, and the cache change that goes with it.
pub(super) fn run(
    client: &HttpClient,
    base: &str,
    token: Option<&OsStr>,
    cache_dir: &str,
    view: &View,
    target: &Target,
    now_ms: u64,
) -> Result<(Vec<Finding>, Vec<CacheAction>), String> {
    let Some(entry) = version_entry(view, target.version)? else { return Ok((Vec::new(), Vec::new())) };
    let url = match entry.member("repository") {
        Some(repository @ Js::Object(_)) => repository.member("url").and_then(Js::text),
        _ => None,
    };
    let Some((owner, repo)) = url.map(parse_url).transpose()?.flatten() else { return Ok((Vec::new(), Vec::new())) };
    let file = cache_file(cache_dir, &owner, &repo);
    let mut cache = Vec::new();
    let state = match service_cache::read(&file, now_ms as f64)? {
        Cached::Fresh(entry) => cached_state(&entry)?,
        Cached::Fetch { stale_file } => {
            if stale_file {
                cache.push(CacheAction::Remove(file.clone()));
            }

            let token = bearer_token(token)?;
            let state = fetch(client, &format!("{base}/{owner}/{repo}"), token)?;

            if let Some(text) = cache_entry(&state, now_ms) {
                cache.push(CacheAction::Write { file, text });
            }

            state
        }
    };
    let message = match state {
        State::Missing => format!("Source repo {owner}/{repo} returned 404 from GitHub."),
        State::Known { archived: true, archived_at } => {
            let since = archived_at.map_or_else(String::new, |stamp| format!(" (since {stamp})"));

            format!("Source repo {owner}/{repo} is archived{since}.")
        }
        State::Known { .. } | State::Unknown => return Ok((Vec::new(), cache)),
    };

    Ok((
        vec![Finding {
            marshall: "archivedRepo",
            message,
            package: target.name.to_owned(),
            severity: Severity::Warning,
        }],
        cache,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `parseGitHubUrl` of `src/security/marshalls/archived-repo.ts` on each line of the corpus, as Node answered it:
    /// `[input, null | {owner, repo}]`.
    const CORPUS: &str = include_str!("../../tests/fixtures/github-urls.json");

    #[test]
    fn urls_are_read_the_way_node_reads_them() {
        let rows: Vec<(String, Option<serde_json::Value>)> = serde_json::from_str(CORPUS).unwrap();

        assert!(rows.len() > 60);

        for (input, expected) in rows {
            let expected = expected
                .map(|found| (found["owner"].as_str().unwrap().to_owned(), found["repo"].as_str().unwrap().to_owned()));

            match parse_url(&input) {
                Ok(found) => assert_eq!(found, expected, "{input:?}"),
                // A hand-off is only for an owner or name that is not plain, where Node reads one.
                Err(_) => {
                    let (owner, repo) = expected.unwrap_or_else(|| panic!("{input:?} handed over; Node reads nothing"));

                    assert!(
                        !is_plain(&owner) || !is_plain(&repo),
                        "{input:?} handed over although {owner}/{repo} is plain"
                    );
                }
            }
        }
    }

    #[test]
    fn the_bearer_token_is_none_visible_ascii_or_a_hand_over() {
        assert_eq!(bearer_token(None), Ok(None));
        assert_eq!(bearer_token(Some(OsStr::new(""))), Ok(None));
        assert_eq!(bearer_token(Some(OsStr::new("ghp_abc123"))), Ok(Some("ghp_abc123")));

        for odd in [" ", "a b", " a", "a\n", "é"] {
            assert!(bearer_token(Some(OsStr::new(odd))).is_err(), "{odd:?}");
        }
    }

    #[test]
    fn a_cache_entry_is_what_node_writes() {
        assert_eq!(
            cache_entry(&State::Missing, 5).unwrap(),
            r#"{"createdAt":5,"ttlMs":86400000,"archived":false,"missing":true}"#
        );
        assert_eq!(
            cache_entry(&State::Known { archived: true, archived_at: Some("2024-01-02T03:04:05Z".to_owned()) }, 5)
                .unwrap(),
            r#"{"createdAt":5,"ttlMs":86400000,"archived":true,"archivedAt":"2024-01-02T03:04:05Z"}"#
        );
        assert_eq!(
            cache_entry(&State::Known { archived: false, archived_at: None }, 5).unwrap(),
            r#"{"createdAt":5,"ttlMs":86400000,"archived":false}"#
        );
        assert!(cache_entry(&State::Unknown, 5).is_none());
    }
}
