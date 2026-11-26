//! The marshalls that read the packument and nothing else: `author`, `provenance`, `s1ngularity`, `newBin` and
//! `metadata`, as `vis inspect` runs them on one package, and the findings in the shape its handler maps them to.
//!
//! Each returns `Err(reason)` where Node would throw, or where a field has a type this module does not read the way
//! JavaScript does (a number in place of an email, `null` where a lookup follows): the run then goes to Node.

use std::cmp::Reverse;

use super::js_format::{parse_date, to_fixed};
use super::packument::View;
use super::semver_js::Version;
use crate::keys_refresh::Js;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}

/// A `MarshallFinding` without a suggested action, which is all `vis inspect` produces.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Finding {
    pub marshall: &'static str,
    pub message: String,
    pub package: String,
    pub severity: Severity,
}

/// The package and version the run inspects.
pub(crate) struct Target<'a> {
    pub(crate) name: &'a str,
    pub(crate) version: &'a str,
}

impl Target<'_> {
    fn finding(&self, marshall: &'static str, severity: Severity, message: String) -> Finding {
        Finding { marshall, message, package: self.name.to_owned(), severity }
    }
}

const MS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// The inspected version as a parsed one, for the marshalls that compare it with the others.
fn parsed(target: &Target) -> Result<Version, String> {
    Version::parse(target.version).ok_or_else(|| format!("the version {} is not strict semver", target.version))
}

/// `userIdentity(entry._npmUser)`: the email, else the name.
fn identity(entry: &Js) -> Result<Option<String>, String> {
    let user = match entry.member("_npmUser") {
        None => return Ok(None),
        Some(Js::Null) => return Err("a `_npmUser` that is null".to_owned()),
        Some(user @ Js::Object(_)) => user,
        // A string, number or array has no `email` or `name`.
        Some(_) => return Ok(None),
    };

    // `user.email ?? user.name`: the email unless it is missing or null, else whatever the name is.
    match (user.member("email"), user.member("name")) {
        (Some(Js::String(email)), _) => Ok(Some(email.clone())),
        (None | Some(Js::Null), None) => Ok(None),
        (None | Some(Js::Null), Some(Js::String(name))) => Ok(Some(name.clone())),
        _ => Err("an email or name that is not text".to_owned()),
    }
}

/// `new Date(view.time[version]).getTime()`: `Ok(None)` when there is no time, and the reason for a hand-off for a
/// time in a form this does not read.
fn published(view: &View, version: &str) -> Result<Option<f64>, String> {
    match view.time(version)? {
        None => Ok(None),
        Some(stamp) => parse_date(stamp)
            .map(Some)
            .ok_or_else(|| format!("the time {stamp:?} of {version} is not in the registry's form")),
    }
}

fn days(number: f64, digits: u32) -> Result<String, String> {
    to_fixed(number, digits).ok_or_else(|| "a number of days that toFixed does not write plainly".to_owned())
}

const RECENT_ERROR_DAYS: f64 = 7.0;
const RECENT_WARN_DAYS: f64 = 30.0;
const NEW_PUBLISHER_WINDOW_DAYS: f64 = 21.0;
const DORMANT_ERROR_DAYS: f64 = 274.0;
const DORMANT_WARN_DAYS: f64 = 183.0;

fn recent_version(view: &View, target: &Target, now_ms: f64) -> Result<Option<Finding>, String> {
    let Some(published_ms) = published(view, target.version)? else { return Ok(None) };
    let age = (now_ms - published_ms) / MS_PER_DAY;

    for (limit, severity, word) in
        [(RECENT_ERROR_DAYS, Severity::Error, "error"), (RECENT_WARN_DAYS, Severity::Warning, "warn")]
    {
        if age < limit {
            let message = format!("published {} days ago ({word} threshold: {limit})", days(age, 1)?);

            return Ok(Some(target.finding("author", severity, message)));
        }
    }

    Ok(None)
}

fn new_publisher(view: &View, target: &Target, now_ms: f64) -> Result<Option<Finding>, String> {
    new_publisher_within(view, target, now_ms, Some(NEW_PUBLISHER_WINDOW_DAYS))
}

/// The new-publisher check, with the window below which a first-time publisher is unremarkable. `None` is a window of
/// `undefined`, which no age is within: the pipeline of `vis add` passes every threshold as `undefined`, and its
/// spread over the defaults replaces them.
fn new_publisher_within(
    view: &View,
    target: &Target,
    now_ms: f64,
    window_days: Option<f64>,
) -> Result<Option<Finding>, String> {
    let Some(entry) = view.entry(target.version) else { return Ok(None) };
    let Some(current) = identity(entry)? else { return Ok(None) };
    let version = parsed(target)?;
    let priors: Vec<&str> =
        view.semver()?.iter().filter(|(_, other)| *other < version).map(|(name, _)| *name).collect();

    let Some(first) = priors.first() else { return Ok(None) };

    for prior in &priors {
        if view.entry(prior).map(identity).transpose()?.flatten().as_deref() == Some(current.as_str()) {
            return Ok(None);
        }
    }

    let Some(first_release) = published(view, first)? else { return Ok(None) };
    let age = (now_ms - first_release) / MS_PER_DAY;

    if window_days.is_some_and(|window| age <= window) {
        return Ok(None);
    }

    Ok(Some(target.finding(
        "author",
        Severity::Error,
        format!("first publish by {current} on a {}-day-old package", days(age, 0)?),
    )))
}

fn dormant_maintainer(view: &View, target: &Target, now_ms: f64) -> Result<Option<Finding>, String> {
    let Some(entry) = view.entry(target.version) else { return Ok(None) };
    let Some(current) = identity(entry)? else { return Ok(None) };
    let mut latest_other: Option<f64> = None;

    for (name, other) in view.versions() {
        if *name == target.version || identity(other)?.as_deref() != Some(current.as_str()) {
            continue;
        }

        if let Some(released) = published(view, name)? {
            latest_other = Some(latest_other.map_or(released, |latest| latest.max(released)));
        }
    }

    let Some(latest) = latest_other else { return Ok(None) };
    let gap = (now_ms - latest) / MS_PER_DAY;

    for (limit, severity, word) in
        [(DORMANT_ERROR_DAYS, Severity::Error, "error"), (DORMANT_WARN_DAYS, Severity::Warning, "warn")]
    {
        if gap >= limit {
            let message =
                format!("previous release by {current} was {} days ago ({word} threshold: {limit})", days(gap, 0)?);

            return Ok(Some(target.finding("author", severity, message)));
        }
    }

    Ok(None)
}

/// The author marshall as the pipeline of `vis add` runs it. It passes the five thresholds as `undefined`, and
/// `{ ...DEFAULT_THRESHOLDS, ...thresholds }` lets them replace the defaults: a comparison with `undefined` is false, so
/// the recent-version and dormant-maintainer checks never report, and the new-publisher check has no window that excuses a
/// young package. Whether it reports is all `vis add` needs.
pub(crate) fn author_in_pipeline(view: &View, target: &Target) -> Result<bool, String> {
    Ok(new_publisher_within(view, target, 0.0, None)?.is_some())
}

/// The author marshall: a version published recently, by someone new, or by someone who has been away.
pub(super) fn author(view: &View, target: &Target, now_ms: f64) -> Result<Vec<Finding>, String> {
    Ok([
        recent_version(view, target, now_ms)?,
        new_publisher(view, target, now_ms)?,
        dormant_maintainer(view, target, now_ms)?,
    ]
    .into_iter()
    .flatten()
    .collect())
}

/// `entry.dist?.attestations?.provenance !== undefined`.
pub(crate) fn has_provenance(entry: Option<&Js>) -> Result<bool, String> {
    let Some(entry) = entry else { return Ok(false) };

    match entry.member("dist") {
        None => Ok(false),
        Some(dist @ Js::Object(_)) => Ok(
            matches!(dist.member("attestations"), Some(attestations @ Js::Object(_)) if attestations.member("provenance").is_some()),
        ),
        Some(_) => Err("a `dist` that is not an object".to_owned()),
    }
}

/// The highest version below `version`, among those `keep` takes.
fn newest_before<'a>(
    view: &View<'a>,
    version: &Version,
    keep: &dyn Fn(&str, &Version) -> Result<bool, String>,
) -> Result<Option<&'a str>, String> {
    let mut candidates = Vec::new();

    for (name, other) in view.semver()? {
        if other < version && keep(name, other)? {
            candidates.push((*name, other));
        }
    }

    candidates.sort_by_key(|(_, other)| Reverse(*other));

    Ok(candidates.first().map(|(name, _)| *name))
}

/// `findNewestPriorWithAttestations` for a version that has no provenance itself: the newest earlier release (no
/// prerelease) that has some.
pub(crate) fn prior_with_provenance<'a>(view: &View<'a>, version: &str) -> Result<Option<&'a str>, String> {
    let parsed = Version::parse(version).ok_or_else(|| format!("the version {version} is not strict semver"))?;

    newest_before(view, &parsed, &|name, other| Ok(!other.is_prerelease() && has_provenance(view.entry(name))?))
}

/// The provenance marshall: the version has none, and an earlier release had.
pub(super) fn provenance(view: &View, target: &Target) -> Result<Vec<Finding>, String> {
    if has_provenance(view.entry(target.version))? {
        return Ok(Vec::new());
    }

    Ok(prior_with_provenance(view, target.version)?
        .map(|prior| {
            target.finding(
                "provenance",
                Severity::Error,
                format!("Prior version {prior} had provenance but {} does not.", target.version),
            )
        })
        .into_iter()
        .collect())
}

const INSTALL_HOOKS: [&str; 3] = ["preinstall", "install", "postinstall"];

/// The command of an install hook in a version's `scripts`: `None` when it is missing or empty.
fn hook_command<'a>(entry: &'a Js, hook: &str) -> Result<Option<&'a str>, String> {
    match entry.member("scripts").and_then(|scripts| scripts.member(hook)) {
        None => Ok(None),
        Some(Js::String(command)) if command.is_empty() => Ok(None),
        Some(Js::String(command)) => Ok(Some(command)),
        Some(_) => Err(format!("the `{hook}` script is not text")),
    }
}

/// The s1ngularity marshall: a version that adds or changes an install hook while dropping the provenance the release
/// before it had.
pub(super) fn s1ngularity(view: &View, target: &Target) -> Result<Vec<Finding>, String> {
    let Some(entry) = view.entry(target.version) else { return Ok(Vec::new()) };
    let version = parsed(target)?;
    let Some(prior) = newest_before(view, &version, &|_, other| Ok(!other.is_prerelease()))? else {
        return Ok(Vec::new());
    };

    if !has_provenance(view.entry(prior))? || has_provenance(Some(entry))? {
        return Ok(Vec::new());
    }

    let prior_entry = view.entry(prior).ok_or("the prior version has no entry")?;
    let mut changes = Vec::new();

    for hook in INSTALL_HOOKS {
        let Some(command) = hook_command(entry, hook)? else { continue };

        match hook_command(prior_entry, hook)? {
            None => changes.push(format!("{hook} (introduced)")),
            Some(before) if before != command => changes.push(format!("{hook} (changed)")),
            Some(_) => {}
        }
    }

    if changes.is_empty() {
        return Ok(Vec::new());
    }

    let singular = changes.len() == 1;
    let message = format!(
        "{} {} install-script {} [{}] AND dropped the provenance attestation that {prior} carried \u{2014} this is the s1ngularity compromised-publish shape.",
        target.version,
        if singular { "has an" } else { "has" },
        if singular { "change" } else { "changes" },
        changes.join(", ")
    );

    Ok(vec![target.finding("s1ngularity", Severity::Error, message)])
}

/// `normalizeBin`: the `bin` field as `(name, command)` pairs in `Object.entries` order.
fn bins<'a>(entry: &'a Js, package: &'a str) -> Result<Vec<(&'a str, &'a str)>, String> {
    match entry.member("bin") {
        None | Some(Js::Null) => Ok(Vec::new()),
        Some(Js::String(command)) => {
            let inferred =
                if package.starts_with('@') { package.split('/').nth(1).unwrap_or(package) } else { package };

            Ok(vec![(inferred, command)])
        }
        Some(map @ Js::Object(_)) => map
            .ordered()
            .into_iter()
            .map(|(name, command)| {
                command.text().map(|command| (name, command)).ok_or_else(|| format!("the bin {name} is not text"))
            })
            .collect(),
        Some(_) => Err("a `bin` that is neither text nor an object".to_owned()),
    }
}

/// The new-bin marshall: a version with a bin the one before it did not have.
pub(super) fn new_bin(view: &View, target: &Target) -> Result<Vec<Finding>, String> {
    let Some(entry) = view.entry(target.version) else { return Ok(Vec::new()) };
    let version = parsed(target)?;
    let Some(prior) = newest_before(view, &version, &|_, _| Ok(true))? else { return Ok(Vec::new()) };
    let prior_entry = view.entry(prior).ok_or("the prior version has no entry")?;
    let (current, before) = (bins(entry, target.name)?, bins(prior_entry, target.name)?);

    // `binName in priorBins` also finds what an object inherits.
    if current.iter().any(|(name, _)| super::args::is_prototype_name(name)) {
        return Err("a bin named like a member of Object.prototype".to_owned());
    }

    let added: Vec<&str> = current
        .iter()
        .filter(|(name, _)| !before.iter().any(|(old, _)| old == name))
        .map(|(_, command)| *command)
        .collect();

    if added.is_empty() {
        return Ok(Vec::new());
    }

    let message = format!(
        "{} adds new bin script{}: {} (prior: {prior}).",
        target.version,
        if added.len() == 1 { "" } else { "s" },
        added.join(", ")
    );

    Ok(vec![target.finding("newBin", Severity::Warning, message)])
}

/// Whether `candidate` is a URL `URL.canParse` takes, `Some(false)` when it certainly is not, `None` when only the
/// URL parser could tell.
fn can_parse_url(candidate: &str) -> Option<bool> {
    if candidate.is_empty() {
        return Some(false);
    }

    if !candidate.bytes().all(|byte| byte.is_ascii_graphic()) {
        return None;
    }

    // A URL starts with a scheme; without one and with no base there is nothing to resolve against.
    let scheme_end = candidate.find(':');
    let has_scheme = candidate.bytes().next().is_some_and(|first| first.is_ascii_alphabetic())
        && scheme_end.is_some_and(|end| {
            candidate[..end].bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
        });

    if !has_scheme {
        return Some(false);
    }

    // A scheme that is no special one, without `//` after it (`github:owner/repo`), has an opaque path, which takes anything.
    let scheme = candidate[..scheme_end.unwrap_or(0)].to_ascii_lowercase();

    if !["http", "https", "ftp", "file", "ws", "wss"].contains(&scheme.as_str())
        && !candidate[scheme.len() + 1..].starts_with("//")
    {
        return Some(true);
    }

    let (special, rest) = match candidate.strip_prefix("https://").or_else(|| candidate.strip_prefix("http://")) {
        Some(rest) => (true, rest),
        None => (false, candidate.strip_prefix("ssh://").or_else(|| candidate.strip_prefix("git://"))?),
    };
    let (authority, tail) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    let (userinfo, host_and_port) =
        authority.rsplit_once('@').map_or((None, authority), |(userinfo, host)| (Some(userinfo), host));
    let (host, port) = host_and_port.rsplit_once(':').map_or((host_and_port, None), |(host, port)| (host, Some(port)));
    let userinfo_is_plain = userinfo.is_none_or(|text| {
        !text.is_empty()
            && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
    });
    let labels = || host.split('.');
    let host_is_plain = !host.is_empty()
        && labels()
            .all(|label| !label.is_empty() && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'));
    // A special URL reads its host as a domain: a label that starts `xn--` has to be valid punycode, and a host whose
    // last label could be a number (`1`, `0xa`) is read as an IPv4 address, which may fail. A `ssh` or `git` host is opaque.
    let domain_is_plain = !special
        || (labels().all(|label| !label.to_ascii_lowercase().starts_with("xn--"))
            && labels()
                .next_back()
                .is_some_and(|label| label.bytes().next().is_some_and(|first| first.is_ascii_alphabetic())));
    let tail_is_plain = !tail.contains('\\') && !tail.contains('%');

    if !(userinfo_is_plain && host_is_plain && domain_is_plain && tail_is_plain) {
        return None;
    }

    // A port is digits up to 65535; anything else is no URL.
    Some(port.is_none_or(|port| {
        port.bytes().all(|byte| byte.is_ascii_digit())
            && (port.is_empty() || port.parse::<u32>().is_ok_and(|port| port <= 65_535))
    }))
}

/// `checkRepository`: the issue, if there is one.
pub(super) fn repository_issue(entry: &Js) -> Result<Option<&'static str>, String> {
    let url = match entry.member("repository") {
        None => return Ok(Some("missing-repo")),
        Some(Js::Null) => return Err("a `repository` that is null".to_owned()),
        Some(repository @ Js::Object(_)) => {
            repository.member("url").and_then(Js::text).map(crate::js::trim).unwrap_or("")
        }
        Some(_) => "",
    };

    if url.is_empty() {
        return Ok(Some("missing-repo"));
    }

    if !url.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("a repository URL with a space or a non-ASCII character".to_owned());
    }

    let mut candidate = url.strip_prefix("git+").unwrap_or(url).to_owned();

    // `git@host:path(.git)` is read as `https://host/path`; the path is never empty, so a bare `.git` stays.
    if let Some(rest) = candidate.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':').filter(|(host, path)| !host.is_empty() && !path.is_empty()) {
            let path = path.strip_suffix(".git").filter(|stripped| !stripped.is_empty()).unwrap_or(path);

            candidate = format!("https://{host}/{path}");
        }
    }

    match can_parse_url(&candidate) {
        Some(true) => Ok(None),
        Some(false) => Ok(Some("invalid-repo-url")),
        None => Err(format!("{candidate:?} is a URL only the URL parser can judge")),
    }
}

fn license_issue(entry: &Js) -> Result<Option<&'static str>, String> {
    Ok(match entry.member("license") {
        None => Some("missing-license"),
        Some(Js::Null) => return Err("a `license` that is null".to_owned()),
        Some(Js::String(text)) => crate::js::trim(text).is_empty().then_some("missing-license"),
        Some(license @ Js::Object(_)) => license
            .member("type")
            .and_then(Js::text)
            .is_none_or(|kind| crate::js::trim(kind).is_empty())
            .then_some("missing-license"),
        Some(_) => Some("missing-license"),
    })
}

fn readme_issue(view: &View, entry: &Js) -> Option<&'static str> {
    let Some(readme) = entry.member("readme").and_then(Js::text).or(view.readme) else { return Some("missing-readme") };
    let trimmed = crate::js::trim(readme);

    (trimmed.is_empty()
        || trimmed.starts_with("ERROR: No README data found!")
        || trimmed.starts_with("# Security holding package"))
    .then_some("placeholder-readme")
}

/// `resolveLatestVersion` of the metadata marshall.
fn latest_version<'a>(view: &View<'a>) -> Result<Option<&'a str>, String> {
    Ok(match view.tag("latest")? {
        Some(tag) if view.entry(tag).is_some() => Some(tag),
        _ => view.last_version(),
    })
}

/// The metadata marshall: a missing or placeholder readme, a missing license, a missing or unparsable repository.
pub(super) fn metadata(view: &View, target: &Target) -> Result<Vec<Finding>, String> {
    let entry = match view.entry(target.version) {
        Some(entry) => entry,
        None => match latest_version(view)?.and_then(|latest| view.entry(latest)).or_else(|| view.entry("")) {
            Some(entry) => entry,
            None => return Ok(Vec::new()),
        },
    };

    if matches!(entry.member("private"), Some(Js::Bool(true))) {
        return Ok(Vec::new());
    }

    let issues: Vec<&str> =
        [readme_issue(view, entry), license_issue(entry)?, repository_issue(entry)?].into_iter().flatten().collect();

    if issues.is_empty() {
        return Ok(Vec::new());
    }

    Ok(vec![target.finding("metadata", Severity::Warning, format!("Missing/invalid metadata: {}.", issues.join(", ")))])
}
