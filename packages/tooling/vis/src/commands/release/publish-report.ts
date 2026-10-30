import type { PublishContextResult } from "../../release/core/orchestrator/publish-types";

/**
 * A GitHub Actions annotation, which shows on the run summary even when the
 * job passes (a failed success-walk comment does not fail the run). Written
 * to raw stdout: the runner only parses it at column 0, where the logger's
 * prefix would sit. No other CI has an equivalent.
 */
export const annotate = (level: "error" | "warning", message: string): void => {
    if (process.env["GITHUB_ACTIONS"] === "true") {
        process.stdout.write(`::${level}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`);
    }
};

/**
 * One line per package of a publish wave, then the counts. Shared by
 * `vis release publish` and `vis release ci release` so a CI log names what
 * was skipped or failed and why, not only how many.
 */
export const reportPublishResult = (logger: Console, result: PublishContextResult, distTag: string): void => {
    for (const item of result.published) {
        logger.info(`  [published] ${item.name}@${item.version} (dist-tag ${distTag})`);
    }

    for (const item of result.skipped) {
        // stage-rejected / stage-timeout are warnings (not info) so reviewers
        // spot them in CI tails. They're still skipped, not failed.
        if (item.reason.startsWith("stage-")) {
            logger.warn(`  [stage]     ${item.name} (${item.reason} — re-run \`vis release publish\` once approved)`);
        } else {
            logger.info(`  [skipped]   ${item.name} (${item.reason})`);
        }
    }

    for (const item of result.failed) {
        logger.error(`  [failed]    ${item.name}: ${item.reason}`);
        annotate("error", `${item.name}: ${item.reason}`);
    }

    logger.info("");
    logger.info(`Published: ${result.published.length} | Skipped: ${result.skipped.length} | Failed: ${result.failed.length}`);

    if (result.tags.length > 0) {
        // Forge releases, the success walk and notifications only run once the tags are pushed.
        logger.info(`Tags created: ${result.tags.length}${result.tagsPushed ? " (pushed)" : " (NOT pushed — re-run with --resume to retry)"}`);
    }
};

export const reportWarnings = (logger: Console, warnings: ReadonlyArray<string>): void => {
    if (warnings.length === 0) {
        return;
    }

    logger.warn(`${warnings.length} warning(s):`);

    for (const warning of warnings) {
        logger.warn(`  - ${warning}`);
        annotate("warning", warning);
    }
};
