//! Package-manager command resolution for the NAPI addon.
//!
//! The resolution logic lives in `vis_core::resolve` (plain Rust, shared with the
//! standalone `vis` CLI binary). This module only declares the JS-visible
//! option/result objects, converts them to the core types, and maps the core
//! `ResolveError` onto an `InvalidArg` napi error.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use vis_core::resolve as core;

#[napi(object, object_from_js = false)]
pub struct ResolvedCommand {
    pub bin: String,
    pub args: Vec<String>,
    pub warnings: Vec<String>,
}

impl From<core::ResolvedCommand> for ResolvedCommand {
    fn from(resolved: core::ResolvedCommand) -> Self {
        Self { bin: resolved.bin, args: resolved.args, warnings: resolved.warnings }
    }
}

/// A core error is a refused request (an unsupported manager, or a flag the manager cannot honour), so JS sees
/// its message as an invalid argument.
fn invalid_arg(error: core::ResolveError) -> Error {
    Error::new(Status::InvalidArg, error.to_string())
}

#[napi(object)]
pub struct InstallOptions {
    pub frozen_lockfile: bool,
    pub prod: bool,
    pub dev: bool,
    pub no_optional: bool,
    pub force: bool,
    pub ignore_scripts: bool,
    pub lockfile_only: bool,
    pub offline: bool,
    pub silent: bool,
    pub recursive: bool,
    pub workspace_root: bool,
    pub filter: Vec<String>,
}

impl From<InstallOptions> for core::InstallOptions {
    fn from(options: InstallOptions) -> Self {
        Self {
            frozen_lockfile: options.frozen_lockfile,
            prod: options.prod,
            dev: options.dev,
            no_optional: options.no_optional,
            force: options.force,
            ignore_scripts: options.ignore_scripts,
            lockfile_only: options.lockfile_only,
            offline: options.offline,
            silent: options.silent,
            recursive: options.recursive,
            workspace_root: options.workspace_root,
            filter: options.filter,
        }
    }
}

#[napi(catch_unwind)]
pub fn resolve_install(pm: String, version: String, opts: InstallOptions) -> napi::Result<ResolvedCommand> {
    core::resolve_install(&pm, &version, opts.into()).map(Into::into).map_err(invalid_arg)
}

#[napi(object)]
pub struct AddOptions {
    pub packages: Vec<String>,
    pub save_dev: bool,
    pub exact: bool,
    pub peer: bool,
    pub optional: bool,
    pub global: bool,
    pub workspace: bool,
    pub workspace_root: bool,
    pub filter: Vec<String>,
}

impl From<AddOptions> for core::AddOptions {
    fn from(options: AddOptions) -> Self {
        Self {
            packages: options.packages,
            save_dev: options.save_dev,
            exact: options.exact,
            peer: options.peer,
            optional: options.optional,
            global: options.global,
            workspace: options.workspace,
            workspace_root: options.workspace_root,
            filter: options.filter,
        }
    }
}

#[napi(catch_unwind)]
pub fn resolve_add(pm: String, version: String, opts: AddOptions) -> napi::Result<ResolvedCommand> {
    core::resolve_add(&pm, &version, opts.into()).map(Into::into).map_err(invalid_arg)
}

#[napi(object)]
pub struct RemoveOptions {
    pub packages: Vec<String>,
    pub save_dev: bool,
    pub global: bool,
    pub recursive: bool,
    pub workspace_root: bool,
    pub filter: Vec<String>,
}

impl From<RemoveOptions> for core::RemoveOptions {
    fn from(options: RemoveOptions) -> Self {
        Self {
            packages: options.packages,
            save_dev: options.save_dev,
            global: options.global,
            recursive: options.recursive,
            workspace_root: options.workspace_root,
            filter: options.filter,
        }
    }
}

#[napi(catch_unwind)]
pub fn resolve_remove(pm: String, version: String, opts: RemoveOptions) -> napi::Result<ResolvedCommand> {
    core::resolve_remove(&pm, &version, opts.into()).map(Into::into).map_err(invalid_arg)
}

#[napi(catch_unwind)]
pub fn resolve_dedupe(pm: String, version: String, check: bool) -> napi::Result<ResolvedCommand> {
    core::resolve_dedupe(&pm, &version, check).map(Into::into).map_err(invalid_arg)
}

#[napi(object)]
pub struct WhyOptions {
    pub packages: Vec<String>,
    pub json: bool,
    pub long: bool,
    pub parseable: bool,
    pub recursive: bool,
    pub dev: bool,
    pub prod: bool,
    pub no_optional: bool,
    pub global: bool,
    /// Depth limit. Uses Option<i32> directly (napi supports it).
    pub depth: Option<i32>,
    pub filter: Vec<String>,
}

impl From<WhyOptions> for core::WhyOptions {
    fn from(options: WhyOptions) -> Self {
        Self {
            packages: options.packages,
            json: options.json,
            long: options.long,
            parseable: options.parseable,
            recursive: options.recursive,
            dev: options.dev,
            prod: options.prod,
            no_optional: options.no_optional,
            global: options.global,
            depth: options.depth,
            filter: options.filter,
        }
    }
}

#[napi(catch_unwind)]
pub fn resolve_why(pm: String, version: String, opts: WhyOptions) -> napi::Result<ResolvedCommand> {
    core::resolve_why(&pm, &version, opts.into()).map(Into::into).map_err(invalid_arg)
}

#[napi(object)]
pub struct OutdatedOptions {
    pub packages: Vec<String>,
    pub long: bool,
    pub format: String,
    pub recursive: bool,
    pub filter: Vec<String>,
    pub workspace_root: bool,
    pub prod: bool,
    pub dev: bool,
    pub no_optional: bool,
    pub compatible: bool,
    pub global: bool,
}

impl From<OutdatedOptions> for core::OutdatedOptions {
    fn from(options: OutdatedOptions) -> Self {
        Self {
            packages: options.packages,
            long: options.long,
            format: core::OutdatedFormat::parse(&options.format),
            recursive: options.recursive,
            filter: options.filter,
            workspace_root: options.workspace_root,
            prod: options.prod,
            dev: options.dev,
            no_optional: options.no_optional,
            compatible: options.compatible,
            global: options.global,
        }
    }
}

#[napi(catch_unwind)]
pub fn resolve_link(pm: String, version: String, target: Option<String>) -> napi::Result<ResolvedCommand> {
    core::resolve_link(&pm, &version, target).map(Into::into).map_err(invalid_arg)
}

#[napi(catch_unwind)]
pub fn resolve_unlink(
    pm: String,
    version: String,
    packages: Vec<String>,
    recursive: bool,
) -> napi::Result<ResolvedCommand> {
    core::resolve_unlink(&pm, &version, packages, recursive).map(Into::into).map_err(invalid_arg)
}

#[napi(object)]
pub struct DlxOptions {
    pub package: String,
    pub args: Vec<String>,
    pub additional_packages: Vec<String>,
    pub shell_mode: bool,
    pub silent: bool,
}

impl From<DlxOptions> for core::DlxOptions {
    fn from(options: DlxOptions) -> Self {
        Self {
            package: options.package,
            args: options.args,
            additional_packages: options.additional_packages,
            shell_mode: options.shell_mode,
            silent: options.silent,
        }
    }
}

#[napi(catch_unwind)]
pub fn resolve_dlx(pm: String, version: String, opts: DlxOptions) -> napi::Result<ResolvedCommand> {
    core::resolve_dlx(&pm, &version, opts.into()).map(Into::into).map_err(invalid_arg)
}

#[napi(object)]
pub struct ExecOptions {
    pub command: String,
    pub args: Vec<String>,
    pub shell_mode: bool,
    pub recursive: bool,
    pub workspace_root: bool,
    pub parallel: bool,
    pub reverse: bool,
    pub filter: Vec<String>,
}

impl From<ExecOptions> for core::ExecOptions {
    fn from(options: ExecOptions) -> Self {
        Self {
            command: options.command,
            args: options.args,
            shell_mode: options.shell_mode,
            recursive: options.recursive,
            workspace_root: options.workspace_root,
            parallel: options.parallel,
            reverse: options.reverse,
            filter: options.filter,
        }
    }
}

#[napi(catch_unwind)]
pub fn resolve_exec(pm: String, version: String, opts: ExecOptions) -> napi::Result<ResolvedCommand> {
    core::resolve_exec(&pm, &version, opts.into()).map(Into::into).map_err(invalid_arg)
}

#[napi(catch_unwind)]
pub fn resolve_pm_command(
    pm: String,
    version: String,
    subcommand: String,
    extra_args: Vec<String>,
) -> napi::Result<ResolvedCommand> {
    core::resolve_pm_command(&pm, &version, &subcommand, extra_args).map(Into::into).map_err(invalid_arg)
}
