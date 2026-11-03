// Limits and enumerations shared with the native layer and with callers.

/** Rule confidence levels, lowest first: the order `minConfidence` floors compare in. */
export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

/** Default per-file (and per-blob) size cap in bytes, matching the native walker: 10 MiB. */
export const DEFAULT_MAX_FILE_SIZE: number = 10 * 1024 * 1024;

/** Deepest archive nesting the native layer opens; larger `maxArchiveDepth` values are clamped to it. */
export const MAX_ARCHIVE_DEPTH = 8;
