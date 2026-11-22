import type { Task } from "@visulima/task-runner";

import type { VisTargetOptions } from "../../task/target-options";

/** The vis-specific target options `createRunTaskGraph` copies onto every task. */
export const getVisOptions = (task: Task): VisTargetOptions | undefined => {
    const options = task.overrides["visOptions"];

    return options && typeof options === "object" ? options : undefined;
};
