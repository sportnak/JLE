//! Stored explanations (architecture §5.1): written once from an approved fact sheet, reused by key. Immutable; the
//! table and its triggers are created by the migrations in `events.rs`.

use crate::events::EventStore;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::State;

fn get(conn: &Connection, key: &str) -> rusqlite::Result<Option<Value>> {
  conn
    .query_row(
      "SELECT key, created_at, prompt_version, model, text FROM explanation WHERE key = ?1",
      params![key],
      |r| {
        Ok(json!({
          "key": r.get::<_, String>(0)?,
          "createdAt": r.get::<_, String>(1)?,
          "promptVersion": r.get::<_, String>(2)?,
          "model": r.get::<_, String>(3)?,
          "text": r.get::<_, String>(4)?,
        }))
      },
    )
    .optional()
}

fn put(conn: &Connection, v: &Value) -> Result<(), String> {
  let field = |k: &str| v.get(k).and_then(Value::as_str).ok_or_else(|| format!("explanation is missing `{k}`"));
  conn
    .execute(
      "INSERT INTO explanation (key, created_at, prompt_version, model, text) VALUES (?1, ?2, ?3, ?4, ?5)",
      params![field("key")?, field("createdAt")?, field("promptVersion")?, field("model")?, field("text")?],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

type Store<'a> = State<'a, Mutex<EventStore>>;

#[tauri::command]
pub fn explanation_get(store: Store, key: String) -> Result<Option<Value>, String> {
  get(store.lock().unwrap().conn(), &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn explanation_put(store: Store, explanation: Value) -> Result<(), String> {
  put(store.lock().unwrap().conn(), &explanation)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn stored_once_read_back_never_changed() {
    let dir = std::env::temp_dir().join(format!("jle-expl-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = EventStore::open(dir.join("t.sqlite")).unwrap();
    let v = json!({"key": "wa-topic:v1:0:が", "createdAt": "2026-11-21T00:00:00Z", "promptVersion": "explain-1", "model": "claude-opus-5-5", "text": "は marks the topic."});
    assert!(get(store.conn(), "wa-topic:v1:0:が").unwrap().is_none());
    put(store.conn(), &v).unwrap();
    assert_eq!(get(store.conn(), "wa-topic:v1:0:が").unwrap().unwrap()["text"], "は marks the topic.");
    assert!(put(store.conn(), &v).is_err());
    assert!(store.conn().execute("UPDATE explanation SET text = 'x'", []).is_err());
    assert!(store.conn().execute("DELETE FROM explanation", []).is_err());
    std::fs::remove_dir_all(dir).ok();
  }
}
