//! `vis attest verify` (`attestVerifyExecute`): the provenance and signature marshalls over the locked packages of a
//! pnpm workspace, reported as JSON, NDJSON or a table.
//!
//! Node reads the lockfile, asks the registry for each package's packument (through the cache in
//! `~/.vis/cache/packuments`, which [`Packuments`] shares with `vis inspect`) and the registry's signing keys (cache
//! `~/.vis/cache/registry-keys`), runs both marshalls and prints the findings. This module does the same, with up to eight
//! packuments in flight as Node's `mapWithConcurrency` does, from a CI run off a terminal at the root of a pnpm
//! workspace (see [`context_decline`]).
//!
//! What it leaves to Node, before any output:
//!
//! - `--prod-only` (it walks the workspace's `package.json` files), any other flag, and every word after `verify`;
//! - a `MARSHALL_*` variable, a `VIS_NPM_KEYS_URL`, a proxy, CA or Node option, a `packageManager` pin, and a registry,
//!   packument, key or signature this binary does not read the way Node does (see [`crate::inspect`] and
//!   [`super::signature`]);
//! - a lockfile this crate does not read exactly, or none, and a name or version outside printable ASCII;
//! - the table report when there is a finding: the terminal UI draws it. The cache the run filled is written first,
//!   so Node finds it warm; it is the bytes Node writes.

use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::process::exit;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::signature::verifies;
use super::{format_of, parse};
use crate::inspect::{commit, has_provenance, parse_date, prior_with_provenance, CacheAction, Packuments, View};
use crate::js::json_string;
use crate::keys_refresh::{registry_keys, Js, RegistryKey};
use crate::node_context::context_decline;
use crate::output::{node_may_cut_short, write_streams};
use crate::pm_detect::ancestor_pins_package_manager;
use crate::pnpm_lock;
use crate::text::is_ascii_graphic;

/// `DEFAULT_MARSHALL_CONCURRENCY`.
const CONCURRENCY: usize = 8;
/// `DEFAULT_FETCH_TIMEOUT_MS` of the packument module.
const PACKUMENT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Severity {
    Error,
    Warning,
}

impl Severity {
    fn name(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}

/// An `AttestFinding`.
#[derive(Debug, PartialEq, Eq)]
struct Finding {
    code: &'static str,
    message: String,
    package: String,
    severity: Severity,
    version: String,
}

impl Finding {
    /// `JSON.stringify(finding)` with the given line break and indent before each member.
    fn json(&self, break_and_indent: &str, close: &str) -> String {
        let members = [
            ("code", json_string(self.code)),
            ("message", json_string(&self.message)),
            ("packageName", json_string(&self.package)),
            ("severity", json_string(self.severity.name())),
            ("version", json_string(&self.version)),
        ];
        let body: Vec<String> = members
            .iter()
            .map(|(name, value)| {
                format!("{break_and_indent}\"{name}\":{}{value}", if break_and_indent.is_empty() { "" } else { " " })
            })
            .collect();

        format!("{{{}{close}}}", body.join(","))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Flags<'a> {
    format: &'a str,
    fail_on_error: bool,
}

/// What a run prints and the status it ends with.
struct Outcome {
    stdout: String,
    stderr: String,
    status: i32,
}

/// Answers `vis attest verify` natively or hands the whole invocation to Node.
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    match answer(args) {
        Ok(outcome) => {
            write_streams("attest", &outcome.stdout, &outcome.stderr);

            exit(outcome.status)
        }
        Err(reason) => crate::process::delegate_because(&reason, raw_args),
    }
}

fn now_ms() -> Result<u64, String> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "the clock is before 1970".to_owned())?;

    u64::try_from(elapsed.as_millis()).map_err(|_| "the clock is out of range".to_owned())
}

fn answer(args: &[String]) -> Result<Outcome, String> {
    let parsed = parse(args.get(2..).unwrap_or_default(), &["format", "fail-on", "allowlist"], &[])
        .ok_or("not the plain flags of `attest verify`")?;

    if !parsed.words.is_empty() {
        return Err("a word after `verify`".to_owned());
    }

    let fail_on_error = match parsed.value("fail-on") {
        None | Some("warning") => false,
        Some("error") => true,
        Some(_) => return Err("a `--fail-on` value other than warning and error".to_owned()),
    };
    let format = format_of(&parsed).ok_or("a format other than json, ndjson and table")?;
    let allowlist: HashSet<String> = parsed
        .value("allowlist")
        .unwrap_or_default()
        .split(',')
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();

    if !allowlist.iter().all(|name| is_ascii_graphic(name)) {
        return Err("an allowlist entry that is not printable ASCII".to_owned());
    }

    if let Some(reason) = context_decline() {
        return Err(reason.to_owned());
    }

    if env::vars_os().any(|(name, _)| name.to_string_lossy().starts_with("MARSHALL_")) {
        return Err("a MARSHALL_* variable is set".to_owned());
    }

    let root = env::current_dir().map_err(|error| format!("the working directory cannot be read: {error}"))?;

    if ancestor_pins_package_manager(&root) {
        return Err("a package.json pins the package manager".to_owned());
    }

    let packages = locked_packages(&root)?;
    let packuments = Packuments::new(root, PACKUMENT_TIMEOUT)?;
    let keys = registry_keys(now_ms()?)?;
    // The table line is written by the toolbox's logger, which is only known to leave a run without colour plain.
    if format == "table" && crate::term::piped_colour_level(args) != Some(0) {
        return Err("the colour level cannot be told to be none without Node".to_owned());
    }

    let flags = Flags { format, fail_on_error };
    let (scanned, cache) = scan(&packuments, keys.keys.as_deref(), &packages, &allowlist, now_ms()?);
    let outcome = scanned.and_then(|findings| report(flags, packages.len(), &findings));

    // A run that ends here for Node (the table of findings, or a package this binary cannot read) leaves it the cache
    // this run filled, which is the bytes Node writes, so Node does not fetch it all again.
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(reason) => {
            commit(&cache)?;
            keys.commit()?;

            return Err(reason);
        }
    };

    if node_may_cut_short(outcome.stdout.len()) {
        return Err("the report is larger than Node reliably writes to a pipe".to_owned());
    }

    commit(&cache)?;
    keys.commit()?;

    Ok(outcome)
}

/// A locked package.
struct Package {
    name: String,
    version: String,
}

/// `lockedPackages` for a pnpm workspace with dev dependencies: the lockfile's packages, a name and version listed twice
/// counting once.
fn locked_packages(root: &std::path::Path) -> Result<Vec<Package>, String> {
    let bytes =
        fs::read(root.join("pnpm-lock.yaml")).map_err(|error| format!("pnpm-lock.yaml cannot be read: {error}"))?;
    let entries = pnpm_lock::parse(&bytes).ok_or("pnpm-lock.yaml is not text this crate reads exactly")?;

    if entries.is_empty() {
        return Err("the lockfile lists no package".to_owned());
    }

    let mut seen = HashSet::new();
    let mut packages = Vec::new();

    for entry in entries {
        if !is_ascii_graphic(&entry.name) || !is_ascii_graphic(&entry.version) {
            return Err("a package name or version is not printable ASCII".to_owned());
        }

        if seen.insert(format!("{}@{}", entry.name, entry.version)) {
            packages.push(Package { name: entry.name, version: entry.version });
        }
    }

    Ok(packages)
}

/// What the two marshalls find for one package, and the cache change of reading its packument.
struct Checked {
    provenance: Option<String>,
    signatures: Vec<Finding>,
    cache: Vec<CacheAction>,
}

/// Both marshalls over every package, with [`CONCURRENCY`] packages in flight: the provenance findings, then the
/// signature findings, each in the order of the packages, and the cache changes of the packages that were read, whether or
/// not another one failed. The first failure is the run's.
fn scan(
    packuments: &Packuments,
    keys: Option<&[RegistryKey]>,
    packages: &[Package],
    allowlist: &HashSet<String>,
    now_ms: u64,
) -> (Result<Vec<Finding>, String>, Vec<CacheAction>) {
    let by_id: HashMap<&str, &RegistryKey> =
        keys.unwrap_or_default().iter().map(|key| (key.keyid.as_str(), key)).collect();
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Result<Checked, String>>>> = Mutex::new((0..packages.len()).map(|_| None).collect());

    std::thread::scope(|scope| {
        for _ in 0..CONCURRENCY.min(packages.len()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::SeqCst);

                let Some(package) = packages.get(index) else { return };
                let checked = if allowlist.contains(&package.name) {
                    Ok(Checked { provenance: None, signatures: Vec::new(), cache: Vec::new() })
                } else {
                    check(packuments, keys.is_some().then_some(&by_id), package, now_ms)
                };

                results.lock().expect("a worker panicked")[index] = Some(checked);
            });
        }
    });

    let mut provenance = Vec::new();
    let mut signatures = Vec::new();
    let mut cache = Vec::new();
    let mut failure: Option<String> = None;

    for (package, checked) in packages.iter().zip(results.into_inner().expect("a worker panicked")) {
        let checked = match checked {
            Some(Ok(checked)) => checked,
            Some(Err(reason)) => {
                failure.get_or_insert(reason);

                continue;
            }
            None => {
                failure.get_or_insert_with(|| "a package was not checked".to_owned());

                continue;
            }
        };

        if let Some(prior) = checked.provenance {
            provenance.push(Finding {
                code: "provenance-regression",
                message: format!(
                    "Resolved {0}@{1} has no published provenance attestation, but {0}@{prior} did \u{2014} a provenance regression.",
                    package.name, package.version
                ),
                package: package.name.clone(),
                severity: Severity::Warning,
                version: package.version.clone(),
            });
        }

        signatures.extend(checked.signatures);
        cache.extend(checked.cache);
    }

    provenance.extend(signatures);

    (failure.map_or(Ok(provenance), Err), cache)
}

/// Both marshalls for one package that is not on the allowlist. `keys` is `None` when the registry's keys could not be
/// had at all: every package then gets a `fetch-failed` warning, before its packument is read.
fn check(
    packuments: &Packuments,
    keys: Option<&HashMap<&str, &RegistryKey>>,
    package: &Package,
    now_ms: u64,
) -> Result<Checked, String> {
    let (checked, cache) = packuments.read(&package.name, |view| {
        let provenance = match view {
            Some(view) if !has_provenance(view.entry(&package.version))? => {
                prior_with_provenance(view, &package.version)?.map(str::to_owned)
            }
            _ => None,
        };
        let signatures = match (keys, view) {
            (None, _) => vec![finding(
                package,
                "fetch-failed",
                Severity::Warning,
                "Could not fetch registry signing keys.".to_owned(),
            )],
            (Some(_), None) => Vec::new(),
            (Some(keys), Some(view)) => signature_findings(view, keys, package, now_ms)?,
        };

        Ok((provenance, signatures))
    })?;

    Ok(Checked { provenance: checked.0, signatures: checked.1, cache })
}

fn finding(package: &Package, code: &'static str, severity: Severity, message: String) -> Finding {
    Finding { code, message, package: package.name.clone(), severity, version: package.version.clone() }
}

/// `dist.signatures` as (keyid, signature) pairs when there are some, and `dist.integrity`.
type DistSignatures<'a> = (Option<Vec<(&'a str, &'a str)>>, Option<&'a str>);

/// `entry.dist?.signatures` and `entry.dist?.integrity` of the version's entry.
fn signatures_of(entry: &Js) -> Result<DistSignatures<'_>, String> {
    let dist = match entry.member("dist") {
        None => return Ok((None, None)),
        Some(dist @ Js::Object(_)) => dist,
        Some(_) => return Err("a `dist` that is not an object".to_owned()),
    };
    let integrity = dist.member("integrity").and_then(Js::text);
    let signatures = match dist.member("signatures") {
        None => None,
        Some(Js::Array(items)) => Some(
            items
                .iter()
                .map(|item| match (item.member("keyid").and_then(Js::text), item.member("sig").and_then(Js::text)) {
                    (Some(keyid), Some(sig)) => Ok((keyid, sig)),
                    _ => Err("a signature without a text keyid and sig".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Some(_) => return Err("`dist.signatures` is not an array".to_owned()),
    };

    Ok((signatures, integrity))
}

/// The signature marshall for a package whose packument exists.
fn signature_findings(
    view: &View<'_>,
    keys: &HashMap<&str, &RegistryKey>,
    package: &Package,
    now_ms: u64,
) -> Result<Vec<Finding>, String> {
    let (name, version) = (package.name.as_str(), package.version.as_str());
    // `versions[version] ?? versions[latest]`, where latest is the `latest` tag when it names a version, else the last one.
    let latest = view.tag("latest")?.filter(|tag| view.entry(tag).is_some()).or_else(|| view.last_version());
    let Some(entry) = view.entry(version).or_else(|| latest.and_then(|tag| view.entry(tag))) else {
        return Ok(Vec::new());
    };
    let (signatures, integrity) = signatures_of(entry)?;
    let missing = |message: String| vec![finding(package, "missing-signature", Severity::Warning, message)];

    let Some(signatures) = signatures.filter(|signatures| !signatures.is_empty()) else {
        return Ok(missing(format!("Package {name}@{version} has no dist.signatures from the registry.")));
    };

    let Some(integrity) = integrity.filter(|integrity| !integrity.is_empty()) else {
        return Ok(missing(format!(
            "Package {name}@{version} has signatures but no dist.integrity to verify against."
        )));
    };

    let message = format!("{name}@{version}:{integrity}");
    let mut findings = Vec::new();

    for (keyid, sig) in signatures {
        let Some(key) = keys.get(keyid) else {
            findings.push(finding(
                package,
                "unknown-keyid",
                Severity::Error,
                format!("Package {name}@{version} was signed with an unrecognized keyid ({keyid})."),
            ));

            continue;
        };

        if is_expired(key, now_ms)? {
            findings.push(finding(
                package,
                "expired-key",
                Severity::Warning,
                format!(
                    "Package {name}@{version} was signed with an expired key ({keyid}, expired {}).",
                    key.expires.as_deref().unwrap_or("unknown")
                ),
            ));

            continue;
        }

        if !verifies(&key.key, &message, sig)? {
            findings.push(finding(
                package,
                "invalid-signature",
                Severity::Error,
                format!("Package {name}@{version} signature did not verify against {keyid}."),
            ));
        }
    }

    Ok(findings)
}

/// `isKeyExpired`: `Date.parse(expires) <= now`, for the one form registries write; another form is Node's.
fn is_expired(key: &RegistryKey, now_ms: u64) -> Result<bool, String> {
    match key.expires.as_deref() {
        None | Some("") => Ok(false),
        Some(expires) => {
            let at =
                parse_date(expires).ok_or_else(|| format!("a key expiry {expires:?} this binary does not parse"))?;

            Ok(at <= now_ms as f64)
        }
    }
}

/// The report of a run, or the reason Node prints it.
fn report(flags: Flags<'_>, count: usize, findings: &[Finding]) -> Result<Outcome, String> {
    let gating = findings.iter().filter(|finding| !flags.fail_on_error || finding.severity == Severity::Error).count();
    let status = i32::from(gating > 0);
    let none = String::new;

    match flags.format {
        "json" => {
            let list = if findings.is_empty() {
                "[]".to_owned()
            } else {
                let items: Vec<String> =
                    findings.iter().map(|finding| format!("    {}", finding.json("\n      ", "\n    "))).collect();

                format!("[\n{}\n  ]", items.join(",\n"))
            };

            Ok(Outcome {
                stdout: format!("{{\n  \"findings\": {list},\n  \"ok\": {}\n}}\n", gating == 0),
                stderr: none(),
                status,
            })
        }
        "ndjson" => Ok(Outcome {
            stdout: findings.iter().map(|finding| format!("{}\n", finding.json("", ""))).collect(),
            stderr: none(),
            status,
        }),
        _ if findings.is_empty() => {
            // `logger.info` of the toolbox is the console: the message and a line break, on stdout.
            let stdout = format!("No provenance regressions or signature problems across {count} locked packages.\n");

            Ok(Outcome { stdout, stderr: none(), status })
        }
        _ => Err("the table of findings is drawn by the terminal UI".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::Ordering;

    use serde_json::{json, Value};

    use super::super::signature::support::Signer;
    use super::*;
    use crate::inspect::tests::{ok, packuments_for, Registry};

    const NOW: u64 = 1_718_452_800_000;

    fn package(name: &str, version: &str) -> Package {
        Package { name: name.to_owned(), version: version.to_owned() }
    }

    fn key(signer: &Signer, keyid: &str, expires: Option<&str>) -> RegistryKey {
        RegistryKey { keyid: keyid.to_owned(), key: signer.key_base64.clone(), expires: expires.map(str::to_owned) }
    }

    /// A packument whose versions hold the given `dist` objects.
    fn packument(name: &str, versions: &[(&str, Value)]) -> Value {
        let entries: serde_json::Map<String, Value> =
            versions.iter().map(|(version, dist)| ((*version).to_owned(), json!({ "dist": dist }))).collect();

        json!({ "name": name, "dist-tags": { "latest": versions.last().unwrap().0 }, "versions": entries })
    }

    fn signed_dist(signer: &Signer, keyid: &str, name: &str, version: &str) -> Value {
        let integrity = "sha512-abc";

        json!({ "integrity": integrity, "signatures": [{ "keyid": keyid, "sig": signer.sign(&format!("{name}@{version}:{integrity}")) }] })
    }

    type Scanned = Result<(Vec<Finding>, Vec<CacheAction>), String>;

    fn run_scan(
        packuments: &HashMap<String, Value>,
        keys: Option<&[RegistryKey]>,
        packages: &[Package],
        allowlist: &[&str],
    ) -> (Scanned, usize) {
        let registry = Registry::start(packuments.iter().map(|(name, body)| (format!("/{name}"), ok(body))).collect());
        let (source, _) = packuments_for(&registry);
        let allowlist: HashSet<String> = allowlist.iter().map(|name| (*name).to_owned()).collect();
        let (found, cache) = scan(&source, keys, packages, &allowlist, NOW);

        (found.map(|findings| (findings, cache)), registry.requests.load(Ordering::SeqCst))
    }

    fn codes(findings: &[Finding]) -> Vec<(String, &'static str, String)> {
        findings.iter().map(|finding| (finding.package.clone(), finding.code, finding.message.clone())).collect()
    }

    #[test]
    fn provenance_and_signatures_are_checked_for_every_package_and_the_allowlist_is_not_asked() {
        let signer = Signer::new();
        let other = Signer::new();
        let keys = [key(&signer, "sha256-known", None), key(&signer, "sha256-old", Some("2024-01-01T00:00:00.000Z"))];
        let attested = json!({ "attestations": { "provenance": { "predicateType": "x" } } });
        let packuments = HashMap::from([
            // Signed and valid, and its provenance was dropped after a release that had it.
            (
                "a".to_owned(),
                packument(
                    "a",
                    &[
                        ("1.0.0", {
                            let mut dist = signed_dist(&signer, "sha256-known", "a", "1.0.0");
                            dist["attestations"] = attested["attestations"].clone();
                            dist
                        }),
                        ("2.0.0", signed_dist(&signer, "sha256-known", "a", "2.0.0")),
                    ],
                ),
            ),
            // No signatures at all, then a signature without an integrity.
            ("b".to_owned(), packument("b", &[("1.0.0", json!({}))])),
            (
                "c".to_owned(),
                packument("c", &[("1.0.0", json!({ "signatures": [{ "keyid": "sha256-known", "sig": "AAAA" }] }))]),
            ),
            // An unknown key, an expired key, and a signature by another key.
            ("d".to_owned(), packument("d", &[("1.0.0", signed_dist(&signer, "sha256-nobody", "d", "1.0.0"))])),
            ("e".to_owned(), packument("e", &[("1.0.0", signed_dist(&signer, "sha256-old", "e", "1.0.0"))])),
            ("f".to_owned(), packument("f", &[("1.0.0", signed_dist(&other, "sha256-known", "f", "1.0.0"))])),
            // A version the packument lacks (the latest entry is read instead), and `ghost`, which is not in the registry.
            ("h".to_owned(), packument("h", &[("1.0.0", signed_dist(&signer, "sha256-known", "h", "1.0.0"))])),
        ]);
        let packages = [
            package("a", "2.0.0"),
            package("b", "1.0.0"),
            package("c", "1.0.0"),
            package("d", "1.0.0"),
            package("e", "1.0.0"),
            package("f", "1.0.0"),
            package("ghost", "1.0.0"),
            package("h", "9.9.9"),
            package("skipped", "1.0.0"),
        ];
        let (result, requests) = run_scan(&packuments, Some(&keys), &packages, &["skipped"]);
        let (findings, cache) = result.unwrap();

        // `skipped` is never asked for; `ghost` is a 404 that leaves no cache entry.
        assert_eq!(requests, 8);
        assert_eq!(cache.len(), 7);
        assert_eq!(
            codes(&findings),
            [
                (
                    "a".to_owned(),
                    "provenance-regression",
                    "Resolved a@2.0.0 has no published provenance attestation, but a@1.0.0 did \u{2014} a provenance regression.".to_owned()
                ),
                ("b".to_owned(), "missing-signature", "Package b@1.0.0 has no dist.signatures from the registry.".to_owned()),
                (
                    "c".to_owned(),
                    "missing-signature",
                    "Package c@1.0.0 has signatures but no dist.integrity to verify against.".to_owned()
                ),
                (
                    "d".to_owned(),
                    "unknown-keyid",
                    "Package d@1.0.0 was signed with an unrecognized keyid (sha256-nobody).".to_owned()
                ),
                (
                    "e".to_owned(),
                    "expired-key",
                    "Package e@1.0.0 was signed with an expired key (sha256-old, expired 2024-01-01T00:00:00.000Z).".to_owned()
                ),
                (
                    "f".to_owned(),
                    "invalid-signature",
                    "Package f@1.0.0 signature did not verify against sha256-known.".to_owned()
                ),
                // The entry of the latest version is read for a version the packument lacks, and the message it was
                // signed over names the other version.
                (
                    "h".to_owned(),
                    "invalid-signature",
                    "Package h@9.9.9 signature did not verify against sha256-known.".to_owned()
                ),
            ]
        );
        assert_eq!(
            findings.iter().map(|finding| (finding.code, finding.severity)).collect::<Vec<_>>(),
            [
                ("provenance-regression", Severity::Warning),
                ("missing-signature", Severity::Warning),
                ("missing-signature", Severity::Warning),
                ("unknown-keyid", Severity::Error),
                ("expired-key", Severity::Warning),
                ("invalid-signature", Severity::Error),
                ("invalid-signature", Severity::Error),
            ]
        );
    }

    #[test]
    fn without_keys_every_package_that_is_not_allowlisted_gets_a_warning_after_the_provenance_findings() {
        let packuments = HashMap::from([("a".to_owned(), packument("a", &[("1.0.0", json!({}))]))]);
        let (result, _) = run_scan(
            &packuments,
            None,
            &[package("a", "1.0.0"), package("ghost", "1.0.0"), package("s", "1.0.0")],
            &["s"],
        );
        let (findings, _) = result.unwrap();

        assert_eq!(
            codes(&findings),
            [
                ("a".to_owned(), "fetch-failed", "Could not fetch registry signing keys.".to_owned()),
                ("ghost".to_owned(), "fetch-failed", "Could not fetch registry signing keys.".to_owned()),
            ]
        );
    }

    #[test]
    fn a_packument_or_signature_this_binary_does_not_read_as_node_does_is_handed_over() {
        let signer = Signer::new();
        let keys = [
            key(&signer, "k", None),
            RegistryKey { keyid: "x".to_owned(), key: "!!".to_owned(), expires: Some("soon".to_owned()) },
        ];
        let bad = |body: Value, version: &str| {
            let packuments = HashMap::from([("a".to_owned(), body)]);

            run_scan(&packuments, Some(&keys), &[package("a", version)], &[]).0.is_err()
        };

        // `dist.signatures` that is not a list, an element without a keyid, a key that is not a P-256 SPKI, a key expiry in
        // another form, a version that is not strict semver.
        assert!(bad(packument("a", &[("1.0.0", json!({ "integrity": "i", "signatures": "x" }))]), "1.0.0"));
        assert!(bad(
            packument("a", &[("1.0.0", json!({ "integrity": "i", "signatures": [{ "sig": "x" }] }))]),
            "1.0.0"
        ));
        assert!(bad(
            packument("a", &[("1.0.0", json!({ "integrity": "i", "signatures": [{ "keyid": "x", "sig": "AAAA" }] }))]),
            "1.0.0"
        ));
        assert!(bad(packument("a", &[("1.0.0", json!({}))]), "1.0"));
    }

    #[test]
    fn a_failed_request_ends_the_scan() {
        let signer = Signer::new();
        let registry = Registry::start(HashMap::from([("/a".to_owned(), (500, "{}".to_owned(), Vec::new()))]));
        let (source, _) = packuments_for(&registry);
        let (found, cache) =
            scan(&source, Some(&[key(&signer, "k", None)]), &[package("a", "1.0.0")], &HashSet::new(), NOW);

        assert!(found.is_err() && cache.is_empty());
    }

    #[test]
    fn a_failing_package_leaves_the_cache_of_the_others_to_node() {
        let signer = Signer::new();
        let registry = Registry::start(HashMap::from([
            ("/a".to_owned(), ok(&packument("a", &[("1.0.0", signed_dist(&signer, "k", "a", "1.0.0"))]))),
            ("/b".to_owned(), (500, "{}".to_owned(), Vec::new())),
            ("/c".to_owned(), ok(&packument("c", &[("1.0.0", signed_dist(&signer, "k", "c", "1.0.0"))]))),
        ]));
        let (source, _) = packuments_for(&registry);
        let packages = [package("a", "1.0.0"), package("b", "1.0.0"), package("c", "1.0.0")];
        let (found, cache) = scan(&source, Some(&[key(&signer, "k", None)]), &packages, &HashSet::new(), NOW);

        assert!(found.is_err());
        assert_eq!(cache.len(), 2);
    }

    fn finding_of(code: &'static str, severity: Severity) -> Finding {
        Finding {
            code,
            message: "m \u{2014} \"q\"".to_owned(),
            package: "p".to_owned(),
            severity,
            version: "1.0.0".to_owned(),
        }
    }

    #[test]
    fn the_json_report_is_what_json_stringify_writes() {
        let flags = |format, fail_on_error| Flags { format, fail_on_error };
        let empty = report(flags("json", false), 3, &[]).unwrap();

        assert_eq!((empty.stdout.as_str(), empty.status), ("{\n  \"findings\": [],\n  \"ok\": true\n}\n", 0));

        let findings =
            [finding_of("missing-signature", Severity::Warning), finding_of("invalid-signature", Severity::Error)];
        let full = report(flags("json", false), 3, &findings).unwrap();

        assert_eq!(full.status, 1);
        assert_eq!(
            full.stdout,
            concat!(
                "{\n  \"findings\": [\n    {\n      \"code\": \"missing-signature\",\n      \"message\": \"m \u{2014} \\\"q\\\"\",\n",
                "      \"packageName\": \"p\",\n      \"severity\": \"warning\",\n      \"version\": \"1.0.0\"\n    },\n",
                "    {\n      \"code\": \"invalid-signature\",\n      \"message\": \"m \u{2014} \\\"q\\\"\",\n",
                "      \"packageName\": \"p\",\n      \"severity\": \"error\",\n      \"version\": \"1.0.0\"\n    }\n  ],\n  \"ok\": false\n}\n"
            )
        );
        // The document is what a JSON reader gets from the objects.
        assert_eq!(serde_json::from_str::<Value>(&full.stdout).unwrap()["findings"][1]["code"], "invalid-signature");

        // Only error findings gate with `--fail-on error`.
        assert_eq!(report(flags("json", true), 3, &findings[..1]).unwrap().status, 0);
        assert!(report(flags("json", true), 3, &findings[..1]).unwrap().stdout.ends_with("\"ok\": true\n}\n"));
        assert_eq!(report(flags("json", true), 3, &findings).unwrap().status, 1);
    }

    #[test]
    fn the_ndjson_report_has_a_line_per_finding_and_the_table_a_line_only_when_clean() {
        let flags = |format| Flags { format, fail_on_error: false };
        let findings = [finding_of("missing-signature", Severity::Warning)];
        let lines = report(flags("ndjson"), 1, &findings).unwrap();

        assert_eq!(
            lines.stdout,
            "{\"code\":\"missing-signature\",\"message\":\"m \u{2014} \\\"q\\\"\",\"packageName\":\"p\",\"severity\":\"warning\",\"version\":\"1.0.0\"}\n"
        );
        assert_eq!(lines.status, 1);
        assert_eq!(report(flags("ndjson"), 1, &[]).unwrap().stdout, "");

        let clean = report(flags("table"), 12, &[]).unwrap();

        assert_eq!(clean.stdout, "No provenance regressions or signature problems across 12 locked packages.\n");
        assert_eq!(clean.status, 0);
        assert!(report(flags("table"), 1, &findings).is_err());
    }
}
