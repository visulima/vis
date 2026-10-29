/**
 * Parse the stdout of `gh api --paginate` / `glab api --paginate` into one flat list.
 *
 * Without `--slurp`, both CLIs print each page as its own JSON array, back to back (`[…][…]`), which
 * `JSON.parse` rejects. A PR with more than one page of comments then looked like a PR with none,
 * so a sticky-comment upsert posted a duplicate instead of updating the existing one.
 *
 * Returns `undefined` when the output is not a sequence of JSON arrays.
 */
export const parsePaginatedJson = (stdout: string): unknown[] | undefined => {
    const items: unknown[] = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;

    for (let index = 0; index < stdout.length; index += 1) {
        const char = stdout[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }

            continue;
        }

        switch (char) {
            case "\"": {
                inString = true;

                break;
            }
            case "[":
            case "{": {
                if (depth === 0) {
                    start = index;
                }

                depth += 1;

                break;
            }
            case "]":
            case "}": {
                depth -= 1;

                if (depth === 0) {
                    try {
                        const page = JSON.parse(stdout.slice(start, index + 1));

                        if (!Array.isArray(page)) {
                            return undefined;
                        }

                        items.push(...page);
                    } catch {
                        return undefined;
                    }
                }

                break;
            }
            default: {
                if (depth === 0 && char !== undefined && !/\s/.test(char)) {
                    return undefined;
                }
            }
        }
    }

    return depth === 0 && start !== -1 ? items : undefined;
};
