//! Shared pure logic for the vis native CLI front-end.
//!
//! Package-manager detection (`detect`) and command resolution (`resolve`) in
//! plain Rust. The `vis` CLI binary calls these directly; the napi addon's
//! `pm_detect.rs` / `pm_resolve.rs` are thin wrappers over them, so both front
//! ends share one implementation. The per-function unit tests pin the argv output.

pub mod detect;
pub mod resolve;
