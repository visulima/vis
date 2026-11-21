//! Task-runner engines in plain Rust (no napi): task-graph algorithms, xxh3 file and
//! task hashing, git-worktree detection and the concurrent process runner. The
//! `task-runner-native` addon (the workspace root) wraps these for Node, and the `vis`
//! CLI can link them directly.

pub mod concurrent;
mod error;
mod file_hasher;
mod graph;
mod task_hasher;
mod worktree;

pub use concurrent::runner::ConcurrentRunner;
pub use error::Error;
pub use file_hasher::{
    collect_files, hash_bytes, hash_file, hash_files_batch, hash_files_in_directory, hash_string, hash_strings,
    FileHash,
};
pub use graph::{
    find_all_cycles, find_back_edges, find_cycle, get_dependent_tasks, get_transitive_deps, topological_sort,
    CycleResult, TaskGraph,
};
pub use task_hasher::{compute_task_hash, hash_command, hash_env_var, TaskHashDetails};
pub use worktree::{get_main_worktree_root, is_linked_worktree, reset_worktree_cache};
