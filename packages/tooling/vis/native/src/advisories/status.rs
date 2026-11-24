use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use super::meta;

#[derive(Debug)]
pub struct DbStatus {
    pub exists: bool,
    /// The stored schema version. `0` when the file does not exist or holds no readable version row,
    /// which is older than every supported version, so callers rebuild it.
    pub schema_version: u32,
    pub size_bytes: u64,
    pub ecosystems: Vec<EcosystemStatus>,
}

#[derive(Debug)]
pub struct EcosystemStatus {
    pub name: String,
    pub advisory_count: u64,
    pub last_sync_iso: String,
    /// HTTP ETag stored at the last sync. Used to short-circuit re-downloads.
    /// `None` when the server never sent one (or the meta row is missing).
    pub manifest_etag: Option<String>,
}

pub fn status<P: AsRef<Path>>(db_path: P) -> Result<DbStatus, rusqlite::Error> {
    let path = db_path.as_ref();
    if !path.exists() {
        return Ok(DbStatus { exists: false, schema_version: 0, size_bytes: 0, ecosystems: Vec::new() });
    }

    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let schema_version =
        meta::read(&conn, meta::GLOBAL, meta::SCHEMA_VERSION)?.and_then(|v| v.parse().ok()).unwrap_or(0);

    let mut stmt = conn.prepare("SELECT DISTINCT ecosystem FROM meta WHERE ecosystem != '' ORDER BY ecosystem")?;
    let names = stmt.query_map([], |row| row.get::<_, String>(0))?;

    let mut ecosystems = Vec::new();
    for name in names {
        let name = name?;
        let advisory_count = meta::read(&conn, &name, meta::ADVISORY_COUNT)?.and_then(|v| v.parse().ok()).unwrap_or(0);
        let last_sync_iso = meta::read(&conn, &name, meta::LAST_SYNC_ISO)?.unwrap_or_default();
        let manifest_etag = meta::read(&conn, &name, meta::MANIFEST_ETAG)?;
        ecosystems.push(EcosystemStatus { name, advisory_count, last_sync_iso, manifest_etag });
    }

    Ok(DbStatus { exists: true, schema_version, size_bytes, ecosystems })
}

#[cfg(test)]
mod tests {
    use super::super::schema::ensure_schema;
    use super::super::test_support::TempDir;
    use super::*;

    fn seeded_db(dir: &TempDir) -> std::path::PathBuf {
        let path = dir.path("db.sqlite");
        let conn = Connection::open(&path).unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO meta (ecosystem, key, value) VALUES ('npm', 'advisory_count', '7'), ('npm', 'last_sync_iso', '2024-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        path
    }

    #[test]
    fn reports_the_stored_schema_version_and_ecosystem_meta() {
        let dir = TempDir::new();
        let path = seeded_db(&dir);

        let status = status(&path).unwrap();

        assert_eq!(status.schema_version, 2);
        assert_eq!(status.ecosystems.len(), 1);
        assert_eq!(status.ecosystems[0].advisory_count, 7);
        assert_eq!(status.ecosystems[0].last_sync_iso, "2024-01-01T00:00:00Z");
    }

    #[test]
    fn a_missing_schema_version_row_is_not_reported_as_the_current_version() {
        let dir = TempDir::new();
        let path = seeded_db(&dir);
        Connection::open(&path)
            .unwrap()
            .execute("DELETE FROM meta WHERE ecosystem = '' AND key = 'schema_version'", [])
            .unwrap();

        let status = status(&path).unwrap();

        assert_eq!(status.schema_version, 0);
    }

    #[test]
    fn a_non_numeric_schema_version_is_not_reported_as_the_current_version() {
        let dir = TempDir::new();
        let path = seeded_db(&dir);
        Connection::open(&path)
            .unwrap()
            .execute("UPDATE meta SET value = 'garbage' WHERE ecosystem = '' AND key = 'schema_version'", [])
            .unwrap();

        let status = status(&path).unwrap();

        assert_eq!(status.schema_version, 0);
    }

    #[test]
    fn an_unreadable_ecosystem_row_is_an_error_not_a_zero_count() {
        let dir = TempDir::new();
        let path = seeded_db(&dir);
        // A BLOB where a string is expected: the read fails with something other than "no such row".
        Connection::open(&path)
            .unwrap()
            .execute("UPDATE meta SET value = x'00' WHERE ecosystem = 'npm' AND key = 'advisory_count'", [])
            .unwrap();

        let result = status(&path);

        assert!(result.is_err(), "an unreadable row must surface, got {result:?}");
    }

    #[test]
    fn a_locked_database_is_an_error_not_an_empty_status() {
        let dir = TempDir::new();
        let path = seeded_db(&dir);
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("BEGIN EXCLUSIVE").unwrap();

        let result = status(&path);

        writer.execute_batch("ROLLBACK").unwrap();
        assert!(result.is_err(), "a busy read must surface, got {result:?}");
    }
}
