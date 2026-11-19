//! The interaction log: append-only, the source of truth for all learner state.

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
"#];

pub struct EventStore {
  path: PathBuf,
  conn: Connection,
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

  fn load(&self, learner_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = self
      .conn
      .prepare("SELECT payload FROM interaction_event WHERE learner_id = ?1 ORDER BY seq")?;
    let rows = stmt.query_map(params![learner_id], |row| row.get::<_, String>(0))?;
    rows
      .map(|r| r.map(|s| serde_json::from_str(&s).unwrap_or(Value::Null)))
      .collect()
  }

  fn append(&self, event: &Value) -> Result<(), String> {
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
    self
      .conn
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
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
  let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
  for (i, sql) in (0i64..).zip(MIGRATIONS.iter()).skip(version as usize) {
    conn.execute_batch(sql)?;
    conn.pragma_update(None, "user_version", i + 1)?;
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

/// Starting over is the one way the log goes away: the whole file is replaced.
#[tauri::command]
pub fn events_reset(store: Store) -> Result<(), String> {
  let mut guard = store.lock().unwrap();
  let path = guard.path.clone();
  let fresh = path.with_extension("sqlite.new");
  let _ = std::fs::remove_file(&fresh);
  let next = EventStore::open(fresh.clone()).map_err(|e| e.to_string())?;
  drop(std::mem::replace(&mut *guard, next));
  for ext in ["sqlite", "sqlite-wal", "sqlite-shm"] {
    let _ = std::fs::remove_file(path.with_extension(ext));
  }
  drop(std::mem::replace(
    &mut *guard,
    EventStore::open(path.clone()).map_err(|e| e.to_string())?,
  ));
  let _ = std::fs::remove_file(&fresh);
  Ok(())
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
}
