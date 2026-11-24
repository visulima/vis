use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params, Connection};
use zip::ZipArchive;

use super::meta;
use super::osv;
use super::schema::{check_writable, ensure_schema};

/// Per-entry uncompressed cap. Real OSV records are < 64 KiB; the cap is
/// generous to allow upstream growth without rebuild but tight enough to stop
/// a zip-bomb mirror.
pub const MAX_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
/// Total uncompressed cap across all entries in one ingest call.
pub const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Emit progress every N parsed advisories. Picked to keep the threadsafe
/// callback rate well under 1 kHz on a slow machine.
const PROGRESS_EVERY: usize = 5_000;

#[derive(Debug)]
pub struct IngestStats {
    pub advisories_ingested: usize,
    pub duration_ms: u128,
}

pub trait IngestProgress: Send {
    fn emit(&mut self, current: usize, total: usize);
}

impl<F> IngestProgress for F
where
    F: FnMut(usize, usize) + Send,
{
    fn emit(&mut self, current: usize, total: usize) {
        self(current, total)
    }
}

#[derive(Debug)]
pub enum IngestError {
    Io(std::io::Error),
    Zip(zip::result::ZipError),
    Sqlite(rusqlite::Error),
    Schema(super::schema::AdvisorySchemaError),
    OversizedEntry { name: String, observed: u64 },
    TotalSizeExceeded { observed: u64 },
    BadJson { entry: String, message: String },
}

impl std::fmt::Display for IngestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::Zip(e) => write!(f, "zip error: {e}"),
            Self::Sqlite(e) => write!(f, "sqlite error: {e}"),
            Self::Schema(e) => write!(f, "schema error: {e}"),
            Self::OversizedEntry { name, observed } => write!(
                f,
                "advisory zip entry '{name}' decompresses to {observed} bytes, exceeds MAX_ENTRY_BYTES ({MAX_ENTRY_BYTES}). Refusing to ingest (possible zip-bomb).",
            ),
            Self::TotalSizeExceeded { observed } => write!(
                f,
                "advisory zip total uncompressed size {observed} bytes exceeds MAX_TOTAL_BYTES ({MAX_TOTAL_BYTES}). Refusing to ingest.",
            ),
            Self::BadJson { entry, message } => {
                write!(f, "advisory '{entry}' failed JSON parse: {message}")
            }
        }
    }
}

impl std::error::Error for IngestError {}

impl From<std::io::Error> for IngestError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<zip::result::ZipError> for IngestError {
    fn from(e: zip::result::ZipError) -> Self {
        Self::Zip(e)
    }
}
impl From<rusqlite::Error> for IngestError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}
impl From<super::schema::AdvisorySchemaError> for IngestError {
    fn from(e: super::schema::AdvisorySchemaError) -> Self {
        Self::Schema(e)
    }
}

/// Range kinds whose events are indexed into `affected`; `GIT` ranges carry commit hashes, not versions.
const INDEXED_RANGE_KINDS: [&str; 2] = ["SEMVER", "ECOSYSTEM"];

/// The prepared INSERT statements one ingest runs for every advisory.
struct InsertStatements<'conn> {
    advisory: rusqlite::Statement<'conn>,
    alias: rusqlite::Statement<'conn>,
    affected: rusqlite::Statement<'conn>,
}

impl<'conn> InsertStatements<'conn> {
    fn prepare(conn: &'conn Connection) -> rusqlite::Result<Self> {
        // An advisory that spans ecosystems is ingested once per ecosystem. `INSERT OR REPLACE` would delete
        // the existing row first, and the `ON DELETE CASCADE` on `affected` and `advisory_alias` would drop
        // the other ecosystems' rows with it, so the row is updated in place.
        Ok(Self {
            advisory: conn.prepare(
                "INSERT INTO advisory (id, summary, severity, cvss_score, published, modified) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, severity = excluded.severity, \
                 cvss_score = excluded.cvss_score, published = excluded.published, modified = excluded.modified",
            )?,
            alias: conn.prepare("INSERT OR IGNORE INTO advisory_alias (advisory_id, alias) VALUES (?1, ?2)")?,
            affected: conn.prepare(
                "INSERT OR REPLACE INTO affected (advisory_id, ecosystem, package, introduced, fixed, last_affected, range_index) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?,
        })
    }
}

pub fn ingest<P: AsRef<Path>>(
    db_path: P,
    zip_path: P,
    ecosystem: &str,
    manifest_etag: Option<&str>,
    mut progress: impl IngestProgress,
) -> Result<IngestStats, IngestError> {
    let started = Instant::now();

    let mut conn = Connection::open(db_path.as_ref())?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    check_writable(&conn).map_err(IngestError::Schema)?;
    ensure_schema(&conn)?;

    let file = File::open(zip_path.as_ref())?;
    let mut archive = ZipArchive::new(file)?;
    let total = archive.len();

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // §D step (d): delete this ecosystem's rows first, then GC orphan
    // advisories. Reversing the order would cascade-drop other ecosystems'
    // `affected` rows for the same advisory id.
    tx.execute("DELETE FROM affected WHERE ecosystem = ?1", params![ecosystem])?;
    tx.execute("DELETE FROM advisory WHERE id NOT IN (SELECT advisory_id FROM affected)", [])?;

    let mut ingested = 0usize;
    let mut total_bytes = 0u64;

    {
        let mut statements = InsertStatements::prepare(&tx)?;

        for i in 0..total {
            let mut entry = archive.by_index(i)?;
            if !entry.is_file() {
                continue;
            }

            let advisory = read_entry(&mut entry, &mut total_bytes)?;
            insert_advisory(&mut statements, &advisory, ecosystem)?;

            ingested += 1;
            if ingested.is_multiple_of(PROGRESS_EVERY) {
                progress.emit(ingested, total);
            }
        }
    }

    let now_iso = chrono_iso_now();
    meta::upsert(&tx, ecosystem, meta::LAST_SYNC_ISO, &now_iso)?;
    meta::upsert(&tx, ecosystem, meta::ADVISORY_COUNT, &ingested.to_string())?;
    if let Some(etag) = manifest_etag {
        meta::upsert(&tx, ecosystem, meta::MANIFEST_ETAG, etag)?;
    }

    tx.commit()?;
    conn.execute("ANALYZE", [])?;

    progress.emit(ingested, total);

    // The caller owns the zip and removes it (src/security/advisories.ts), also when this call fails.
    Ok(IngestStats { advisories_ingested: ingested, duration_ms: started.elapsed().as_millis() })
}

/// Read one zip entry into an [`osv::Advisory`], enforcing the per-entry and running total size caps.
fn read_entry<R: Read>(
    entry: &mut zip::read::ZipFile<'_, R>,
    total_bytes: &mut u64,
) -> Result<osv::Advisory, IngestError> {
    let size = entry.size();
    if size > MAX_ENTRY_BYTES {
        return Err(IngestError::OversizedEntry {
            name: String::from_utf8_lossy(entry.name_raw()).into_owned(),
            observed: size,
        });
    }
    *total_bytes = total_bytes.saturating_add(size);
    if *total_bytes > MAX_TOTAL_BYTES {
        return Err(IngestError::TotalSizeExceeded { observed: *total_bytes });
    }

    let mut buf = Vec::with_capacity(size as usize);
    entry.read_to_end(&mut buf)?;

    serde_json::from_slice(&buf).map_err(|e| IngestError::BadJson {
        entry: String::from_utf8_lossy(entry.name_raw()).into_owned(),
        message: e.to_string(),
    })
}

/// Write one advisory, its aliases, and the `affected` rows that belong to `ecosystem`.
fn insert_advisory(
    statements: &mut InsertStatements<'_>,
    advisory: &osv::Advisory,
    ecosystem: &str,
) -> rusqlite::Result<()> {
    let (severity, cvss_score) = osv::normalized_severity(advisory);
    let published = advisory.published.clone().unwrap_or_default();
    let modified = advisory.modified.clone().unwrap_or_default();

    statements.advisory.execute(params![advisory.id, advisory.summary, severity, cvss_score, published, modified])?;

    for alias in &advisory.aliases {
        statements.alias.execute(params![advisory.id, alias])?;
    }

    // range_index is monotonic per (advisory, ecosystem, package) so
    // overlapping ranges don't collide on the PK.
    let mut per_package: HashMap<(String, String), i64> = HashMap::new();
    for affected in &advisory.affected {
        let Some(package) = affected.package.as_ref() else {
            continue;
        };
        if !package.ecosystem.eq_ignore_ascii_case(ecosystem) {
            continue;
        }
        let package_norm = package.name.to_lowercase();
        let pairs = affected
            .ranges
            .iter()
            .filter(|range| INDEXED_RANGE_KINDS.contains(&range.kind.as_str()))
            .flat_map(osv::Range::to_pairs);
        for pair in pairs {
            let idx = per_package.entry((package.ecosystem.clone(), package_norm.clone())).or_insert(0);
            let range_index = *idx;
            *idx += 1;

            statements.affected.execute(params![
                advisory.id,
                ecosystem,
                package_norm,
                pair.introduced,
                pair.fixed,
                pair.last_affected,
                range_index,
            ])?;
        }
    }

    Ok(())
}

/// Avoid adding a chrono dependency for a single ISO-8601 timestamp; the format
/// `YYYY-MM-DDTHH:MM:SSZ` is well-defined and we don't need sub-second precision.
fn chrono_iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format_iso8601(secs)
}

fn format_iso8601(unix_secs: u64) -> String {
    let (year, month, day) = vis_core::date::civil_from_days((unix_secs / 86_400) as i64);
    let seconds = unix_secs % 86_400;

    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", seconds / 3600, seconds % 3600 / 60, seconds % 60)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::PathBuf;

    use super::super::test_support::TempDir;
    use super::*;

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, body) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(body.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    /// One advisory that affects a package in both `npm` and `PyPI`, the way a GHSA record spanning
    /// ecosystems appears in each ecosystem's dump.
    const CROSS_ECOSYSTEM_ADVISORY: &str = r#"{
        "id": "GHSA-aaaa-bbbb-cccc",
        "aliases": ["CVE-2024-0001"],
        "summary": "cross-ecosystem advisory",
        "affected": [
            {"package": {"ecosystem": "npm", "name": "Left-Pad"},
             "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "1.2.0"}]}]},
            {"package": {"ecosystem": "PyPI", "name": "left-pad"},
             "ranges": [{"type": "ECOSYSTEM", "events": [{"introduced": "0"}, {"fixed": "2.0"}]}]}
        ]
    }"#;

    fn ingest_into(db: &Path, dir: &TempDir, ecosystem: &str, entries: &[(&str, &str)]) -> PathBuf {
        let zip = dir.path(&format!("{ecosystem}.zip"));
        write_zip(&zip, entries);
        ingest(db, zip.as_path(), ecosystem, None, |_: usize, _: usize| {}).unwrap();
        zip
    }

    fn affected_ecosystems(db: &Path, advisory_id: &str) -> Vec<String> {
        let conn = Connection::open(db).unwrap();
        let mut stmt =
            conn.prepare("SELECT DISTINCT ecosystem FROM affected WHERE advisory_id = ?1 ORDER BY ecosystem").unwrap();
        let rows = stmt.query_map(params![advisory_id], |row| row.get::<_, String>(0)).unwrap();
        rows.map(Result::unwrap).collect()
    }

    #[test]
    fn ingesting_a_second_ecosystem_keeps_the_first_ecosystems_rows_for_a_shared_advisory() {
        let dir = TempDir::new();
        let db = dir.path("db.sqlite");

        ingest_into(&db, &dir, "npm", &[("GHSA-aaaa-bbbb-cccc.json", CROSS_ECOSYSTEM_ADVISORY)]);
        ingest_into(&db, &dir, "PyPI", &[("GHSA-aaaa-bbbb-cccc.json", CROSS_ECOSYSTEM_ADVISORY)]);

        assert_eq!(affected_ecosystems(&db, "GHSA-aaaa-bbbb-cccc"), vec!["PyPI".to_string(), "npm".to_string()]);

        let conn = Connection::open(&db).unwrap();
        let aliases: i64 = conn
            .query_row("SELECT COUNT(*) FROM advisory_alias WHERE advisory_id = 'GHSA-aaaa-bbbb-cccc'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(aliases, 1, "the alias row must survive the second ingest");
    }

    #[test]
    fn re_ingesting_an_ecosystem_replaces_its_rows_and_keeps_the_others() {
        let dir = TempDir::new();
        let db = dir.path("db.sqlite");

        ingest_into(&db, &dir, "npm", &[("GHSA-aaaa-bbbb-cccc.json", CROSS_ECOSYSTEM_ADVISORY)]);
        ingest_into(&db, &dir, "PyPI", &[("GHSA-aaaa-bbbb-cccc.json", CROSS_ECOSYSTEM_ADVISORY)]);
        ingest_into(&db, &dir, "npm", &[("GHSA-aaaa-bbbb-cccc.json", CROSS_ECOSYSTEM_ADVISORY)]);

        assert_eq!(affected_ecosystems(&db, "GHSA-aaaa-bbbb-cccc"), vec!["PyPI".to_string(), "npm".to_string()]);
    }

    #[test]
    fn ingest_leaves_the_callers_zip_in_place() {
        let dir = TempDir::new();
        let db = dir.path("db.sqlite");

        let zip = ingest_into(&db, &dir, "npm", &[("GHSA-aaaa-bbbb-cccc.json", CROSS_ECOSYSTEM_ADVISORY)]);

        assert!(zip.exists(), "src/security/advisories.ts owns the zip's removal");
    }

    #[test]
    fn iso8601_known_epoch_seconds() {
        // 2024-01-15T12:34:56Z = 1705322096
        assert_eq!(format_iso8601(1_705_322_096), "2024-01-15T12:34:56Z");
        // 1970-01-01T00:00:00Z = 0
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00Z");
    }
}
