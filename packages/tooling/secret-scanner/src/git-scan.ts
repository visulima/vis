// Git scans — gitleaks `git` mode parity, plus a staged-index scan.
//
// `scan`/`scanFiles`/`scanString` only ever see the working tree. A secret
// that was committed and later removed is invisible to them, yet it still
// lives in the repository's history (and in every clone). `scanGitHistory`
// walks a commit range via git plumbing (`git rev-list` → `git diff-tree` →
// `git cat-file --batch`) and annotates each finding with its commit.
//
// Design notes:
//   - Git runs via `execFile`/`spawn` with array args (no shell). Refs and
//     ranges starting with `-` are rejected so they can't smuggle a flag.
//     Every call overrides output-shaping user config (see git-command.ts).
//   - Each changed blob is scanned in full, so a value added to an existing
//     multi-line structure is still caught (gitleaks #1647). A finding is only
//     reported when the same (rule, secret) is absent from the parent's
//     version of the blob — the old path for a rename, and every parent of a
//     merge — so a long-lived secret is reported once, at the commit that
//     introduced it, not on every later commit touching the file.
//   - Merge commits are diffed against their first parent, so content the
//     merge itself introduced (conflict resolution, evil merges) is scanned.
//   - Blobs are read by object id, which bypasses textconv/smudge filters.
//     Binary (NUL in the first 8 KiB), oversized and missing blobs are skipped
//     and reported in `skipped`; any other git failure throws.

import { resolve } from "node:path";

import type { Native } from "./binding";
import { binding } from "./binding";
import { DEFAULT_MAX_FILE_SIZE } from "./constants";
import type { RawDiffEntry } from "./git-command";
import { assertNotFlag, DIFF_HARDENING_FLAGS, GitBlobReader, gitEnvironment, GITLINK_MODE, isBinaryBlob, NULL_OID, parseRawDiff, runGit } from "./git-command";
import type { CommitAllowlist } from "./git-commit-allowlist";
import { buildCommitAllowlist } from "./git-commit-allowlist";
import { buildIgnoreMatcher, filterIgnoredFiles } from "./ignore-matcher";
import type { ProcessedFindings, SuppressionContext } from "./pipeline";
import { nativeOptionsFor, postProcessDetailed } from "./pipeline";
import type { PreparedScan } from "./prepare-scan";
import { beginScan, finishResult } from "./scan-session";
import type { Finding, GitleaksIgnoreEntry, ScanOptions, SuppressedFinding } from "./types";

/** Raw detection results kept for parent-blob lookups across commits. */
const PARENT_CACHE_LIMIT = 256;

/** Metadata about the commit a historical finding was discovered in. */
export interface GitCommitInfo {
    /** Author email (`%ae`). */
    authorEmail: string;
    /** Author name (`%an`). */
    authorName: string;
    /** Author date, ISO-8601 strict (`%aI`). */
    date: string;
    /** First line of the commit message (`%s`). */
    message: string;
    /** Full 40-char commit SHA. */
    sha: string;
}

/**
 * A {@link Finding} discovered while scanning git history, carrying the commit
 * it originated from. `file` is the blob's path at that commit.
 */
export interface GitFinding extends Finding {
    commit: GitCommitInfo;
}

/** Why a blob was not scanned. */
export type GitSkipReason = "binary" | "missing" | "too-large";

/** A blob the scan could not or did not inspect. */
export interface GitSkippedBlob {
    /** Commit the blob was reached from. Unset for the staged scan. */
    commit?: string;
    /** Path of the blob, relative to the repository root. */
    path: string;
    reason: GitSkipReason;
    /** Blob object id. */
    sha: string;
}

/** Findings plus the blobs that were skipped, so a caller can tell "clean" from "not looked at". */
export interface GitScanResult<F extends Finding = Finding> {
    findings: F[];
    skipped: GitSkippedBlob[];
    /** Suppressed findings; empty unless `reportSuppressed` is on. */
    suppressed: SuppressedFinding<F>[];
    /** `.gitleaksignore` entries that matched no finding in this scan. */
    unusedIgnores: GitleaksIgnoreEntry[];
}

export interface GitScanOptions extends ScanOptions {
    /**
     * Walk every ref (branches, tags, remotes, stash) like `git rev-list --all`
     * instead of only `HEAD`. Unmerged branches are where leaks often sit.
     * Cannot be combined with `range`, `since` or `until`.
     */
    all?: boolean;

    /** Repository working directory. Defaults to `process.cwd()`. */
    cwd?: string;

    /**
     * Cap the number of commits walked (most-recent first). Maps to
     * `git rev-list --max-count`. Unset = no limit.
     */
    maxCommits?: number;

    /**
     * Raw rev-list range/argument (e.g. `"main..feature"`, `"HEAD~10..HEAD"`,
     * or a single ref). Takes precedence over `since`/`until`. When neither
     * `range` nor `since`/`until` is set, the entire reachable history of
     * `HEAD` is scanned.
     */
    range?: string;

    /**
     * Lower bound of the commit range (a ref/SHA), exclusive — git range
     * semantics. Produces `since..until`. Ignored when `range` is set.
     */
    since?: string;

    /**
     * Inclusive upper bound of the commit range (a ref/SHA). Combined with
     * `since` produces `since..until`. Defaults to `HEAD` when only `since`
     * is given. Ignored when `range` is set.
     */
    until?: string;
}

export interface GitStagedScanOptions extends ScanOptions {
    /** Directory inside the repository. Defaults to `process.cwd()`. */
    cwd?: string;
}

interface CommitRecord {
    info: GitCommitInfo;
    parents: string[];
}

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

/**
 * Root of the work tree containing `cwd`. `--show-cdup` rather than
 * `--show-toplevel`: the latter is a realpath (`/private/var/…` on macOS),
 * which would not line up with a caller's symlinked spelling of the same
 * directory.
 */
const repositoryRoot = async (cwd: string, environment?: NodeJS.ProcessEnv): Promise<string> => {
    const cdup = await runGit(["rev-parse", "--show-cdup"], cwd, environment);

    return resolve(cwd, cdup.trim());
};

/**
 * Resolve the rev-list range arguments from the option shape: `--all`, a
 * single range string, or `HEAD` for "all reachable history".
 */
const resolveRevisions = (options: GitScanOptions | undefined): string[] => {
    if (options?.all === true) {
        if (isSet(options.range) || isSet(options.since) || isSet(options.until)) {
            throw new Error("secret-scanner: git `all` walks every ref and cannot be combined with `range`, `since` or `until`.");
        }

        return ["--all"];
    }

    if (isSet(options?.range)) {
        assertNotFlag(options.range, "range");

        return [options.range];
    }

    if (isSet(options?.since)) {
        assertNotFlag(options.since, "since");

        const until = isSet(options.until) ? options.until : "HEAD";

        assertNotFlag(until, "until");

        return [`${options.since}..${until}`];
    }

    if (isSet(options?.until)) {
        assertNotFlag(options.until, "until");

        return [options.until];
    }

    return ["HEAD"];
};

/**
 * Enumerate the commits in range, newest-first, with metadata and parents.
 * Fields are NUL-separated; `%s` is a single line, so records split on LF.
 * An explicit `--format` keeps `format.pretty` and friends out of the parse.
 */
const listCommits = async (options: GitScanOptions | undefined, cwd: string): Promise<CommitRecord[]> => {
    const format = ["%H", "%P", "%an", "%ae", "%aI", "%s"].join("%x00");
    const gitArguments = ["rev-list", "--no-commit-header", `--format=${format}`];

    if (options?.maxCommits !== undefined && Number.isInteger(options.maxCommits) && options.maxCommits > 0) {
        gitArguments.push(`--max-count=${String(options.maxCommits)}`);
    }

    gitArguments.push(...resolveRevisions(options), "--");

    const stdout = await runGit(gitArguments, cwd);
    const commits: CommitRecord[] = [];

    for (const record of stdout.split("\n")) {
        const [sha, parents, authorName, authorEmail, date, message] = record.split("\0");

        if (!isSet(sha)) {
            continue;
        }

        commits.push({
            info: { authorEmail: authorEmail ?? "", authorName: authorName ?? "", date: date ?? "", message: message ?? "", sha },
            parents: (parents ?? "").split(" ").filter((parent) => parent !== ""),
        });
    }

    return commits;
};

/**
 * Blobs added or modified by a commit. Merges and ordinary commits diff
 * against their first parent; root commits (and shallow-clone boundaries,
 * whose parents are unknown) against the empty tree. `-M` reports renames so
 * the parent version is looked up under the old path. Deletions and
 * submodule pointers are dropped.
 */
const listChangedBlobs = async (commit: CommitRecord, cwd: string): Promise<RawDiffEntry[]> => {
    const [firstParent] = commit.parents;
    const target = firstParent === undefined ? ["--root", commit.info.sha] : [firstParent, commit.info.sha];
    const stdout = await runGit(["diff-tree", "-r", "-z", "--raw", "-M", ...DIFF_HARDENING_FLAGS, ...target], cwd);

    return parseRawDiff(stdout).filter((entry) => entry.status !== "D" && entry.newMode !== GITLINK_MODE && !NULL_OID.test(entry.newOid));
};

/** Object id of `path` in `commit`, or `undefined` when it isn't a blob there. */
const blobAt = async (commit: string, path: string, cwd: string): Promise<string | undefined> => {
    const stdout = await runGit(["ls-tree", "-z", commit, "--", path], cwd);
    // `<mode> SP <type> SP <oid> TAB <path>`
    const [meta] = stdout.split("\t");
    const [, type, oid] = (meta ?? "").split(" ");

    return type === "blob" && isSet(oid) ? oid : undefined;
};

const presenceKey = (finding: Finding): string => `${finding.ruleId}\0${finding.secret}`;

const suppressedKey = (finding: Finding): string => `suppressed\0${presenceKey(finding)}`;

/** Keys under which a parent's matches are remembered: suppressed matches are kept apart. */
const parentKeys = (report: ProcessedFindings): Set<string> =>
    new Set([...report.findings.map((finding) => presenceKey(finding)), ...report.suppressed.map((finding) => suppressedKey(finding))]);

/**
 * Drop the matches a parent blob already had. A real finding only counts as
 * present when the parent had it as a real finding too: a secret whose allow
 * comment was removed must be reported. A suppressed one (only returned under
 * `reportSuppressed`) was present either way.
 */
const withoutPresent = (report: ProcessedFindings, parent: ReadonlySet<string>): ProcessedFindings => {
    return {
        findings: report.findings.filter((finding) => !parent.has(presenceKey(finding))),
        suppressed: report.suppressed.filter((finding) => !parent.has(presenceKey(finding)) && !parent.has(suppressedKey(finding))),
    };
};

const isEmpty = (report: ProcessedFindings): boolean => report.findings.length === 0 && report.suppressed.length === 0;

const spanKey = (finding: Finding): string =>
    `${finding.ruleId}\0${String(finding.startLine)}:${String(finding.startColumn)}:${String(finding.endLine)}:${String(finding.endColumn)}`;

/** Shared per-scan state: prepared options, the blob reader and the skip log. */
class BlobScanner {
    public readonly skipped: GitSkippedBlob[] = [];

    readonly #context: SuppressionContext;

    readonly #options: ScanOptions | undefined;

    readonly #prepared: PreparedScan;

    readonly #rawNativeOptions: Native.ScanOptions;

    readonly #reader: GitBlobReader;

    readonly #parentCache = new Map<string, Set<string>>();

    public constructor(cwd: string, options: ScanOptions | undefined, prepared: PreparedScan, context: SuppressionContext) {
        this.#context = context;
        this.#options = options;
        this.#prepared = prepared;
        // Comparisons need real secrets: masked values from two different
        // secrets can be identical (`ghp***xY4`).
        this.#rawNativeOptions = { ...prepared.nativeOptions, redact: false };
        this.#reader = new GitBlobReader(cwd, options?.walk?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE);
    }

    public close(): void {
        this.#reader.close();
    }

    /** Read a blob as text, recording why when it can't be scanned. */
    public async readText(oid: string, path: string, commit: string | undefined, record = true): Promise<string | undefined> {
        const result = await this.#reader.read(oid);
        let reason: GitSkipReason | undefined;

        if (result.kind === "ok") {
            if (!isBinaryBlob(result.content)) {
                return result.content.toString("utf8");
            }

            reason = "binary";
        } else {
            reason = result.kind;
        }

        if (record) {
            this.skipped.push({ commit, path, reason, sha: oid });
        }

        return undefined;
    }

    /**
     * Native detection with real (unredacted) secrets and no post-processing.
     * `commit` lets AND allowlists that list `commits` match.
     */
    public detectRaw(content: string, path: string, commit?: string): ProcessedFindings {
        return binding.scanTextSync(content, path, { ...this.#rawNativeOptions, commit });
    }

    /** Rule and secret pairs present in an earlier version of a blob. */
    public async presentIn(oid: string, path: string): Promise<Set<string>> {
        const cacheKey = `${oid}\0${path}`;
        const cached = this.#parentCache.get(cacheKey);

        if (cached !== undefined) {
            return cached;
        }

        const content = await this.readText(oid, path, undefined, false);
        const keys = content === undefined || content === "" ? new Set<string>() : parentKeys(this.detectRaw(content, path));

        this.#remember(cacheKey, keys);

        return keys;
    }

    /**
     * Run the user-facing pipeline over the selected raw findings. Under
     * `redact`, the native scan is repeated with masking on and the same spans
     * are kept, so masking stays the native layer's job. `commit` is attached
     * before suppression so commit-scoped `.gitleaksignore` entries can match.
     */
    public async finish(content: string, path: string, selected: ProcessedFindings, commit?: GitCommitInfo): Promise<ProcessedFindings> {
        let report = selected;
        const nativeOptions = nativeOptionsFor(this.#prepared, this.#context);

        if (nativeOptions.redact === true) {
            const keep = new Set([...selected.findings, ...selected.suppressed].map((finding) => spanKey(finding)));
            const redacted = binding.scanTextSync(content, path, { ...nativeOptions, commit: commit?.sha });

            report = {
                findings: redacted.findings.filter((finding) => keep.has(spanKey(finding))),
                suppressed: redacted.suppressed.filter((finding) => keep.has(spanKey(finding))),
            };
        }

        if (commit !== undefined) {
            report = {
                findings: report.findings.map((finding) => {
                    return { ...finding, commit };
                }),
                suppressed: report.suppressed.map((finding) => {
                    return { ...finding, commit };
                }),
            };
        }

        return postProcessDetailed(report, this.#prepared, this.#options, this.#context);
    }

    #remember(cacheKey: string, keys: Set<string>): void {
        if (this.#parentCache.size >= PARENT_CACHE_LIMIT) {
            const oldest = this.#parentCache.keys().next().value;

            if (oldest !== undefined) {
                this.#parentCache.delete(oldest);
            }
        }

        this.#parentCache.set(cacheKey, keys);
    }
}

/** Scan one changed blob of `commit`, reporting only what its parents didn't already contain. */
const scanChangedBlob = async (
    entry: RawDiffEntry,
    commit: CommitRecord,
    scanner: BlobScanner,
    allowlist: CommitAllowlist,
    cwd: string,
    reportSuppressed: boolean,
): Promise<{ findings: GitFinding[]; suppressed: SuppressedFinding<GitFinding>[] }> => {
    const path = entry.newPath;
    const content = await scanner.readText(entry.newOid, path, commit.info.sha);
    const none = { findings: [], suppressed: [] };

    if (content === undefined || content === "") {
        return none;
    }

    let fresh = scanner.detectRaw(content, path, commit.info.sha);

    if (isEmpty(fresh)) {
        return none;
    }

    const [firstParent, ...otherParents] = commit.parents;

    if (firstParent !== undefined && !NULL_OID.test(entry.oldOid) && (entry.status === "M" || entry.status === "R" || entry.status === "T")) {
        const before = await scanner.presentIn(entry.oldOid, entry.oldPath);

        fresh = withoutPresent(fresh, before);
    }

    // A merge only introduces what none of its parents had.
    for (const parent of otherParents) {
        if (isEmpty(fresh)) {
            break;
        }

        // eslint-disable-next-line no-await-in-loop -- One parent at a time; merges rarely have more than two.
        const oid = await blobAt(parent, path, cwd);

        if (oid !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- Same: sequential reads through the single cat-file process.
            const before = await scanner.presentIn(oid, path);

            fresh = withoutPresent(fresh, before);
        }
    }

    if (isEmpty(fresh)) {
        return none;
    }

    const processed = await scanner.finish(content, path, fresh, commit.info);
    const findings: GitFinding[] = [];
    const suppressed = processed.suppressed as SuppressedFinding<GitFinding>[];

    for (const finding of processed.findings as GitFinding[]) {
        if (!allowlist.isFindingAllowed(finding.ruleId, commit.info.sha)) {
            findings.push(finding);
        } else if (reportSuppressed) {
            suppressed.push({ ...finding, suppressedBy: "allowlist" });
        }
    }

    return { findings, suppressed };
};

/**
 * Like {@link scanGitHistory}, but also returns the blobs that were skipped
 * (binary, larger than `walk.maxFileSize`, or missing from the object store)
 * so a caller can tell a clean history from one that wasn't fully read.
 * @throws if `git` is not on PATH, `cwd` is not a git repository, or git fails
 * to read an object that exists (corruption, permissions).
 */
export const scanGitHistoryDetailed = async (options?: GitScanOptions): Promise<GitScanResult<GitFinding>> => {
    const cwd = options?.cwd ?? process.cwd();
    // History paths are repository-relative, whatever subdirectory `cwd` is.
    const { context, prepared } = await beginScan(options, [await repositoryRoot(cwd)]);
    const allowlist = buildCommitAllowlist(prepared.config);
    const commits = await listCommits(options, cwd);
    const scanner = new BlobScanner(cwd, options, prepared, context);
    const findings: GitFinding[] = [];
    const suppressed: SuppressedFinding<GitFinding>[] = [];
    const reportSuppressed = options?.reportSuppressed === true;

    try {
        for (const commit of commits) {
            if (allowlist.isCommitSkipped(commit.info.sha)) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- Sequential by design: git plumbing is the bottleneck and serialising keeps memory bounded over long histories.
            const entries = await listChangedBlobs(commit, cwd);

            for (const entry of entries) {
                // eslint-disable-next-line no-await-in-loop -- One blob at a time through the shared cat-file process.
                const result = await scanChangedBlob(entry, commit, scanner, allowlist, cwd, reportSuppressed);

                findings.push(...result.findings);
                suppressed.push(...result.suppressed);
            }
        }
    } finally {
        scanner.close();
    }

    return finishResult({ findings, suppressed }, scanner.skipped, context, { includeCommitEntries: true });
};

/**
 * Scan a range of git history for secrets. Walks each commit, runs the secret
 * detector over every added/modified blob at that commit, and returns the
 * findings annotated with the commit that introduced them. A secret that
 * survives later edits to its file is reported once, not once per commit.
 *
 * With no range options the **entire reachable history of `HEAD`** is scanned —
 * use `all`, `range`, `since`/`until`, or `maxCommits` to change it. The
 * existing `ScanOptions` (rules, heuristics, baseline, redact, validate) all
 * apply per blob via the shared post-process pipeline, and
 * `allowlists[].commits` from the config is honoured.
 *
 * Skipped blobs are not reported here; use {@link scanGitHistoryDetailed}.
 * @throws if `git` is not on PATH, `cwd` is not a git repository, or git fails
 * to read an object that exists (corruption, permissions).
 */
export const scanGitHistory = async (options?: GitScanOptions): Promise<GitFinding[]> => {
    const result = await scanGitHistoryDetailed(options);

    return result.findings;
};

/**
 * Scan the content staged in the git index — what the next commit will
 * contain — rather than the working-tree files. Unstaged edits are ignored
 * and a staged secret is found even after it was removed from the working
 * tree. Inside a `pre-commit` hook, the index git hands the hook
 * (`GIT_INDEX_FILE`) is the one read.
 *
 * Findings carry the absolute path of the file in the working tree, the same
 * shape `scanFiles` reports. `walk.excludePatterns` /
 * `walk.excludeFromFiles` apply as they do for `scanFiles`, relative to `cwd`.
 * @throws if `git` is not on PATH, `cwd` is not inside a git work tree, or git
 * fails to read an object that exists.
 */
export const scanGitStaged = async (options?: GitStagedScanOptions): Promise<GitScanResult> => {
    const cwd = options?.cwd ?? process.cwd();
    const environment = gitEnvironment(true);
    const toplevel = await repositoryRoot(cwd, environment);
    const { context, prepared } = await beginScan(options, [toplevel, cwd]);
    const diff = await runGit(["diff", "--cached", "-z", "--raw", "--no-renames", "--diff-filter=ACMT", ...DIFF_HARDENING_FLAGS], toplevel, environment);
    const entries = parseRawDiff(diff).filter((entry) => entry.newMode !== GITLINK_MODE && !NULL_OID.test(entry.newOid));
    const absolute = (path: string): string => resolve(toplevel, path);
    const kept = new Set(
        filterIgnoredFiles(
            entries.map((entry) => absolute(entry.newPath)),
            buildIgnoreMatcher(options),
            cwd,
        ),
    );
    const scanner = new BlobScanner(toplevel, options, prepared, context);
    const findings: Finding[] = [];
    const suppressed: SuppressedFinding[] = [];

    try {
        for (const entry of entries) {
            const file = absolute(entry.newPath);

            if (!kept.has(file)) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- One blob at a time through the shared cat-file process.
            const content = await scanner.readText(entry.newOid, entry.newPath, undefined);

            if (content === undefined || content === "") {
                continue;
            }

            const raw = scanner.detectRaw(content, file);

            if (!isEmpty(raw)) {
                // eslint-disable-next-line no-await-in-loop -- The pipeline may await validators; blobs are processed serially.
                const processed = await scanner.finish(content, file, raw);

                findings.push(...processed.findings);
                suppressed.push(...processed.suppressed);
            }
        }
    } finally {
        scanner.close();
    }

    return finishResult({ findings, suppressed }, scanner.skipped, context);
};
