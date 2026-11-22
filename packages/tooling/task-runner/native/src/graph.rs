use napi::bindgen_prelude::*;
use napi_derive::napi;
use task_runner_core as core;

/// Represents a task graph for native graph operations.
#[napi(object)]
pub struct NativeTaskGraph {
    /// All task IDs in the graph.
    pub task_ids: Vec<String>,
    /// Dependencies as pairs of [from_task_id, to_task_id].
    pub edges: Vec<Vec<String>>,
}

impl From<NativeTaskGraph> for core::TaskGraph {
    fn from(graph: NativeTaskGraph) -> Self {
        Self { task_ids: graph.task_ids, edges: graph.edges }
    }
}

/// Result of cycle detection.
#[napi(object, object_from_js = false)]
pub struct CycleResult {
    /// Whether a cycle was found.
    pub has_cycle: bool,
    /// The cycle as a list of task IDs, or empty if no cycle.
    pub cycle: Vec<String>,
}

impl From<core::CycleResult> for CycleResult {
    fn from(result: core::CycleResult) -> Self {
        Self { has_cycle: result.has_cycle, cycle: result.cycle }
    }
}

/// Finds a single cycle in the task graph using DFS.
#[napi(catch_unwind)]
pub fn find_cycle(graph: NativeTaskGraph) -> CycleResult {
    core::find_cycle(&graph.into()).into()
}

/// Finds all cycles in the task graph.
///
/// Iterative DFS — a recursive implementation would blow the native
/// thread's stack on a deep task chain (NAPI threads run with a smaller
/// stack than the main thread on some platforms). Each work-stack
/// frame holds `(node, next_child_index)` so we can resume scanning
/// children after recursing into a child.
#[napi(catch_unwind)]
pub fn find_all_cycles(graph: NativeTaskGraph) -> Vec<Vec<String>> {
    core::find_all_cycles(&graph.into())
}

/// Performs a topological sort of the task graph.
/// Returns task IDs in topological order (dependencies first).
#[napi(catch_unwind)]
pub fn topological_sort(graph: NativeTaskGraph) -> Result<Vec<String>> {
    core::topological_sort(&graph.into()).map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}

/// Makes the graph acyclic by removing back edges.
/// Returns the edges that were removed.
///
/// Iterative DFS for the same reason as `find_all_cycles`.
#[napi(catch_unwind)]
pub fn find_back_edges(graph: NativeTaskGraph) -> Vec<Vec<String>> {
    core::find_back_edges(&graph.into())
}

/// Gets all transitive dependencies of a task.
#[napi(catch_unwind)]
pub fn get_transitive_deps(graph: NativeTaskGraph, task_id: String) -> Vec<String> {
    core::get_transitive_deps(&graph.into(), &task_id)
}

/// Gets all tasks that depend on the given task (reverse transitive dependencies).
#[napi(catch_unwind)]
pub fn get_dependent_tasks(graph: NativeTaskGraph, task_id: String) -> Vec<String> {
    core::get_dependent_tasks(&graph.into(), &task_id)
}
