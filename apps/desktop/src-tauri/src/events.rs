//! The interaction log: append-only, the source of truth for all learner state.
//! The same database file holds stored content (`content.rs`), grades (`grade.rs`), explanations and the cost log
//! (`llm.rs`); their tables are
//! created by the migrations here so there is one `user_version` sequence.

use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const MIGRATIONS: &[&str] = &[r#"
  CREATE TABLE interaction_event (
    id         TEXT PRIMARY KEY,
    learner_id TEXT NOT NULL,
    language   TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    at         TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    UNIQUE (learner_id, seq)
  );
  CREATE TRIGGER interaction_event_no_update BEFORE UPDATE ON interaction_event
    BEGIN SELECT RAISE(ABORT, 'interaction_event is append-only'); END;
  CREATE TRIGGER interaction_event_no_delete BEFORE DELETE ON interaction_event
    BEGIN SELECT RAISE(ABORT, 'interaction_event is append-only'); END;
"#, r#"
  CREATE TABLE content (
    id             TEXT PRIMARY KEY,
    learner_id     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    source         TEXT NOT NULL CHECK (source IN ('generated', 'learner')),
    prompt_version TEXT,
    model          TEXT,
    payload        TEXT NOT NULL
  );
  CREATE INDEX content_learner ON content (learner_id, created_at);
  CREATE TRIGGER content_no_update BEFORE UPDATE ON content
    BEGIN SELECT RAISE(ABORT, 'content is immutable'); END;
  CREATE TRIGGER content_no_delete BEFORE DELETE ON content
    BEGIN SELECT RAISE(ABORT, 'content is immutable'); END;
  CREATE TABLE llm_call (
    id                 TEXT PRIMARY KEY,
    at                 TEXT NOT NULL,
    route              TEXT NOT NULL,
    prompt_version     TEXT NOT NULL,
    model              TEXT NOT NULL,
    session_id         TEXT,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    latency_ms         INTEGER NOT NULL,
    stop_reason        TEXT,
    error              TEXT
  );
  CREATE INDEX llm_call_route ON llm_call (route);
"#, r#"
  -- Library passages (pre-written, shipped with the app) are stored content too. SQLite cannot change a CHECK in place,
  -- so the table is rebuilt with its rows; dropping a table fires no delete triggers.
  CREATE TABLE content_v3 (
    id             TEXT PRIMARY KEY,
    learner_id     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    source         TEXT NOT NULL CHECK (source IN ('generated', 'learner', 'library')),
    prompt_version TEXT,
    model          TEXT,
    payload        TEXT NOT NULL
  );
  INSERT INTO content_v3 SELECT id, learner_id, created_at, source, prompt_version, model, payload FROM content ORDER BY rowid;
  DROP TABLE content;
  ALTER TABLE content_v3 RENAME TO content;
  CREATE INDEX content_learner ON content (learner_id, created_at);
  CREATE TRIGGER content_no_update BEFORE UPDATE ON content
    BEGIN SELECT RAISE(ABORT, 'content is immutable'); END;
  CREATE TRIGGER content_no_delete BEFORE DELETE ON content
    BEGIN SELECT RAISE(ABORT, 'content is immutable'); END;
"#, r#"
  -- Explanations of mistakes, written from an approved fact sheet (architecture §5.1). Stored once per key
  -- (point, fact sheet version, example, wrong answer) and reused, never rewritten.
  CREATE TABLE explanation (
    key            TEXT PRIMARY KEY,
    created_at     TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    model          TEXT NOT NULL,
    text           TEXT NOT NULL
  );
  CREATE TRIGGER explanation_no_update BEFORE UPDATE ON explanation
    BEGIN SELECT RAISE(ABORT, 'explanation is immutable'); END;
  CREATE TRIGGER explanation_no_delete BEFORE DELETE ON explanation
    BEGIN SELECT RAISE(ABORT, 'explanation is immutable'); END;
"#, r#"
  -- Grades of free writing (architecture §4.6): the model's findings, mapped once and replayed as stored.
  CREATE TABLE grade (
    id             TEXT PRIMARY KEY,
    learner_id     TEXT NOT NULL,
    activity_id    TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    model          TEXT NOT NULL,
    payload        TEXT NOT NULL
  );
  CREATE INDEX grade_learner ON grade (learner_id, created_at);
  CREATE TRIGGER grade_no_update BEFORE UPDATE ON grade
    BEGIN SELECT RAISE(ABORT, 'grade is immutable'); END;
  CREATE TRIGGER grade_no_delete BEFORE DELETE ON grade
    BEGIN SELECT RAISE(ABORT, 'grade is immutable'); END;
"#];

pub struct EventStore {
  pub(crate) path: PathBuf,
  pub(crate) conn: Connection,
}

impl EventStore {
  pub fn open(path: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
    let conn = Connection::open(&path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&conn)?;
    Ok(Self { path, conn })
  }

  pub fn path(&self) -> &Path {
    &self.path
  }

  pub fn conn(&self) -> &Connection {
    &self.conn
  }

  fn load(&self, learner_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = self
      .conn
      .prepare("SELECT payload FROM interaction_event WHERE learner_id = ?1 ORDER BY seq")?;
    let rows = stmt.query_map(params![learner_id], |row| row.get::<_, String>(0))?;
    rows
      .map(|r| r.map(|s| serde_json::from_str(&s).unwrap_or(Value::Null)))
      .collect()
  }

  pub(crate) fn append(&self, event: &Value) -> Result<(), String> {
    insert(&self.conn, event)
  }

}

/// Inserts one event; the table's triggers and unique (learner, seq) keep the log append-only and ordered.
pub(crate) fn insert(conn: &Connection, event: &Value) -> Result<(), String> {
  let field = |k: &str| {
    event
      .get(k)
      .and_then(Value::as_str)
      .ok_or_else(|| format!("event is missing `{k}`"))
  };
  let seq = event
    .get("seq")
    .and_then(Value::as_i64)
    .ok_or("event is missing `seq`")?;
  conn
    .execute(
      "INSERT INTO interaction_event (id, learner_id, language, seq, at, kind, payload)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      params![
        field("id")?,
        field("learnerId")?,
        field("language")?,
        seq,
        field("at")?,
        field("kind")?,
        event.to_string()
      ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
  let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
  for (i, sql) in (0i64..).zip(MIGRATIONS.iter()).skip(version as usize) {
    // Each migration and its version bump commit together, so a crash mid-way leaves the previous version intact.
    conn.execute_batch("BEGIN")?;
    let step = conn.execute_batch(sql).and_then(|_| conn.pragma_update(None, "user_version", i + 1));
    match step {
      Ok(()) => conn.execute_batch("COMMIT")?,
      Err(e) => {
        conn.execute_batch("ROLLBACK").ok();
        return Err(e);
      }
    }
  }
  Ok(())
}

type Store<'a> = State<'a, Mutex<EventStore>>;

#[tauri::command]
pub fn events_load(store: Store, learner_id: String) -> Result<Vec<Value>, String> {
  store.lock().unwrap().load(&learner_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn events_append(store: Store, event: Value) -> Result<(), String> {
  store.lock().unwrap().append(&event)
}

/// Starting over is the one way the log goes away: the whole file is replaced, which also drops stored content
/// and grades.
/// The cost log is not learner data, so its rows are carried over into the new file.
#[tauri::command]
pub fn events_reset(store: Store) -> Result<(), String> {
  reset(&mut store.lock().unwrap())
}

fn reset(guard: &mut EventStore) -> Result<(), String> {
  let kept = KeptRows::read(&guard.conn, "llm_call").map_err(|e| e.to_string())?;
  let path = guard.path.clone();
  let fresh = path.with_extension("sqlite.new");
  let _ = std::fs::remove_file(&fresh);
  let next = EventStore::open(fresh.clone()).map_err(|e| e.to_string())?;
  drop(std::mem::replace(guard, next));
  for ext in ["sqlite", "sqlite-wal", "sqlite-shm"] {
    let _ = std::fs::remove_file(path.with_extension(ext));
  }
  drop(std::mem::replace(
    guard,
    EventStore::open(path.clone()).map_err(|e| e.to_string())?,
  ));
  for ext in ["sqlite.new", "sqlite.new-wal", "sqlite.new-shm"] {
    let _ = std::fs::remove_file(path.with_extension(ext));
  }
  kept.write(&mut guard.conn).map_err(|e| e.to_string())
}

/// Every row of one table, held in memory across a reset.
pub(crate) struct KeptRows {
  table: &'static str,
  columns: usize,
  rows: Vec<Vec<rusqlite::types::Value>>,
}

impl KeptRows {
  pub(crate) fn read(conn: &Connection, table: &'static str) -> rusqlite::Result<Self> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table}"))?;
    let columns = stmt.column_count();
    let rows = stmt
      .query_map([], |row| (0..columns).map(|i| row.get(i)).collect())?
      .collect::<rusqlite::Result<_>>()?;
    Ok(Self { table, columns, rows })
  }

  pub(crate) fn write(&self, conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
      let marks = vec!["?"; self.columns].join(", ");
      let mut stmt = tx.prepare(&format!("INSERT INTO {} VALUES ({marks})", self.table))?;
      for row in &self.rows {
        stmt.execute(rusqlite::params_from_iter(row))?;
      }
    }
    tx.commit()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn temp_store(name: &str) -> EventStore {
    let path = std::env::temp_dir().join(format!("jle-test-{}-{name}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    EventStore::open(path).unwrap()
  }

  fn event(seq: i64) -> Value {
    json!({"id": format!("e{seq}"), "seq": seq, "at": "2026-11-19T10:00:00Z",
           "learnerId": "me", "language": "ja", "kind": "skip", "activityId": "a"})
  }

  #[test]
  fn upgrading_keeps_stored_content_and_its_protection() {
    let conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..2] {
      conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 2).unwrap();
    conn
      .execute(
        "INSERT INTO content (id, learner_id, created_at, source, payload) VALUES ('c1', 'me', '2026-11-20T00:00:00Z', 'generated', '{}')",
        [],
      )
      .unwrap();
    migrate(&conn).unwrap();
    let n: i64 = conn.query_row("SELECT count(*) FROM content WHERE id = 'c1'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    assert!(conn.execute("UPDATE content SET payload = 'x'", []).is_err());
    assert!(conn.execute("DELETE FROM content", []).is_err());
    conn
      .execute(
        "INSERT INTO content (id, learner_id, created_at, source, payload) VALUES ('l1', 'me', '2026-11-20T00:00:01Z', 'library', '{}')",
        [],
      )
      .unwrap();
    let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(v, MIGRATIONS.len() as i64);
  }

  #[test]
  fn upgrading_from_version_4_keeps_data_and_adds_protected_grades() {
    let conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..4] {
      conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 4).unwrap();
    conn
      .execute(
        "INSERT INTO interaction_event VALUES ('e1', 'me', 'ja', 1, '2026-11-20T00:00:00Z', 'skip', '{}')",
        [],
      )
      .unwrap();
    conn.execute("INSERT INTO content VALUES ('c1', 'me', 'now', 'library', NULL, NULL, '{}')", []).unwrap();
    conn.execute("INSERT INTO explanation VALUES ('k', 'now', 'v1', 'm', 'why')", []).unwrap();
    migrate(&conn).unwrap();
    let count = |t: &str| -> i64 { conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).unwrap() };
    assert_eq!((count("interaction_event"), count("content"), count("explanation"), count("grade")), (1, 1, 1, 0));
    conn.execute("INSERT INTO grade VALUES ('g1', 'me', 'a1', 'now', 'grade-1', 'm', '{}')", []).unwrap();
    assert!(conn.execute("UPDATE grade SET payload = 'x'", []).is_err());
    assert!(conn.execute("DELETE FROM grade", []).is_err());
    let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(v, MIGRATIONS.len() as i64);
  }

  #[test]
  fn appends_and_loads_in_seq_order() {
    let store = temp_store("order");
    store.append(&event(2)).unwrap();
    store.append(&event(1)).unwrap();
    let loaded = store.load("me").unwrap();
    assert_eq!(loaded, vec![event(1), event(2)]);
  }

  #[test]
  fn refuses_updates_deletes_and_duplicate_seq() {
    let store = temp_store("guards");
    store.append(&event(1)).unwrap();
    assert!(store.append(&json!({"id": "other", "seq": 1, "at": "x", "learnerId": "me", "language": "ja", "kind": "skip"})).is_err());
    assert!(store.conn.execute("UPDATE interaction_event SET kind = 'x'", []).is_err());
    assert!(store.conn.execute("DELETE FROM interaction_event", []).is_err());
  }

  #[test]
  fn kept_rows_survive_into_a_new_file() {
    let old = temp_store("keep-old");
    old
      .conn
      .execute(
        "INSERT INTO llm_call VALUES ('c1', 'now', 'generate', 'v1', 'm', NULL, 1, 2, 3, 4, 5, 'end_turn', NULL)",
        [],
      )
      .unwrap();
    let kept = KeptRows::read(&old.conn, "llm_call").unwrap();
    let mut new = temp_store("keep-new");
    kept.write(&mut new.conn).unwrap();
    let n: i64 = new.conn.query_row("SELECT output_tokens FROM llm_call WHERE id = 'c1'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 2);
  }

  #[test]
  fn reset_clears_events_content_and_grades_but_keeps_the_cost_log() {
    let mut store = temp_store("reset");
    store.append(&event(1)).unwrap();
    store
      .conn
      .execute("INSERT INTO content VALUES ('k', 'me', 'now', 'generated', 'v1', 'm', '{}')", [])
      .unwrap();
    store
      .conn
      .execute("INSERT INTO grade VALUES ('g', 'me', 'a', 'now', 'grade-1', 'm', '{}')", [])
      .unwrap();
    store
      .conn
      .execute(
        "INSERT INTO llm_call VALUES ('c1', 'now', 'generate', 'v1', 'm', NULL, 1, 2, 3, 4, 5, 'end_turn', NULL)",
        [],
      )
      .unwrap();
    reset(&mut store).unwrap();
    let count = |t: &str| -> i64 { store.conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).unwrap() };
    assert_eq!(count("interaction_event"), 0);
    assert_eq!(count("content"), 0);
    assert_eq!(count("grade"), 0);
    assert_eq!(count("llm_call"), 1);
    assert!(!store.path().with_extension("sqlite.new").exists());
  }
}
