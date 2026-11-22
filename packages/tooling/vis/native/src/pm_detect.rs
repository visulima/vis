//! Package-manager detection for the NAPI addon.
//!
//! The detection logic lives in `vis_core::detect` (plain Rust, shared with the
//! standalone `vis` CLI binary). This module only declares the JS-visible
//! objects and converts to and from the core types.

use napi_derive::napi;
use vis_core::detect as core;

#[napi(object, object_from_js = false)]
pub struct DetectedPackageManager {
    /// The package manager name: "pnpm", "npm", "yarn", or "bun"
    pub name: String,
    /// The version string from packageManager field, or None if unknown
    pub version: Option<String>,
    /// Build metadata (sha256 hash) appended to packageManager field by
    /// corepack. `parts[1].split('+').next()` strips it from `version`;
    /// this field preserves it for callers that want to verify the pin.
    pub build_meta: Option<String>,
    /// Whether this is a monorepo/workspace
    pub is_workspace: bool,
}

impl From<core::DetectedPackageManager> for DetectedPackageManager {
    fn from(detected: core::DetectedPackageManager) -> Self {
        let core::DetectedPackageManager { name, version, build_meta, is_workspace } = detected;
        Self { name, version, build_meta, is_workspace }
    }
}

/// Options controlling which detection sources to consult.
///
/// Matches nypm's `detectPackageManager` opts. All flags are
/// `Option<bool>` so callers can omit them; `None` is treated as the
/// default (use the source). Mirrors the JS-side ergonomics where
/// `{}` enables every source.
#[napi(object)]
#[derive(Default)]
pub struct DetectPackageManagerOptions {
    /// Skip reading the `packageManager` field in package.json.
    pub ignore_package_json: Option<bool>,
    /// Skip lockfile walk (pnpm-lock.yaml, yarn.lock, …).
    pub ignore_lock_file: Option<bool>,
    /// Skip the `npm_config_user_agent` env-var fallback. Set by every
    /// PM when running scripts; lets a tool spawned from `pnpm run x`
    /// know it's pnpm even without a lockfile.
    pub ignore_argv: Option<bool>,
}

impl From<DetectPackageManagerOptions> for core::DetectPackageManagerOptions {
    fn from(options: DetectPackageManagerOptions) -> Self {
        Self {
            ignore_package_json: options.ignore_package_json,
            ignore_lock_file: options.ignore_lock_file,
            ignore_argv: options.ignore_argv,
            backend: None,
        }
    }
}

/// Detects the package manager for the project at the given path.
/// Priority: packageManager field > lockfiles > config files >
/// `npm_config_user_agent` env var > default (pnpm).
///
/// `opts` lets callers skip individual sources. `None` opts default
/// to "use the source".
///
/// Returns `napi::Result` so any I/O errors surface as JS exceptions.
#[napi(catch_unwind)]
pub fn detect_package_manager(
    cwd: String,
    opts: Option<DetectPackageManagerOptions>,
) -> napi::Result<DetectedPackageManager> {
    Ok(core::detect_package_manager(&cwd, opts.map(Into::into)).into())
}
