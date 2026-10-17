import type { VisTargetConfiguration } from "../../task/target-options";
import type { RunLogger } from "./run-context";
import { resolveTaskArguments } from "./task-arguments";

/**
 * Validates the forwarded positional arguments against the target's declared
 * `arguments` schema and returns the VIS_ARG_* env vars. Returns `undefined`
 * after printing `--help` for the target. Throws when the projects disagree
 * on the schema or the arguments are invalid.
 */
export const resolveRunArguments = ({
    forwardedArgs,
    logger,
    projectsWithTarget,
    projectTargetIndex,
    target,
}: {
    forwardedArgs: string[];
    logger: RunLogger;
    projectsWithTarget: string[];
    projectTargetIndex: Map<string, VisTargetConfiguration>;
    target: string;
}): { env: Record<string, string> } | undefined => {
    // First-class task arguments: validate the forwarded args against the
    // invoked target's declared schema, surface per-task `--help`, and expose
    // validated values to the command as VIS_ARG_* env vars. See
    // `./task-arguments`. Because the same args + VIS_ARG_* reach every
    // selected project, all of them must agree on the contract — fail fast if
    // two projects expose this target with different `arguments` schemas
    // rather than validate one project's invocation against another's.
    const schemasByProject = projectsWithTarget
        .map((projectName) => {
            return { project: projectName, schema: projectTargetIndex.get(projectName)?.arguments };
        })
        .filter(
            (entry): entry is { project: string; schema: NonNullable<VisTargetConfiguration["arguments"]> } =>
                Array.isArray(entry.schema) && entry.schema.length > 0,
        );

    const distinctSchemas = new Map<string, string[]>();

    for (const { project, schema } of schemasByProject) {
        const key = JSON.stringify(schema);
        const projects = distinctSchemas.get(key) ?? [];

        projects.push(project);
        distinctSchemas.set(key, projects);
    }

    if (distinctSchemas.size > 1) {
        const groups = [...distinctSchemas.values()].map((projects) => projects.join(", ")).join(" | ");

        throw new Error(
            `Target "${target}" declares conflicting \`arguments\` schemas across projects (${groups}). `
            + `Run a single project (e.g. \`vis run ${schemasByProject[0]?.project}:${target}\` or --projects=<name>) so the argument contract is unambiguous.`,
        );
    }

    const argumentSchema = schemasByProject[0]?.schema;
    const argumentDescription = projectTargetIndex.get(schemasByProject[0]?.project ?? (projectsWithTarget[0] as string))?.description;
    const argumentResolution = resolveTaskArguments(target, argumentDescription, argumentSchema, forwardedArgs);

    if (argumentResolution.kind === "help") {
        logger.info(argumentResolution.text);

        return undefined;
    }

    if (argumentResolution.kind === "invalid") {
        logger.info(`Invalid arguments for "${target}":`);

        for (const message of argumentResolution.errors) {
            logger.info(`  ✖ ${message}`);
        }

        logger.info("");
        logger.info(argumentResolution.help);

        throw new Error(`Invalid arguments for target "${target}"`);
    }

    return { env: argumentResolution.env };
};
