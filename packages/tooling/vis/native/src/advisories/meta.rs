//! The `meta` key/value table: the row keys shared by ingest, status and the schema gate.
//!
//! Per-ecosystem rows live under the ecosystem name; rows that describe the whole file live under
//! [`GLOBAL`].

use rusqlite::{params, Connection, OptionalExtension};

/// `ecosystem` value of rows that describe the database file rather than one ecosystem.
pub const GLOBAL: &str = "";

pub const SCHEMA_VERSION: &str = "schema_version";
pub const LAST_SYNC_ISO: &str = "last_sync_iso";
pub const ADVISORY_COUNT: &str = "advisory_count";
pub const MANIFEST_ETAG: &str = "manifest_etag";

/// The value of one row, or `None` when the row does not exist. Any other failure (a busy or locked
/// database, a missing table) is an error: it says nothing about whether the row exists.
pub fn read(conn: &Connection, ecosystem: &str, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE ecosystem = ?1 AND key = ?2", params![ecosystem, key], |row| {
        row.get(0)
    })
    .optional()
}

pub fn upsert(conn: &Connection, ecosystem: &str, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (ecosystem, key, value) VALUES (?1, ?2, ?3) \
         ON CONFLICT(ecosystem, key) DO UPDATE SET value = excluded.value",
        params![ecosystem, key, value],
    )?;
    Ok(())
}
