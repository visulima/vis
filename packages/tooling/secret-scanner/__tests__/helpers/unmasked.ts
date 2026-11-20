// Scan entry points that reveal secret values (`redact: false`), for tests that
// assert on the real `match` / `secret`. Masking is covered by redact-masking.test.ts.

import type { GitFinding, GitScanOptions, GitScanResult, GitStagedScanOptions } from "../../src/git-scan";
import {
    scanGitHistory as scanGitHistoryMasked,
    scanGitHistoryDetailed as scanGitHistoryDetailedMasked,
    scanGitStaged as scanGitStagedMasked,
} from "../../src/git-scan";
import {
    scan as scanMasked,
    scanDetailed as scanDetailedMasked,
    scanFiles as scanFilesMasked,
    scanFilesDetailed as scanFilesDetailedMasked,
    scanString as scanStringMasked,
} from "../../src/index";
import type { Finding, ScanOptions, ScanResult } from "../../src/types";

export const scan = (paths: string[], options?: ScanOptions): Promise<Finding[]> => scanMasked(paths, { redact: false, ...options });
export const scanDetailed = (paths: string[], options?: ScanOptions): Promise<ScanResult> => scanDetailedMasked(paths, { redact: false, ...options });
export const scanFiles = (files: string[], options?: ScanOptions): Promise<Finding[]> => scanFilesMasked(files, { redact: false, ...options });
export const scanFilesDetailed = (files: string[], options?: ScanOptions): Promise<ScanResult> => scanFilesDetailedMasked(files, { redact: false, ...options });
export const scanString = (content: string, file: string, options?: ScanOptions): Promise<Finding[]> =>
    scanStringMasked(content, file, { redact: false, ...options });
export const scanGitHistory = (options?: GitScanOptions): Promise<GitFinding[]> => scanGitHistoryMasked({ redact: false, ...options });
export const scanGitHistoryDetailed = (options?: GitScanOptions): Promise<GitScanResult<GitFinding>> =>
    scanGitHistoryDetailedMasked({ redact: false, ...options });
export const scanGitStaged = (options?: GitStagedScanOptions): Promise<GitScanResult> => scanGitStagedMasked({ redact: false, ...options });
