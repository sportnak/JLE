//! The reference dictionary (architecture §5.2): `reference.sqlite` from `packages/reference`, bundled as an app
//! resource and opened read-only on first use. `JLE_REFERENCE_DB` overrides the path; debug builds also look in
//! the repo, so `cargo run` works without a bundle.

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupKey {
  pub lemma: String,
  pub reading: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryRow {
  pub id: i64,
  /// The reading when the word is usually written in kana.
  pub written: String,
  pub reading: String,
  pub freq_rank: Option<i64>,
  /// Part of speech of the first sense that applies.
  pub pos: Vec<String>,
  /// One string per sense, first three.
  pub gloss: Vec<String>,
}

/// Opened once. A missing file is not cached, so building the database works without a restart.
#[derive(Default)]
pub struct Dictionary(Mutex<Option<Connection>>);

fn repo_copy() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/reference/out/reference.sqlite")
}

fn locate(app: &AppHandle) -> Option<PathBuf> {
  if let Some(p) = std::env::var_os("JLE_REFERENCE_DB") {
    return Some(PathBuf::from(p));
  }
  let bundled = app.path().resolve("reference.sqlite", BaseDirectory::Resource).ok();
  let dev = cfg!(debug_assertions).then(repo_copy);
  bundled.into_iter().chain(dev).find(|p| p.is_file())
}

pub fn open(path: &std::path::Path) -> Result<Connection, String> {
  Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
    .map_err(|e| format!("Could not open the dictionary at {}: {e}", path.display()))
}

fn hiragana(s: &str) -> String {
  s.chars()
    .map(|c| match c {
      'ァ'..='ヶ' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
      _ => c,
    })
    .collect()
}

struct Candidate {
  id: i64,
  rank: Option<i64>,
  priority: bool,
  primary_form: bool,
}

/// Entries with a form spelled `lemma` and, when `reading` is given, a kana form read that way that is valid for
/// that spelling. Mirrors the candidate query in `packages/reference/scripts/slice.ts`, plus katakana folding.
fn candidates(conn: &Connection, lemma: &str, reading: Option<&str>) -> rusqlite::Result<Vec<Candidate>> {
  let mut forms = conn.prepare_cached(
    "SELECT e.id, e.freq_rank, e.priority, w.is_primary, w.kind
     FROM form w JOIN entry e ON e.id = w.entry_id WHERE w.text = ?1",
  )?;
  let mut kana = conn.prepare_cached("SELECT text, restr FROM form WHERE entry_id = ?1 AND kind = 'kana'")?;
  let want = reading.map(hiragana);
  let mut by_id: BTreeMap<i64, Candidate> = BTreeMap::new();
  let rows = forms.query_map([lemma], |r| {
    Ok((
      r.get::<_, i64>(0)?,
      r.get::<_, Option<i64>>(1)?,
      r.get::<_, String>(2)?,
      r.get::<_, i64>(3)? == 1,
      r.get::<_, String>(4)? == "kana",
    ))
  })?;
  for row in rows {
    let (id, rank, priority, primary, lemma_is_kana) = row?;
    if let Some(want) = &want {
      let mut ok = false;
      for k in kana.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))? {
        let (text, restr) = k?;
        let valid = lemma_is_kana
          || match restr {
            None => true,
            Some(json) => serde_json::from_str::<Vec<String>>(&json).is_ok_and(|v| v.iter().any(|t| t == lemma)),
          };
        if valid && hiragana(&text) == *want {
          ok = true;
          break;
        }
      }
      if !ok {
        continue;
      }
    }
    let c = by_id.entry(id).or_insert(Candidate { id, rank, priority: !priority.is_empty(), primary_form: false });
    c.primary_form |= primary;
  }
  Ok(by_id.into_values().collect())
}

/// Ranked first, then marked common in JMdict, then the primary form, then lowest id (`pickEntry` in slice.ts).
fn pick(cands: Vec<Candidate>) -> Option<i64> {
  cands
    .into_iter()
    .min_by_key(|c| (c.rank.unwrap_or(i64::MAX), !c.priority, !c.primary_form, c.id))
    .map(|c| c.id)
}

fn entry(conn: &Connection, id: i64) -> rusqlite::Result<Option<EntryRow>> {
  let mut stmt =
    conn.prepare_cached("SELECT id, written, reading, kana_only, freq_rank, pos, gloss FROM entry WHERE id = ?1")?;
  stmt
    .query_row([id], |r| {
      let list = |i| r.get::<_, String>(i).map(|s| serde_json::from_str::<Vec<String>>(&s).unwrap_or_default());
      let reading: String = r.get(2)?;
      let kana_only = r.get::<_, i64>(3)? == 1;
      Ok(EntryRow {
        id: r.get(0)?,
        written: if kana_only { reading.clone() } else { r.get(1)? },
        reading,
        freq_rank: r.get(4)?,
        pos: list(5)?,
        gloss: list(6)?.into_iter().take(3).collect(),
      })
    })
    .optional()
}

pub fn lookup(conn: &Connection, key: &LookupKey) -> rusqlite::Result<Option<EntryRow>> {
  let reading = key.reading.as_deref().filter(|r| !r.is_empty());
  let mut found = pick(candidates(conn, &key.lemma, reading)?);
  if found.is_none() && reading.is_some() {
    found = pick(candidates(conn, &key.lemma, None)?);
  }
  match found {
    Some(id) => entry(conn, id),
    None => Ok(None),
  }
}

#[tauri::command]
pub fn dictionary_lookup(
  app: AppHandle,
  dict: State<'_, Dictionary>,
  keys: Vec<LookupKey>,
) -> Result<Vec<Option<EntryRow>>, String> {
  let mut slot = dict.0.lock().map_err(|e| e.to_string())?;
  if slot.is_none() {
    let path = locate(&app).ok_or(
      "The dictionary (reference.sqlite) is missing. Build it with `pnpm --filter @jle/reference run fetch` and \
       `pnpm --filter @jle/reference build:db`, then rebuild the app.",
    )?;
    log::info!("dictionary at {}", path.display());
    *slot = Some(open(&path)?);
  }
  let conn = slot.as_ref().expect("opened above");
  keys.iter().map(|k| lookup(conn, k).map_err(|e| e.to_string())).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The real database, or a note and an early return when it has not been built.
  macro_rules! need_db {
    () => {{
      let path = repo_copy();
      if !path.is_file() {
        eprintln!("skipping: {} not built (pnpm --filter @jle/reference build:db)", path.display());
        return;
      }
      open(&path).unwrap()
    }};
  }

  fn key(lemma: &str, reading: Option<&str>) -> LookupKey {
    LookupKey { lemma: lemma.into(), reading: reading.map(String::from) }
  }

  #[test]
  fn folds_katakana() {
    assert_eq!(hiragana("イカとたこ"), "いかとたこ");
    assert_eq!(hiragana("ヴァー"), "ゔぁー");
  }

  #[test]
  fn picks_ranked_then_common_then_primary_then_lowest_id() {
    let c = |id, rank, priority, primary_form| Candidate { id, rank, priority, primary_form };
    assert_eq!(pick(vec![c(1, None, true, true), c(2, Some(500), false, false)]), Some(2));
    assert_eq!(pick(vec![c(1, None, false, true), c(2, None, true, false)]), Some(2));
    assert_eq!(pick(vec![c(1, None, false, false), c(2, None, false, true)]), Some(2));
    assert_eq!(pick(vec![c(3, None, false, false), c(2, None, false, false)]), Some(2));
    assert_eq!(pick(vec![]), None);
  }

  #[test]
  fn finds_common_words_by_lemma_and_reading() {
    let conn = need_db!();
    let taberu = lookup(&conn, &key("食べる", Some("たべる"))).unwrap().expect("食べる");
    assert_eq!(taberu.reading, "たべる");
    assert_eq!(taberu.written, "食べる");
    assert!(taberu.pos.iter().any(|p| p == "v1"), "{:?}", taberu.pos);
    assert!(taberu.gloss.iter().any(|g| g.contains("eat")), "{:?}", taberu.gloss);
    let miru = lookup(&conn, &key("見る", Some("みる"))).unwrap().expect("見る");
    assert_eq!(miru.reading, "みる");
    assert!(miru.freq_rank.is_some());
    let nihon = lookup(&conn, &key("日本", Some("にほん"))).unwrap().expect("日本");
    assert_eq!((nihon.written.as_str(), nihon.reading.as_str()), ("日本", "にほん"));
    let katakana = lookup(&conn, &key("日本", Some("ニホン"))).unwrap().expect("日本 in katakana");
    assert_eq!(katakana.id, nihon.id);
  }

  #[test]
  fn falls_back_to_the_lemma_and_misses_cleanly() {
    let conn = need_db!();
    let alone = lookup(&conn, &key("食べる", None)).unwrap().expect("lemma only");
    let wrong = lookup(&conn, &key("食べる", Some("くう"))).unwrap().expect("reading that does not fit");
    assert_eq!(alone.id, wrong.id);
    assert_eq!(lookup(&conn, &key("ほげほげ語", Some("ほげ"))).unwrap(), None);
    assert_eq!(lookup(&conn, &key("", None)).unwrap(), None);
  }

  #[test]
  fn opens_read_only() {
    let conn = need_db!();
    assert!(conn.execute("DELETE FROM meta", []).is_err());
  }
}
