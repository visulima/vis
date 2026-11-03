// `.gitleaksignore` support — read at scan time, not only by `vis migrate`.
//
// Accepted lines (one per line, `#` comments and blank lines skipped):
//   file:rule:line                      gitleaks fingerprint (working tree)
//   commit:file:rule:line               gitleaks fingerprint (git history)
//   secret:<value>                      exact secret value (gitleaks #2101)
//   rule:<id>:secret:<value>            … scoped to a rule
//   path:<file>:secret:<value>          … scoped to a file
//   path:<file>:rule:<id>:secret:<value>
//
// `*` in any component matches any run of characters (gitleaks #1870), so
// `src/gen/*:generic-api-key:*` survives regenerated line numbers.
//
// Paths are matched relative to the directory holding the ignore file, however
// the scan root was spelled (gitleaks #2248): a finding's path is resolved to
// an absolute real path first, then made relative to that directory.

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type { Finding, GitleaksIgnoreEntry } from "./types";

type Matcher = (value: string) => boolean;

interface FingerprintRule {
    commit?: Matcher;
    entry: GitleaksIgnoreEntry;
    file: Matcher;
    line: Matcher;
    rule: Matcher;
}

interface SecretRule {
    entry: GitleaksIgnoreEntry;
    path?: Matcher;
    rule?: Matcher;
    secret: string;
}

/** A finding that may carry the commit it came from (git history scans). */
type MaybeGitFinding = Finding & { commit?: { sha: string } };

const COMMIT_RE = /^[\da-f]{7,40}$/i;
const LINE_RE = /^\d+$/;
const NEWLINE_RE = /\r?\n/;

const escapeRegExp = (value: string): string => value.replaceAll(/[$()+.?[\\\]^{|}]/g, String.raw`\$&`);

const compileComponent = (pattern: string): Matcher => {
    if (pattern === "*") {
        return () => true;
    }

    if (!pattern.includes("*")) {
        return (value) => value === pattern;
    }

    const regex = new RegExp(
        `^${pattern
            .split("*")
            .map((part) => escapeRegExp(part))
            .join(".*")}$`,
        "s",
    );

    return (value) => regex.test(value);
};

const normalizePath = (path: string): string => {
    const forward = path.replaceAll("\\", "/");

    return forward.startsWith("./") ? forward.slice(2) : forward;
};

const realOrSelf = (path: string): string => {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
};

/** Parse a secret-value entry, or `undefined` when the line isn't one. */
const parseSecretEntry = (raw: string, entry: GitleaksIgnoreEntry): SecretRule | undefined => {
    let rest = raw;
    let path: string | undefined;
    let rule: string | undefined;

    if (rest.startsWith("path:")) {
        const scoped = rest.slice("path:".length);
        const ruleAt = scoped.lastIndexOf(":rule:");
        const secretAt = scoped.indexOf(":secret:");
        const cut = ruleAt !== -1 && (secretAt === -1 || ruleAt < secretAt) ? ruleAt : secretAt;

        if (cut === -1) {
            return undefined;
        }

        path = scoped.slice(0, cut);
        rest = scoped.slice(cut + 1);
    }

    if (rest.startsWith("rule:")) {
        const secretAt = rest.indexOf(":secret:");

        if (secretAt === -1) {
            return undefined;
        }

        rule = rest.slice("rule:".length, secretAt);
        rest = rest.slice(secretAt + 1);
    }

    if (!rest.startsWith("secret:")) {
        return undefined;
    }

    const secret = rest.slice("secret:".length);

    if (secret === "" || path === "" || rule === "") {
        return undefined;
    }

    return {
        entry: { ...entry, kind: "secret" },
        path: path === undefined ? undefined : compileComponent(normalizePath(path)),
        rule: rule === undefined ? undefined : compileComponent(rule),
        secret,
    };
};

/** Parse a fingerprint, reading from the right: paths may contain `:`. */
const parseFingerprint = (raw: string, entry: GitleaksIgnoreEntry): FingerprintRule | undefined => {
    const parts = raw.split(":");

    if (parts.length < 3) {
        return undefined;
    }

    const line = parts.at(-1) as string;
    const rule = parts.at(-2) as string;

    if (rule === "" || (line !== "*" && !LINE_RE.test(line))) {
        return undefined;
    }

    let head = parts.slice(0, -2);
    let commit: string | undefined;

    if (head.length >= 2 && (COMMIT_RE.test(head[0] as string) || head[0] === "*")) {
        commit = (head[0] as string).toLowerCase();
        head = head.slice(1);
    }

    const file = head.join(":");

    if (file === "") {
        return undefined;
    }

    let commitMatcher: Matcher | undefined;

    if (commit === "*") {
        commitMatcher = () => true;
    } else if (commit !== undefined) {
        commitMatcher = (sha) => sha.toLowerCase().startsWith(commit);
    }

    return {
        commit: commitMatcher,
        entry,
        file: compileComponent(normalizePath(file)),
        line: compileComponent(line),
        rule: compileComponent(rule),
    };
};

/**
 * A loaded `.gitleaksignore`. Create one per scan: it records which entries
 * matched so {@link GitleaksIgnore.unused} can report stale ones.
 */
export class GitleaksIgnore {
    /** Read and parse `path`. Throws when the file can't be read. */
    public static load(path: string): GitleaksIgnore {
        const absolute = resolve(path);

        return new GitleaksIgnore(readFileSync(absolute, "utf8"), dirname(absolute), basename(absolute));
    }

    /** Entries that could not be parsed. */
    public readonly invalid: GitleaksIgnoreEntry[] = [];

    /** Directory the paths in the file are relative to. */
    public readonly root: string;

    /** The ignore file's own name, relative to {@link GitleaksIgnore.root}. */
    readonly #fileName: string;

    readonly #fingerprints: FingerprintRule[] = [];

    readonly #secrets: SecretRule[] = [];

    readonly #used = new Set<GitleaksIgnoreEntry>();

    public constructor(content: string, root: string, fileName = ".gitleaksignore") {
        this.root = realOrSelf(root);
        this.#fileName = fileName;

        for (const [index, text] of content.split(NEWLINE_RE).entries()) {
            const raw = text.trim();

            if (raw === "" || raw.startsWith("#")) {
                continue;
            }

            const entry: GitleaksIgnoreEntry = { kind: "fingerprint", line: index + 1, raw };
            const isSecretForm = raw.startsWith("secret:") || raw.startsWith("rule:") || raw.startsWith("path:");
            const secretRule = isSecretForm ? parseSecretEntry(raw, entry) : undefined;

            if (secretRule !== undefined) {
                this.#secrets.push(secretRule);

                continue;
            }

            const fingerprintRule = parseFingerprint(raw, entry);

            if (fingerprintRule === undefined) {
                this.invalid.push(entry);
            } else {
                this.#fingerprints.push(fingerprintRule);
            }
        }
    }

    /**
     * Return the first entry matching `finding`, marking **every** matching
     * entry as used. `bases` are the directories a relative `finding.file` may
     * be relative to (scan roots, the cwd, the repository root).
     */
    public match(finding: MaybeGitFinding, bases: ReadonlyArray<string>): GitleaksIgnoreEntry | undefined {
        const paths = this.#candidatePaths(finding.file, bases);
        const line = String(finding.startLine);
        const sha = finding.commit?.sha;
        let first: GitleaksIgnoreEntry | undefined;
        const hit = (entry: GitleaksIgnoreEntry): void => {
            this.#used.add(entry);
            first ??= entry;
        };

        for (const rule of this.#fingerprints) {
            if (rule.commit !== undefined && (sha === undefined || !rule.commit(sha))) {
                continue;
            }

            if (rule.rule(finding.ruleId) && rule.line(line) && paths.some((path) => rule.file(path))) {
                hit(rule.entry);
            }
        }

        for (const rule of this.#secrets) {
            const { path: pathMatcher, rule: ruleMatcher } = rule;
            const ruleOk = ruleMatcher === undefined || ruleMatcher(finding.ruleId);
            const pathOk = pathMatcher === undefined || paths.some((path) => pathMatcher(path));

            if (finding.secret === rule.secret && ruleOk && pathOk) {
                hit(rule.entry);
            }
        }

        return first;
    }

    /**
     * True when `finding` sits in the ignore file itself. A scoped secret entry
     * (`path:…:secret:&lt;value>`) holds the real secret, so without this the
     * ignore file would be reported on every staged or history scan.
     */
    public isIgnoreFile(finding: Finding, bases: ReadonlyArray<string>): boolean {
        return this.#candidatePaths(finding.file, bases).includes(this.#fileName);
    }

    /**
     * Entries that matched nothing so far. Commit-scoped fingerprints are only
     * meaningful for git history scans; leave `includeCommitEntries` off for
     * working-tree scans so they aren't reported as stale.
     */
    public unused({ includeCommitEntries = false }: { includeCommitEntries?: boolean } = {}): GitleaksIgnoreEntry[] {
        const unused = [
            ...this.#fingerprints.filter((rule) => includeCommitEntries || rule.commit === undefined).map((rule) => rule.entry),
            ...this.#secrets.map((rule) => rule.entry),
        ].filter((entry) => !this.#used.has(entry));

        return unused.toSorted((a, b) => a.line - b.line);
    }

    #candidatePaths(file: string, bases: ReadonlyArray<string>): string[] {
        const candidates = new Set<string>();

        if (!isAbsolute(file)) {
            candidates.add(normalizePath(file));
        }

        const absolutes = isAbsolute(file) ? [file] : bases.map((base) => resolve(realOrSelf(base), file));

        for (const absolute of absolutes) {
            const relativePath = relative(this.root, realOrSelf(absolute));

            if (relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
                candidates.add(normalizePath(relativePath));
            }
        }

        return [...candidates];
    }
}
