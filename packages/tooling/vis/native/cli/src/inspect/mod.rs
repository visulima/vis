//! `vis inspect <package>[@<spec>] --json [--strict] [--only <marshalls>]` — the native port of
//! `src/commands/inspect/handler.ts` for the JSON report of the marshalls that read the registry's packument, and of
//! `downloads`, which asks the registry's download API (see [`downloads`]), and `archivedRepo`, which asks GitHub (see
//! [`archived_repo`]).
//!
//! Node fetches the packument (`getPackument`, cached half an hour in `~/.vis/cache/packuments`), resolves the spec to a
//! version, runs each marshall in turn and prints `{errors, findings, summary, warnings}`; it exits 1 when there is an
//! error (or any finding with `--strict`) and 2 when the package is missing or the spec names no version. This module
//! reproduces that for a unix CI run off a terminal at the root of a pnpm workspace (see [`context_decline`]).
//!
//! What it runs: `author`, `provenance`, `s1ngularity`, `newBin`, `metadata`, `downloads` and `archivedRepo`. A run that
//! has to execute another marshall goes to Node, so `vis inspect <package> --json` alone does too: `expiredDomains` looks
//! up DNS records and `signatures` asks the registry for its keys. `MARSHALL_DISABLE_*` or `--only` make a run native.
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
//!   strict semver, a time that is not in the form registries write, and the field types [`marshalls`] names.
//!
//! The packument cache and the service caches are read and written as Node does: a fresh entry is used, a fetched answer
//! is written, in the bytes `JSON.stringify` writes. All writes come after the last place a run can be handed over.

mod archived_repo;
mod args;
mod clean;
mod downloads;
mod js_format;
mod js_value;
mod marshalls;
mod npmrc;
mod packument;
mod report;
mod semver_js;
mod service_cache;

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) use args::parse_package;
use args::{Flags, Marshall};
pub(crate) use clean::{entry_or_latest, first_finding, Checks};
pub(crate) use js_format::parse_date;
pub(crate) use marshalls::{has_provenance, prior_with_provenance};
use marshalls::{Finding, Target};
pub(crate) use packument::View;
use packument::{Answer, Cached};

use crate::cache::dirs::vis_cache_dir;
use crate::http::node_fetch::{fetch_config, network_environment_is_plain, url_is_plain};
use crate::http::{HttpClient, HttpConfig};
use crate::keys_refresh::{Js, FETCH_TIMEOUT};
use crate::node_context::context_decline;
use crate::output::write_streams;
use crate::pail::{Layout, Level};

/// A change to the cache a run makes once it is sure to answer.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CacheAction {
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

/// The web services a run asks, as addresses so that a test can point them at a stub on this machine.
struct Services {
    /// `DOWNLOADS_API_BASE`.
    downloads: String,
    /// `GITHUB_API_BASE`.
    github: String,
    /// `GITHUB_TOKEN`, as the environment holds it: `archivedRepo` sends it, and checks it when it does.
    github_token: Option<OsString>,
}

impl Services {
    fn production() -> Self {
        Self {
            downloads: downloads::API.to_owned(),
            github: archived_repo::API.to_owned(),
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
    /// The registry every package comes from, when `.npmrc` is not read (the packument lookup of a command that runs
    /// outside a workspace root, where Node asks the default registry).
    registry: Option<String>,
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
fn native_marshalls(flags: &Flags) -> Result<Vec<Marshall>, String> {
    let run = args::selected(flags.only.as_deref(), &args::process_lookup)
        .ok_or("a MARSHALL_DISABLE_* variable is not text")?;

    match run.iter().find(|marshall| {
        !matches!(
            marshall,
            Marshall::Author
                | Marshall::Provenance
                | Marshall::S1ngularity
                | Marshall::NewBin
                | Marshall::Metadata
                | Marshall::Downloads
                | Marshall::ArchivedRepo
        )
    }) {
        Some(other) => {
            Err(format!("the {} marshall is Node's (it asks a service this binary does not reproduce)", other.name()))
        }
        None => Ok(run),
    }
}

/// The plan of a run, or the reason it is Node's.
fn answer(args: &[String]) -> Result<Plan, String> {
    let flags = args::parse(args)?;

    if !flags.json {
        return Err("the text report is a pail line with symbols pail's width rule does not cover".to_owned());
    }

    let run = native_marshalls(&flags)?;

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
        registry: None,
    };
    let client = HttpClient::new(fetch_config(HttpConfig::from_env(FETCH_TIMEOUT, FETCH_TIMEOUT), FETCH_TIMEOUT));
    let plan = plan(&flags, &run, &context, &client)?;

    commit(&plan.cache)?;

    Ok(plan)
}

/// The registry `getPackument` asks when it has no workspace root to read an `.npmrc` from.
const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";

/// The packuments as `getPackument` reaches them from a working directory, for the commands outside `inspect` that read
/// a packument: the places, the clock and the client, built once.
pub(crate) struct Packuments {
    context: Context,
    client: HttpClient,
}

impl Packuments {
    /// The registry for a run from `root`, with `limit` as the time one request may take (a command picks the limit
    /// the Node code it replaces gives its own request), or the reason the run is Node's: a proxy, CA or Node option
    /// in the environment, or no usable `HOME`.
    pub(crate) fn new(root: PathBuf, limit: Duration) -> Result<Self, String> {
        if !network_environment_is_plain() {
            return Err("a proxy, CA or Node option is set in the environment".to_owned());
        }

        let cache_dir = vis_cache_dir().ok_or("no cache directory (HOME is not a plain absolute path)")?;
        let home = std::env::var("HOME").map_err(|_| "HOME is not text".to_owned())?;

        Ok(Self::at(
            root,
            PathBuf::from(home),
            cache_dir,
            now_ms()?,
            HttpClient::new(fetch_config(HttpConfig::from_env(limit, limit), limit)),
        ))
    }

    /// [`Packuments::new`] for a run outside a workspace root: Node does not read `.npmrc` there and asks
    /// `https://registry.npmjs.org`, with no credential.
    pub(crate) fn new_default_registry(root: PathBuf, limit: Duration) -> Result<Self, String> {
        let mut packuments = Self::new(root, limit)?;

        packuments.context.registry = Some(DEFAULT_REGISTRY.to_owned());

        Ok(packuments)
    }

    /// The packuments of a run from `root`, with the places, the clock and the client given.
    pub(crate) fn at(root: PathBuf, home: PathBuf, cache_dir: String, now_ms: u64, client: HttpClient) -> Self {
        Self {
            context: Context {
                services: Services::production(),
                root,
                home,
                cache_dir,
                now_ms,
                layout: None,
                registry: None,
            },
            client,
        }
    }

    /// What `getPackument` finds for a package, read through `read` with the view of it (`None` for a package the
    /// registry does not know), and the cache change that goes with the lookup. The reason for a hand-off for a
    /// request that fails and for a packument this module does not read as Node does.
    pub(crate) fn read<T>(
        &self,
        name: &str,
        read: impl FnOnce(Option<&View<'_>>) -> Result<T, String>,
    ) -> Result<(T, Vec<CacheAction>), String> {
        let (found, cache) = packument_of(name, &self.context, &self.client)?;

        match found {
            None => Ok((read(None)?, cache)),
            Some(found) => Ok((read(Some(&View::new(&found)?))?, cache)),
        }
    }

    /// `resolveVersionRange` for a package: its version and the cache change that goes with the lookup. `None` for a
    /// package the registry does not know, or a spec that names no version; the reason for a spec that is a range
    /// (it needs node-semver), a packument this module does not read as Node does, and every failed request.
    pub(crate) fn resolve_version(
        &self,
        name: &str,
        spec: Option<&str>,
    ) -> Result<Option<(String, Vec<CacheAction>)>, String> {
        let (found, cache) = packument_of(name, &self.context, &self.client)?;
        let Some(found) = found else { return Ok(None) };
        let view = View::new(&found)?;
        let Some(version) = resolve(&view, spec)? else { return Ok(None) };

        if args::is_prototype_name(version) || semver_js::Version::parse(version).is_none() {
            return Err(format!("the resolved version {version:?} is not strict semver"));
        }

        Ok(Some((version.to_owned(), cache)))
    }
}

/// What `getPackument` returns for the package: the cut-down document, and the cache change that goes with it.
fn packument_of(name: &str, context: &Context, client: &HttpClient) -> Result<(Option<Js>, Vec<CacheAction>), String> {
    let file = packument::cache_file(&context.cache_dir, name);
    let stale_file = match packument::read_cache(&file, context.now_ms as f64)? {
        Cached::Fresh(found) => return Ok((Some(found), Vec::new())),
        Cached::Fetch { stale_file } => stale_file,
    };
    let registry = match &context.registry {
        Some(registry) => registry.clone(),
        None => npmrc::registry_for(name, &context.home, &context.root)?,
    };
    let base = registry.strip_suffix('/').unwrap_or(&registry);
    let url = format!("{base}/{}", name.replacen('/', "%2f", 1));

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

/// The whole run, up to what it prints: pure but for the packument and download-count caches it reads, the registry and
/// download API requests, and the clock in `context`.
fn plan(flags: &Flags, run: &[Marshall], context: &Context, client: &HttpClient) -> Result<Plan, String> {
    let (found, mut cache) = packument_of(&flags.name, context, client)?;
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
            other => return Err(format!("the {} marshall is not native", other.name())),
        });
    }

    let errors = findings.iter().any(|finding| finding.severity == marshalls::Severity::Error);
    let status = i32::from(errors || (flags.strict && !findings.is_empty()));

    Ok(Plan { stdout: report::json(&findings), stderr: String::new(), status, cache })
}

/// Makes the cache changes of a plan. A change that fails is Node's to report.
pub(crate) fn commit(actions: &[CacheAction]) -> Result<(), String> {
    for action in actions {
        match action {
            CacheAction::Write { file, text } => {
                let directory = file.parent().ok_or("the cache file has no directory")?;

                fs::create_dir_all(directory)
                    .and_then(|()| fs::write(file, text))
                    .map_err(|error| format!("the cache file {} cannot be written: {error}", file.display()))?;
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
        Err(error) => Err(format!("the cache file {} cannot be removed: {error}", file.display())),
    }
}

#[cfg(test)]
pub(crate) mod tests;
