//! Export and import of learner progress: the event log plus every stored output (passages, grades, explanations),
//! so another machine rebuilds exactly the same state without calling the model. One JSON file, log-centred, which
//! is also the unit a later sync service would move. Import replaces this machine's data after copying it aside.

use crate::events::{EventStore, KeptRows};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

pub const FORMAT: &str = "jle-progress";
pub const VERSION: i64 = 1;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
  pub events: usize,
  pub content: usize,
  pub grades: usize,
  pub explanations: usize,
  /// Export: the file written. Import: where this machine's previous data was copied.
  pub path: String,
}

fn payloads(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<Value>> {
  let mut stmt = conn.prepare(sql)?;
  let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
  rows.map(|r| r.map(|s| serde_json::from_str(&s).unwrap_or(Value::Null))).collect()
}

fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
  conn.pragma_query_value(None, "user_version", |r| r.get(0))
}

/// Everything that makes up progress, every learner, in insertion order. The cost log stays on each machine.
pub fn export_value(conn: &Connection, exported_at: &str) -> rusqlite::Result<Value> {
  let explanations = {
    let mut stmt = conn.prepare("SELECT key, created_at, prompt_version, model, text FROM explanation ORDER BY rowid")?;
    let rows = stmt.query_map([], |r| {
      Ok(json!({
        "key": r.get::<_, String>(0)?,
        "createdAt": r.get::<_, String>(1)?,
        "promptVersion": r.get::<_, String>(2)?,
        "model": r.get::<_, String>(3)?,
        "text": r.get::<_, String>(4)?,
      }))
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()?
  };
  Ok(json!({
    "format": FORMAT,
    "version": VERSION,
    "schemaVersion": schema_version(conn)?,
    "exportedAt": exported_at,
    "events": payloads(conn, "SELECT payload FROM interaction_event ORDER BY learner_id, seq")?,
    "content": payloads(conn, "SELECT payload FROM content ORDER BY created_at, rowid")?,
    "grades": payloads(conn, "SELECT payload FROM grade ORDER BY created_at, rowid")?,
    "explanations": explanations,
  }))
}

fn list<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
  v.get(key).and_then(Value::as_array).ok_or_else(|| format!("The file has no `{key}` list."))
}

/// Checks the file and writes it into a fresh database at `target`, through the same inserts live data uses, so
/// every append-only rule and uniqueness check applies. Returns the counts. On error `target` should be discarded.
pub fn build(v: &Value, target: &Path, current_schema: i64) -> Result<Summary, String> {
  if v.get("format").and_then(Value::as_str) != Some(FORMAT) {
    return Err("This is not a progress file from this app.".into());
  }
  let version = v.get("version").and_then(Value::as_i64).unwrap_or(0);
  if version < 1 || version > VERSION {
    return Err(format!("This progress file is format version {version}; this app reads version {VERSION}. Update the app first."));
  }
  let schema = v.get("schemaVersion").and_then(Value::as_i64).unwrap_or(0);
  if schema > current_schema {
    return Err("This progress file comes from a newer version of the app. Update the app on this Mac first.".into());
  }
  let (events, content, grades, explanations) = (list(v, "events")?, list(v, "content")?, list(v, "grades")?, list(v, "explanations")?);
  let mut store = EventStore::open(target.to_path_buf()).map_err(|e| e.to_string())?;
  let tx = store.conn.transaction().map_err(|e| e.to_string())?;
  {
    for (i, e) in events.iter().enumerate() {
      crate::events::insert(&tx, e).map_err(|err| format!("Event {}: {err}", i + 1))?;
    }
    for (i, c) in content.iter().enumerate() {
      crate::content::put(&tx, c).map_err(|err| format!("Passage {}: {err}", i + 1))?;
    }
    for (i, g) in grades.iter().enumerate() {
      crate::grade::put(&tx, g).map_err(|err| format!("Grade {}: {err}", i + 1))?;
    }
    for (i, x) in explanations.iter().enumerate() {
      crate::explanation::put(&tx, x).map_err(|err| format!("Explanation {}: {err}", i + 1))?;
    }
  }
  tx.commit().map_err(|e| e.to_string())?;
  // Fold the write-ahead log into the file, so it is complete on its own.
  store.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").map_err(|e| e.to_string())?;
  Ok(Summary { events: events.len(), content: content.len(), grades: grades.len(), explanations: explanations.len(), path: String::new() })
}

fn stamp() -> String {
  let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
  format!("{secs}")
}

fn remove_db(path: &Path) {
  for ext in ["", "-wal", "-shm"] {
    let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
  }
}

/// Replaces the live database with the one built at `fresh`, after copying the live one to `backup`. The cost log
/// (`llm_call`) is carried over: it is this machine's spending, not learner progress.
pub fn swap(guard: &mut EventStore, fresh: &Path, backup: &Path) -> Result<(), String> {
  let kept = KeptRows::read(&guard.conn, "llm_call").map_err(|e| e.to_string())?;
  guard.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").map_err(|e| e.to_string())?;
  if let Some(dir) = backup.parent() {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  std::fs::copy(&guard.path, backup).map_err(|e| format!("Could not copy the current data aside: {e}"))?;
  let live = guard.path.clone();
  // Point the store at the new file so the live one is closed, copy the new file into place, then reopen it.
  drop(std::mem::replace(guard, EventStore::open(fresh.to_path_buf()).map_err(|e| e.to_string())?));
  remove_db(&live);
  guard.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").map_err(|e| e.to_string())?;
  std::fs::copy(fresh, &live).map_err(|e| format!("Could not put the imported data in place: {e}"))?;
  drop(std::mem::replace(guard, EventStore::open(live).map_err(|e| e.to_string())?));
  remove_db(fresh);
  kept.write(&mut guard.conn).map_err(|e| e.to_string())
}

type Store<'a> = State<'a, Mutex<EventStore>>;

/// Writes every learner's progress to `path` (chosen by the learner in a save dialog).
#[tauri::command]
pub fn export_progress(store: Store, path: String, exported_at: String) -> Result<Summary, String> {
  let guard = store.lock().unwrap();
  let v = export_value(&guard.conn, &exported_at).map_err(|e| e.to_string())?;
  let count = |k: &str| v[k].as_array().map_or(0, Vec::len);
  let tmp = PathBuf::from(format!("{path}.partial"));
  std::fs::write(&tmp, serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
  Ok(Summary { events: count("events"), content: count("content"), grades: count("grades"), explanations: count("explanations"), path })
}

/// Replaces this machine's progress with the file at `path`. The file is checked by building a complete database
/// from it first; only then is the current data copied to a backup and swapped out. A bad file changes nothing.
#[tauri::command]
pub fn import_progress(store: Store, path: String) -> Result<Summary, String> {
  let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read the file: {e}"))?;
  let v: Value = serde_json::from_str(&text).map_err(|_| "The file is not valid JSON.".to_string())?;
  let mut guard = store.lock().unwrap();
  let current = schema_version(&guard.conn).map_err(|e| e.to_string())?;
  let live = guard.path.clone();
  let fresh = live.with_extension("sqlite.import");
  remove_db(&fresh);
  let mut summary = match build(&v, &fresh, current) {
    Ok(s) => s,
    Err(e) => {
      remove_db(&fresh);
      return Err(e);
    }
  };
  let backup = live
    .parent()
    .unwrap_or(Path::new("."))
    .join("backups")
    .join(format!("jle-before-import-{}.sqlite", stamp()));
  swap(&mut guard, &fresh, &backup)?;
  summary.path = backup.display().to_string();
  Ok(summary)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("jle-backup-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
  }

  fn event(seq: i64, kind: &str) -> Value {
    json!({"id": format!("e{seq}"), "seq": seq, "at": "2026-11-22T00:00:00Z", "learnerId": "local", "language": "ja", "kind": kind, "sessionId": "s"})
  }

  fn filled(path: PathBuf) -> EventStore {
    let store = EventStore::open(path).unwrap();
    for (i, k) in ["session_started", "activity_started", "answer"].iter().enumerate() {
      store.append(&event(i as i64 + 1, k)).unwrap();
    }
    crate::content::put(store.conn(), &json!({"id": "c1", "learnerId": "local", "createdAt": "2026-11-22T00:00:00Z", "source": "library", "text": "私は学生です。"})).unwrap();
    crate::grade::put(store.conn(), &json!({"id": "g1", "learnerId": "local", "activityId": "a1", "createdAt": "2026-11-22T00:00:01Z", "promptVersion": "grade-1", "model": "claude-opus-5-5", "answer": "x"})).unwrap();
    crate::explanation::put(store.conn(), &json!({"key": "wa-topic:v1:0:が", "createdAt": "2026-11-22T00:00:02Z", "promptVersion": "explain-1", "model": "claude-opus-5-5", "text": "は marks the topic."})).unwrap();
    store
  }

  #[test]
  fn export_then_import_gives_the_same_progress_and_keeps_the_old_data_aside() {
    let d = dir("roundtrip");
    let source = filled(d.join("a.sqlite"));
    let exported = export_value(source.conn(), "2026-11-22T01:00:00Z").unwrap();
    assert_eq!(exported["format"], FORMAT);
    assert_eq!(exported["events"].as_array().unwrap().len(), 3);

    // The other machine has its own progress and some cost history.
    let mut other = EventStore::open(d.join("b.sqlite")).unwrap();
    other.append(&event(1, "session_started")).unwrap();
    other
      .conn
      .execute(
        "INSERT INTO llm_call VALUES ('c', 't', 'generate', 'reading-2', 'claude-opus-5-5', NULL, 1, 2, 0, 0, 5, 'end_turn', NULL)",
        [],
      )
      .unwrap();
    let schema = schema_version(&other.conn).unwrap();
    let fresh = d.join("b.sqlite.import");
    let summary = build(&exported, &fresh, schema).unwrap();
    assert_eq!((summary.events, summary.content, summary.grades, summary.explanations), (3, 1, 1, 1));
    let backup = d.join("backups").join("before.sqlite");
    swap(&mut other, &fresh, &backup).unwrap();

    let again = export_value(&other.conn, "2026-11-22T01:00:00Z").unwrap();
    for k in ["events", "content", "grades", "explanations"] {
      assert_eq!(again[k], exported[k], "{k}");
    }
    let calls: i64 = other.conn.query_row("SELECT count(*) FROM llm_call", [], |r| r.get(0)).unwrap();
    assert_eq!(calls, 1, "the cost log stays on its machine");
    let old = Connection::open(&backup).unwrap();
    let n: i64 = old.query_row("SELECT count(*) FROM interaction_event", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1, "the replaced progress is in the backup");
    assert!(!fresh.exists());
    // Still append-only after the swap.
    assert!(other.conn.execute("DELETE FROM interaction_event", []).is_err());
    std::fs::remove_dir_all(d).ok();
  }

  #[test]
  fn a_bad_file_changes_nothing() {
    let d = dir("bad");
    let fresh = d.join("x.sqlite.import");
    assert!(build(&json!({"format": "other"}), &fresh, 5).unwrap_err().contains("not a progress file"));
    assert!(build(&json!({"format": FORMAT, "version": 2}), &fresh, 5).unwrap_err().contains("version 2"));
    assert!(build(&json!({"format": FORMAT, "version": 1, "schemaVersion": 99, "events": [], "content": [], "grades": [], "explanations": []}), &fresh, 5)
      .unwrap_err()
      .contains("newer version"));
    let dup = json!({"format": FORMAT, "version": 1, "schemaVersion": 1, "events": [event(1, "a"), event(1, "b")], "content": [], "grades": [], "explanations": []});
    assert!(build(&dup, &fresh, 5).unwrap_err().starts_with("Event 2"));
    std::fs::remove_dir_all(d).ok();
  }
}
