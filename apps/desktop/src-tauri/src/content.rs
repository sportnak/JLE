//! Stored content (architecture §5.1): generated passages and learner texts. Immutable, like the event log;
//! the table and its triggers are created by the migrations in `events.rs`.

use crate::events::EventStore;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

fn put(conn: &Connection, content: &Value) -> Result<(), String> {
  let field = |k: &str| {
    content
      .get(k)
      .and_then(Value::as_str)
      .ok_or_else(|| format!("content is missing `{k}`"))
  };
  let optional = |k: &str| content.get(k).and_then(Value::as_str);
  conn
    .execute(
      "INSERT INTO content (id, learner_id, created_at, source, prompt_version, model, payload)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      params![
        field("id")?,
        field("learnerId")?,
        field("createdAt")?,
        field("source")?,
        optional("promptVersion"),
        optional("model"),
        content.to_string()
      ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn load(conn: &Connection, learner_id: &str) -> rusqlite::Result<Vec<Value>> {
  let mut stmt =
    conn.prepare("SELECT payload FROM content WHERE learner_id = ?1 ORDER BY created_at, rowid")?;
  let rows = stmt.query_map(params![learner_id], |row| row.get::<_, String>(0))?;
  rows
    .map(|r| r.map(|s| serde_json::from_str(&s).unwrap_or(Value::Null)))
    .collect()
}

type Store<'a> = State<'a, Mutex<EventStore>>;

#[tauri::command]
pub fn content_put(store: Store, content: Value) -> Result<(), String> {
  put(store.lock().unwrap().conn(), &content)
}

#[tauri::command]
pub fn content_load(store: Store, learner_id: String) -> Result<Vec<Value>, String> {
  load(store.lock().unwrap().conn(), &learner_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn temp_store(name: &str) -> EventStore {
    let path = std::env::temp_dir().join(format!("jle-test-{}-content-{name}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    EventStore::open(path).unwrap()
  }

  fn passage(id: &str, at: &str) -> Value {
    json!({"id": id, "learnerId": "me", "createdAt": at, "source": "generated",
           "promptVersion": "generate-v1", "model": "claude-opus-5-5", "text": "猫がいます。"})
  }

  #[test]
  fn puts_and_loads_in_created_order() {
    let store = temp_store("order");
    put(store.conn(), &passage("b", "2026-11-20T10:00:00Z")).unwrap();
    put(store.conn(), &passage("a", "2026-11-19T10:00:00Z")).unwrap();
    let learner = json!({"id": "c", "learnerId": "me", "createdAt": "2026-11-21T00:00:00Z", "source": "learner"});
    put(store.conn(), &learner).unwrap();
    let loaded = load(store.conn(), "me").unwrap();
    assert_eq!(loaded, vec![passage("a", "2026-11-19T10:00:00Z"), passage("b", "2026-11-20T10:00:00Z"), learner]);
    assert!(load(store.conn(), "someone else").unwrap().is_empty());
  }

  #[test]
  fn refuses_duplicates_updates_deletes_and_bad_rows() {
    let store = temp_store("guards");
    put(store.conn(), &passage("a", "2026-11-19T10:00:00Z")).unwrap();
    assert!(put(store.conn(), &passage("a", "2026-11-20T10:00:00Z")).is_err());
    assert!(store.conn().execute("UPDATE content SET payload = '{}'", []).is_err());
    assert!(store.conn().execute("DELETE FROM content", []).is_err());
    assert!(put(store.conn(), &json!({"id": "x", "learnerId": "me", "createdAt": "t"})).is_err());
    let wrong_source = json!({"id": "y", "learnerId": "me", "createdAt": "t", "source": "web"});
    assert!(put(store.conn(), &wrong_source).is_err());
  }
}
