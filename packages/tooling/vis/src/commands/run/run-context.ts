import type { Toolbox } from "@visulima/cerebro";

import type { buildProjectGraph, discoverWorkspace } from "../../config/workspace";
import type { RunOptions } from "./index";

/** Logger handed to the `run` command by cerebro. */
export type RunLogger = Toolbox<Console, RunOptions>["logger"];

/** Workspace model returned by `discoverWorkspace`. */
export type DiscoveredWorkspace = ReturnType<typeof discoverWorkspace>;

/** Project dependency graph built from the discovered workspace. */
export type RunProjectGraph = ReturnType<typeof buildProjectGraph>;
