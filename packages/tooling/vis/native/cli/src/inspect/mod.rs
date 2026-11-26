//! `vis inspect <package>[@<spec>] --json [--strict] [--only <marshalls>]` — the native port of
//! `src/commands/inspect/handler.ts` for its JSON report.
//!
//! Node fetches the packument (`getPackument`, cached half an hour in `~/.vis/cache/packuments`), resolves the spec to a
//! version, runs each marshall in turn and prints `{errors, findings, summary, warnings}`; it exits 1 when there is an
//! error (or any finding with `--strict`) and 2 when the package is missing or the spec names no version. This module
//! reproduces that for a unix CI run off a terminal at the root of a pnpm workspace (see [`context_decline`]).
//!
//! What it runs: all nine marshalls, in the order of the handler (`signatures` only for `--only signatures`): `author`,
//! `provenance`, `s1ngularity`, `newBin` and `metadata` read the packument; `downloads` asks the registry's download API,
//! `archivedRepo` GitHub, `signatures` the registry's signing keys, and `expiredDomains` a DNS resolver for the NS records of
//! the maintainers' domains (see [`downloads`], [`archived_repo`], [`signatures`] and [`expired_domains`]). `MARSHALL_DISABLE_*`
//! and `--only` pick which.
//!
//! Everything it cannot reproduce goes to Node before anything is printed or written:
//!
//! - the text report (a pail line with `\u{2713}` and an em dash), every other flag and every argument that is not the
//!   plain shape of [`args::parse`];
//! - a registry that needs a credential, a registry URL, proxy, CA or Node option that `fetch` and this client would
//!   read differently (see [`crate::keys_refresh`]), an `.npmrc` that refers to the environment;
//! - a registry answer other than 200 and 404, a redirect, a body that is not a JSON object, and a packument Node would
//!   fail on or read through the prototype (see [`packument`]);
//! - a spec that is not a tag or an exact version (a range needs node-semver's `maxSatisfying`), versions that are not
//!   strict semver, a time that is not in the form registries write, and the field types [`marshalls`] names;
//! - a service answer, or a resolver answer, that Node would read differently or that depends on the machine (a request
//!   that fails before an answer, a redirect, a body that is not JSON, a DNS answer other than "NS records", "no such
//!   domain" and "no data", a domain that is not a plain host name): each marshall's module names its cases.
//!
//! The packument cache and the service caches are read and written as Node does: a fresh entry is used, a fetched answer
//! is written, in the bytes `JSON.stringify` writes. All writes come after the last place a run can be handed over.

mod archived_repo;
mod args;
mod downloads;
mod expired_domains;
mod js_format;
mod js_value;
mod marshalls;
mod npmrc;
mod packument;
mod report;
mod semver_js;
mod service_cache;
mod signatures;

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::{SystemTime, UNIX_EPOCH};

use args::{Flags, Marshall};
use marshalls::{Finding, Target};
use packument::{Answer, Cached, View};

use crate::cache::dirs::vis_cache_dir;
use crate::http::node_fetch::{fetch_config, network_environment_is_plain, url_is_plain};
use crate::http::{HttpClient, HttpConfig};
use crate::keys_refresh::{Js, FETCH_TIMEOUT};
use crate::node_context::context_decline;
use crate::output::write_streams;
use crate::pail::{Layout, Level};

/// A change to the cache a run makes once it is sure to answer.
#[derive(Debug, PartialEq, Eq)]
enum CacheAction {
    Write { file: PathBuf, text: String },
    Remove(PathBuf),
}

/// What a run prints, the status it ends with and the cache it changes.
#[derive(Debug)]
struct Plan {
    stdout: String,
    stderr: String,
    status: i32,
    cache: Vec<CacheAction>,
}

/// `DEFAULT_KEYS_URL` of `registry-keys.ts`.
const KEYS_URL: &str = "https://registry.npmjs.org/-/npm/v1/keys";

/// The web services a run asks, as addresses so that a test can point them at a stub on this machine.
struct Services {
    /// `DOWNLOADS_API_BASE`.
    downloads: String,
    /// `GITHUB_API_BASE`.
    github: String,
    /// The registry's signing keys: `VIS_NPM_KEYS_URL` or npm's address (`None` for a variable that is not text).
    keys: Option<String>,
    /// The resolver `expiredDomains` asks, and how long it waits.
    dns: expired_domains::Resolver,
    /// `GITHUB_TOKEN`, as the environment holds it: `archivedRepo` sends it, and checks it when it does.
    github_token: Option<OsString>,
}

impl Services {
    fn production() -> Self {
        Self {
            downloads: downloads::API.to_owned(),
            github: archived_repo::API.to_owned(),
            dns: expired_domains::Resolver::production(),
            keys: match std::env::var("VIS_NPM_KEYS_URL") {
                Ok(url) => Some(url),
                Err(std::env::VarError::NotPresent) => Some(KEYS_URL.to_owned()),
                Err(std::env::VarError::NotUnicode(_)) => None,
            },
            github_token: std::env::var_os("GITHUB_TOKEN"),
        }
    }
}

/// What the run reads from outside: the places, the services and the time.
struct Context {
    services: Services,
    root: PathBuf,
    home: PathBuf,
    cache_dir: String,
    now_ms: u64,
    layout: Option<Layout>,
}

/// Answers `vis inspect …` natively or hands the whole invocation to Node. A hand-off names its reason on stderr when
/// `VIS_DEBUG_DECLINE` is set (see `delegate_because`).
pub fn run(args: &[String], raw_args: &[OsString]) -> ! {
    let plan = match answer(args) {
        Ok(plan) => plan,
        Err(reason) => crate::process::delegate_because(&reason, raw_args),
    };

    write_streams("inspect", &plan.stdout, &plan.stderr);

    exit(plan.status)
}

fn now_ms() -> Result<u64, String> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "the clock is before 1970".to_owned())?;

    u64::try_from(elapsed.as_millis()).map_err(|_| "the clock is out of range".to_owned())
}

/// The marshalls a run executes, or the reason it is Node's.
fn selected_marshalls(flags: &Flags) -> Result<Vec<Marshall>, String> {
    args::selected(flags.only.as_deref(), &args::process_lookup)
        .ok_or_else(|| "a MARSHALL_DISABLE_* variable is not text".to_owned())
}

/// The plan of a run, or the reason it is Node's.
fn answer(args: &[String]) -> Result<Plan, String> {
    let flags = args::parse(args)?;

    if !flags.json {
        return Err("the text report is a pail line with symbols pail's width rule does not cover".to_owned());
    }

    let run = selected_marshalls(&flags)?;

    if let Some(reason) = context_decline() {
        return Err(reason.to_owned());
    }

    if !network_environment_is_plain() {
        return Err("a proxy, CA or Node option is set in the environment".to_owned());
    }

    let cache_dir = vis_cache_dir().ok_or("no cache directory (HOME is not a plain absolute path)")?;
    let home = std::env::var("HOME").map_err(|_| "HOME is not text".to_owned())?;
    let root = std::env::current_dir().map_err(|error| format!("the working directory is unknown: {error}"))?;
    let context = Context {
        services: Services::production(),
        root,
        home: PathBuf::from(home),
        cache_dir,
        now_ms: now_ms()?,
        layout: Layout::detect(args),
    };
    let client = HttpClient::new(fetch_config(HttpConfig::from_env(FETCH_TIMEOUT, FETCH_TIMEOUT), FETCH_TIMEOUT));
    let plan = plan(&flags, &run, &context, &client)?;

    commit(&plan.cache)?;

    Ok(plan)
}

/// What `getPackument` returns for the package: the cut-down document, and the cache change that goes with it.
fn packument_of(
    flags: &Flags,
    context: &Context,
    client: &HttpClient,
) -> Result<(Option<Js>, Vec<CacheAction>), String> {
    let file = packument::cache_file(&context.cache_dir, &flags.name);
    let stale_file = match packument::read_cache(&file, context.now_ms as f64)? {
        Cached::Fresh(found) => return Ok((Some(found), Vec::new())),
        Cached::Fetch { stale_file } => stale_file,
    };
    let registry = npmrc::registry_for(&flags.name, &context.home, &context.root)?;
    let base = registry.strip_suffix('/').unwrap_or(&registry);
    let url = format!("{base}/{}", flags.name.replacen('/', "%2f", 1));

    if !url_is_plain(&url) {
        return Err(format!("the registry URL {url:?} is not a URL `fetch` and the client read alike"));
    }

    Ok(match packument::fetch(client, &url)? {
        Answer::NotFound => (None, if stale_file { vec![CacheAction::Remove(file)] } else { Vec::new() }),
        Answer::Found(found) => {
            let text =
                packument::cache_entry(&found, context.now_ms).ok_or("the packument cannot be written as JSON")?;

            (Some(found), vec![CacheAction::Write { file, text }])
        }
    })
}

/// `resolveVersionRange`, for a spec that is no spec, a tag or an exact version.
fn resolve<'a>(view: &View<'a>, spec: Option<&str>) -> Result<Option<&'a str>, String> {
    if view.is_empty() {
        return Ok(None);
    }

    let spec = match spec {
        None | Some("latest") => return Ok(view.tag("latest")?.or_else(|| view.last_version())),
        Some(spec) if args::is_prototype_name(spec) => {
            return Err(format!("the spec {spec} is the name of a member of Object.prototype"))
        }
        Some(spec) => spec,
    };

    if let Some(tagged) = view.tag(spec)? {
        return Ok(Some(tagged));
    }

    match view.versions().iter().find(|(name, _)| *name == spec) {
        Some((name, _)) => Ok(Some(*name)),
        None => Err(format!("the spec {spec} is a range, which needs node-semver")),
    }
}

/// The whole run, up to what it prints: pure but for the cache read, the registry request and the clock in `context`.
fn plan(flags: &Flags, run: &[Marshall], context: &Context, client: &HttpClient) -> Result<Plan, String> {
    let (found, mut cache) = packument_of(flags, context, client)?;
    let missing = |message: String| -> Result<Plan, String> {
        let layout = context
            .layout
            .filter(|layout| layout.fits_one_line(&message))
            .ok_or("the error line does not fit pail's width rule")?;

        Ok(Plan { stdout: String::new(), stderr: layout.block(Level::Error, &message), status: 2, cache: Vec::new() })
    };

    let Some(found) = found else {
        let mut plan = missing(format!("Package {} not found in the registry.", flags.name))?;

        plan.cache = cache;

        return Ok(plan);
    };

    let view = View::new(&found)?;
    let Some(version) = resolve(&view, flags.spec.as_deref())? else {
        let mut plan = missing(format!(
            "Could not resolve {}@{} to a published version.",
            flags.name,
            flags.spec.as_deref().unwrap_or("latest")
        ))?;

        plan.cache = cache;

        return Ok(plan);
    };

    if args::is_prototype_name(version) || semver_js::Version::parse(version).is_none() {
        return Err(format!("the resolved version {version:?} is not strict semver"));
    }

    let target = Target { name: &flags.name, version };
    let mut findings: Vec<Finding> = Vec::new();

    for marshall in run {
        findings.extend(match marshall {
            Marshall::Author => marshalls::author(&view, &target, context.now_ms as f64)?,
            Marshall::Provenance => marshalls::provenance(&view, &target)?,
            Marshall::S1ngularity => marshalls::s1ngularity(&view, &target)?,
            Marshall::NewBin => marshalls::new_bin(&view, &target)?,
            Marshall::Metadata => marshalls::metadata(&view, &target)?,
            Marshall::Downloads => {
                let base = &context.services.downloads;

                if !url_is_plain(base) {
                    return Err(format!(
                        "the downloads address {base:?} is not a URL `fetch` and the client read alike"
                    ));
                }

                let (found, changes) = downloads::run(client, base, &context.cache_dir, &flags.name, context.now_ms)?;

                cache.extend(changes);

                found
            }
            Marshall::Signatures => {
                let keys = context.services.keys.as_deref();
                let (found, changes) =
                    signatures::run(client, keys, &context.cache_dir, &view, &target, context.now_ms)?;

                cache.extend(changes);

                found
            }
            Marshall::ArchivedRepo => {
                let base = &context.services.github;

                if !url_is_plain(base) {
                    return Err(format!("the GitHub address {base:?} is not a URL `fetch` and the client read alike"));
                }

                let token = context.services.github_token.as_deref();
                let (found, changes) =
                    archived_repo::run(client, base, token, &context.cache_dir, &view, &target, context.now_ms)?;

                cache.extend(changes);

                found
            }
            Marshall::ExpiredDomains => {
                let (found, changes) =
                    expired_domains::run(&context.services.dns, &context.cache_dir, &view, &target, context.now_ms)?;

                cache.extend(changes);

                found
            }
        });
    }

    let errors = findings.iter().any(|finding| finding.severity == marshalls::Severity::Error);
    let status = i32::from(errors || (flags.strict && !findings.is_empty()));

    Ok(Plan { stdout: report::json(&findings), stderr: String::new(), status, cache })
}

/// Makes the cache changes of a plan. A change that fails is Node's to report.
fn commit(actions: &[CacheAction]) -> Result<(), String> {
    for action in actions {
        match action {
            CacheAction::Write { file, text } => {
                let directory = file.parent().ok_or("the cache file has no directory")?;

                fs::create_dir_all(directory)
                    .and_then(|()| fs::write(file, text))
                    .map_err(|error| format!("the packument cache cannot be written: {error}"))?;
            }
            CacheAction::Remove(file) => remove(file)?,
        }
    }

    Ok(())
}

fn remove(file: &Path) -> Result<(), String> {
    match fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("the packument cache cannot be removed: {error}")),
    }
}

#[cfg(test)]
mod tests;
