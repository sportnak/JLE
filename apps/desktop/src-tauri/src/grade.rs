//! Stored grades of free writing (architecture §4.6). Immutable, like the event log, so replay reads the same
//! findings every time; the table and its triggers are created by the migrations in `events.rs`.

use crate::events::EventStore;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

pub(crate) fn put(conn: &Connection, grade: &Value) -> Result<(), String> {
  let field = |k: &str| {
    grade
      .get(k)
      .and_then(Value::as_str)
      .ok_or_else(|| format!("grade is missing `{k}`"))
  };
  conn
    .execute(
      "INSERT INTO grade (id, learner_id, activity_id, created_at, prompt_version, model, payload)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      params![
        field("id")?,
        field("learnerId")?,
        field("activityId")?,
        field("createdAt")?,
        field("promptVersion")?,
        field("model")?,
        grade.to_string()
      ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn load(conn: &Connection, learner_id: &str) -> rusqlite::Result<Vec<Value>> {
  let mut stmt =
    conn.prepare("SELECT payload FROM grade WHERE learner_id = ?1 ORDER BY created_at, rowid")?;
  let rows = stmt.query_map(params![learner_id], |row| row.get::<_, String>(0))?;
  rows
    .map(|r| r.map(|s| serde_json::from_str(&s).unwrap_or(Value::Null)))
    .collect()
}

type Store<'a> = State<'a, Mutex<EventStore>>;

#[tauri::command]
pub fn grade_put(store: Store, grade: Value) -> Result<(), String> {
  put(store.lock().unwrap().conn(), &grade)
}

#[tauri::command]
pub fn grade_load(store: Store, learner_id: String) -> Result<Vec<Value>, String> {
  load(store.lock().unwrap().conn(), &learner_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn temp_store(name: &str) -> EventStore {
    let path = std::env::temp_dir().join(format!("jle-test-{}-grade-{name}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    EventStore::open(path).unwrap()
  }

  fn grade(id: &str, at: &str) -> Value {
    json!({"id": id, "learnerId": "me", "activityId": format!("act-{id}"), "createdAt": at,
           "promptVersion": "grade-1", "model": "claude-opus-5-5", "answerText": "猫がいます。",
           "findings": [{"type": "particle", "quote": "が", "confidence": "high"}], "usedItems": []})
  }

  #[test]
  fn puts_and_loads_in_created_order() {
    let store = temp_store("order");
    put(store.conn(), &grade("b", "2026-11-20T10:00:00Z")).unwrap();
    put(store.conn(), &grade("a", "2026-11-19T10:00:00Z")).unwrap();
    put(store.conn(), &grade("c", "2026-11-20T10:00:00Z")).unwrap();
    let loaded = load(store.conn(), "me").unwrap();
    assert_eq!(
      loaded,
      vec![grade("a", "2026-11-19T10:00:00Z"), grade("b", "2026-11-20T10:00:00Z"), grade("c", "2026-11-20T10:00:00Z")]
    );
    assert!(load(store.conn(), "someone else").unwrap().is_empty());
  }

  #[test]
  fn refuses_duplicates_updates_deletes_and_missing_fields() {
    let store = temp_store("guards");
    put(store.conn(), &grade("a", "2026-11-19T10:00:00Z")).unwrap();
    assert!(put(store.conn(), &grade("a", "2026-11-20T10:00:00Z")).is_err());
    assert!(store.conn().execute("UPDATE grade SET payload = '{}'", []).is_err());
    assert!(store.conn().execute("DELETE FROM grade", []).is_err());
    for k in ["id", "learnerId", "activityId", "createdAt", "promptVersion", "model"] {
      let mut g = grade("x", "2026-11-21T00:00:00Z");
      g.as_object_mut().unwrap().remove(k);
      assert_eq!(put(store.conn(), &g), Err(format!("grade is missing `{k}`")));
    }
    assert_eq!(load(store.conn(), "me").unwrap(), vec![grade("a", "2026-11-19T10:00:00Z")]);
  }
}
