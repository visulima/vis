import type { VisReleaseConfig } from "../../types";
import { expandReleaseNoteTemplate } from "../release-note-template";

/**
 * Compose the "Related releases" Markdown block from a list of previous
 * forge releases. Exported for unit testing — the orchestrator inlines
 * the same logic inside `createRemoteReleases`. Returns an empty string
 * when `recent` is empty so callers can append/prepend unconditionally.
 */
export const composeRelatedReleasesBlock = (recent: ReadonlyArray<{ name: string; tag: string; url: string }>): string => {
    if (recent.length === 0) {
        return "";
    }

    const lines = recent.map((entry) => `- [${entry.name}](${entry.url})`);

    return `## Related releases\n\n${lines.join("\n")}`;
};

/**
 * Wrap a per-package release body with operator-supplied header / footer
 * text (release-please #1274 parity). Tokens supported in both fields:
 *   - `{name}` — package name
 *   - `{version}` — new version
 *   - `{previousVersion}` — previous version
 *   - `{date}` — `YYYY-MM-DD` of the release wave
 *   - `{repo}` — `owner/repo` slug
 *   - `{contributors}` — bullet-list of authors collected from the
 *     entire wave's change-file `author:` frontmatter (release-please
 *     #292). Wave-scoped — every per-package release sees the same set,
 *     so cascade / dependency-only bumps still credit the upstream
 *     author. Empty string when no change file in the wave declared an
 *     author. Block-only; keep on its own line.
 *
 * Header / footer parts are dropped entirely if they interpolate to
 * whitespace-only (e.g. a header of `"{contributors}"` when the wave
 * has no `author:` frontmatter), so the rendered body never gains
 * leading or trailing blank lines from a missing token. Trailing
 * whitespace inside a kept part (e.g. `"## Contributors\n\n"` when
 * `{contributors}` is empty) is stripped to avoid stacked blank lines.
 *
 * Not invoked in aggregate-release mode — that path builds its own
 * body and exposes `aggregateRelease.title` for templating instead.
 *
 * Exported for unit testing.
 */
export const applyReleaseNoteTemplate = (
    body: string,
    template: { footer?: string; header?: string } | undefined,
    tokens: { contributors?: string; date: string; name: string; previousVersion: string; repo: string; version: string },
): string => {
    if (!template || (!template.header && !template.footer)) {
        return body;
    }

    // F20 fix (audit): replaced the sequential `.replaceAll()` chain
    // with a single-pass token interpolation via
    // `expandReleaseNoteTemplate`. The new helper resolves each match
    // against the token table independently, so a token's substituted
    // value can never be re-interpolated by a later pass — eliminates
    // the latent footgun where a future token value containing another
    // token literal would have been re-substituted.
    const interpolate = (text: string): string => {
        const raw = expandReleaseNoteTemplate(text, {
            contributors: tokens.contributors ?? "",
            date: tokens.date,
            name: tokens.name,
            previousVersion: tokens.previousVersion,
            repo: tokens.repo,
            version: tokens.version,
        });

        // Collapse 3+ consecutive newlines (left behind when an empty
        // token sat between two `\n`s in the operator template) and
        // strip trailing whitespace — the `\n\n` part-joiner below
        // re-introduces the separator. Without this, an all-empty
        // header re-injects the leading blank line the original guard
        // tried to prevent (audit V1/S-2).
        return raw.replaceAll(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
    };

    const parts: string[] = [];

    if (template.header) {
        const out = interpolate(template.header);

        if (out.length > 0) {
            parts.push(out);
        }
    }

    parts.push(body);

    if (template.footer) {
        const out = interpolate(template.footer);

        if (out.length > 0) {
            parts.push(out);
        }
    }

    return parts.join("\n\n");
};

/**
 * Extract `internalAuthors` from the github-formatter changelog config
 * so `collectContributors` can hide the same bot handles the
 * CHANGELOG.md hides. Returns `undefined` for any other formatter shape
 * (operators who use a custom formatter must filter handles themselves).
 *
 * Exported for unit testing.
 */
export const extractInternalAuthors = (changelog: VisReleaseConfig["changelog"]): ReadonlyArray<string> | undefined => {
    if (!Array.isArray(changelog)) {
        return undefined;
    }

    const [name, options] = changelog;

    // Runtime guard against malformed user config (e.g. `["github"]` or
    // `["github", null]`) that the static tuple type can't catch.
    // eslint-disable-next-line sonarjs/different-types-comparison -- options is statically non-null but untrusted config may violate it
    if (name !== "github" || typeof options !== "object" || options === null) {
        return undefined;
    }

    const { internalAuthors } = options as { internalAuthors?: unknown };

    if (!Array.isArray(internalAuthors)) {
        return undefined;
    }

    return internalAuthors.filter((entry): entry is string => typeof entry === "string");
};
