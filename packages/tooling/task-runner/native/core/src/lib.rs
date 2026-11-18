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
pub use file_hasher::*;
pub use graph::*;
pub use task_hasher::*;
pub use worktree::*;
