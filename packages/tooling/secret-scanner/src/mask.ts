// The one place secrets are masked for `redact: true`. The native scan always
// returns real values; the pipeline masks what it reports.

import type { Finding } from "./types";

/**
 * Mask a secret the way the native layer does (`abc***xyz`, `******` for six
 * characters or fewer), counting characters rather than bytes.
 */
export const maskSecret = (value: string): string => {
    // Code points, like Rust `chars()`; grapheme clusters aren't needed for a mask.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- See above.
    const chars = [...value];

    if (chars.length <= 6) {
        return "******";
    }

    return `${chars.slice(0, 3).join("")}${"*".repeat(chars.length - 6)}${chars.slice(-3).join("")}`;
};

/** Mask every secret-bearing field of a finding: `match`, `secret` and its composite dependencies'. */
export const maskFinding = <F extends Finding>(finding: F): F => {
    const masked = { ...finding, match: maskSecret(finding.match), secret: maskSecret(finding.secret) };

    if (finding.requiredFindings !== undefined) {
        masked.requiredFindings = finding.requiredFindings.map((required) => {
            return { ...required, match: maskSecret(required.match), secret: maskSecret(required.secret) };
        });
    }

    return masked;
};
