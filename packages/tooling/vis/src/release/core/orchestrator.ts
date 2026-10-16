/**
 * Orchestrator — turns input config into an executed release plan.
 *
 * Used by `releaseVersion()` / `releasePublish()` / `release()` from the
 * programmatic API and by the CLI handlers. Composes:
 *   1. Workspace discovery (via active PM adapter)
 *   2. Change-file reading
 *   3. Branch + channel resolution
 *   4. Release-plan assembly
 *   5. (For version/release) apply-release-plan to disk
 *   6. (For publish/release) per-package versionActions.publish via topo order
 *
 * Pure orchestration — no business logic; that lives in the imported modules.
 */

export { isGemVersionRbPath } from "./ecosystems";
export type { ApplyOptions, ApplyResult, AssertNoConflictingPendingStagesOptions } from "./orchestrator/apply";
export { applyContext, assertNoConflictingPendingStages } from "./orchestrator/apply";
export type { BuildContextOptions, OrchestratorContext } from "./orchestrator/context";
export { buildContext } from "./orchestrator/context";
export { applyReleaseNoteTemplate, composeRelatedReleasesBlock, extractInternalAuthors } from "./orchestrator/notes";
export type { PublishContextOptions, PublishContextResult } from "./orchestrator/publish";
export { publishContext } from "./orchestrator/publish";
