//! Offline OSV advisory database.
//!
//! Schema, ingest, query, and per-ecosystem range matching for a single
//! `<cache>/vis/advisories/db.sqlite` shared across every synced ecosystem.

pub mod ingest;
pub mod meta;
pub mod osv;
pub mod query;
pub mod range;
pub mod schema;
pub mod status;
#[cfg(test)]
mod test_support;

pub use ingest::ingest;
pub use query::{query, AdvisoryHit, QueryInput};
pub use status::{status, DbStatus, EcosystemStatus};
