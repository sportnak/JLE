//! Sudachi morphological analysis (architecture §6.1). The system dictionary is installed outside the app,
//! like VOICEVOX: the newest `<root>/<version>/system_core.dic`, where root is
//! `~/Library/Application Support/jle-sudachi` unless `JLE_SUDACHI_DIR` says otherwise.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use sudachi::analysis::stateful_tokenizer::StatefulTokenizer;
use sudachi::config::Config;
use sudachi::dic::dictionary::JapaneseDictionary;
use sudachi::prelude::{Mode, MorphemeList, MorphemeView};
use sudachi::sentence_splitter::{SentenceSplitter, SplitSentences};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Token {
  pub surface: String,
  pub dictionary_form: String,
  pub normalized_form: String,
  /// Hiragana, as written in the text (食べ → たべ).
  pub reading: String,
  /// Hiragana reading of the dictionary form (食べ → たべる), for dictionary lookup.
  pub dictionary_reading: String,
  /// Sudachi's six part-of-speech levels; levels 5 and 6 are conjugation type and form, or `*`.
  pub pos: Vec<String>,
  /// Character offsets into the input.
  pub begin: usize,
  pub end: usize,
  /// Not in the dictionary: Sudachi guessed its boundaries.
  pub oov: bool,
}

/// Loaded once, on first use. A missing dictionary is not cached, so installing it works without a restart.
#[derive(Default)]
pub struct Tokenizer(Mutex<Option<Arc<JapaneseDictionary>>>);

impl Tokenizer {
  fn dictionary(&self) -> Result<Arc<JapaneseDictionary>, String> {
    let mut slot = self.0.lock().map_err(|e| e.to_string())?;
    if let Some(d) = slot.as_ref() {
      return Ok(d.clone());
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
    let path = find_dictionary(&home).ok_or(
      "The Sudachi dictionary is not installed. Put system_core.dic in ~/Library/Application Support/jle-sudachi/<version>/.",
    )?;
    let d = Arc::new(load(&path)?);
    *slot = Some(d.clone());
    Ok(d)
  }

  pub fn analyze(&self, text: &str, mode: Mode) -> Result<Vec<Token>, String> {
    analyze_with(&self.dictionary()?, text, mode)
  }
}

pub fn load(path: &Path) -> Result<JapaneseDictionary, String> {
  let config = Config::new(None, None, Some(path.to_path_buf())).map_err(|e| e.to_string())?;
  JapaneseDictionary::from_cfg(&config).map_err(|e| e.to_string())
}

/// The newest `<root>/<version>/system_core.dic`, versions compared as numbers (SudachiDict uses dates).
pub fn find_dictionary(home: &Path) -> Option<PathBuf> {
  let root = std::env::var_os("JLE_SUDACHI_DIR")
    .map(PathBuf::from)
    .unwrap_or_else(|| home.join("Library/Application Support/jle-sudachi"));
  newest_in(&root)
}

fn newest_in(root: &Path) -> Option<PathBuf> {
  let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(&root)
    .ok()?
    .filter_map(|e| e.ok())
    .filter_map(|e| {
      let dic = e.path().join("system_core.dic");
      let name = e.file_name().into_string().ok()?;
      let parts = name.split('.').map(|p| p.parse::<u64>().ok()).collect::<Option<Vec<_>>>()?;
      dic.is_file().then_some((parts, dic))
    })
    .collect();
  versions.sort();
  versions.pop().map(|(_, p)| p)
}

/// Katakana to hiragana. ー and the rarer ヷ–ヺ have no hiragana and are kept.
pub fn to_hiragana(s: &str) -> String {
  s.chars()
    .map(|c| match c {
      'ァ'..='ヶ' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
      'ヽ' | 'ヾ' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
      _ => c,
    })
    .collect()
}

/// Tokenizes sentence by sentence (Sudachi limits input length), keeping offsets relative to the whole text.
pub fn analyze_with(dict: &Arc<JapaneseDictionary>, text: &str, mode: Mode) -> Result<Vec<Token>, String> {
  let mut tokenizer = StatefulTokenizer::create(dict.clone(), false, mode);
  let mut morphemes = MorphemeList::empty(dict.clone());
  let splitter = SentenceSplitter::new().with_checker(dict.lexicon());
  let mut out = Vec::new();
  for (range, sentence) in splitter.split(text) {
    let offset = text[..range.start].chars().count();
    tokenizer.reset().push_str(sentence);
    tokenizer.do_tokenize().map_err(|e| e.to_string())?;
    morphemes.collect_results(&mut tokenizer).map_err(|e| e.to_string())?;
    for m in morphemes.iter() {
      let dictionary_reading = match m.dictionary_form_morpheme() {
        Ok(d) => to_hiragana(d.reading_form()),
        Err(_) => to_hiragana(m.reading_form()),
      };
      out.push(Token {
        dictionary_reading,
        surface: m.surface().to_string(),
        dictionary_form: m.dictionary_form().to_string(),
        normalized_form: m.normalized_form().to_string(),
        reading: to_hiragana(m.reading_form()),
        pos: m.part_of_speech().to_vec(),
        begin: offset + m.begin_c(),
        end: offset + m.end_c(),
        oov: m.is_oov(),
      });
    }
  }
  Ok(out)
}

fn mode_of(mode: Option<&str>) -> Result<Mode, String> {
  match mode.unwrap_or("C") {
    "A" => Ok(Mode::A),
    "B" => Ok(Mode::B),
    "C" => Ok(Mode::C),
    other => Err(format!("Unknown split mode {other}")),
  }
}

#[tauri::command]
pub async fn analyze(state: tauri::State<'_, Arc<Tokenizer>>, text: String, mode: Option<String>) -> Result<Vec<Token>, String> {
  let mode = mode_of(mode.as_deref())?;
  let tokenizer = state.inner().clone();
  tauri::async_runtime::spawn_blocking(move || tokenizer.analyze(&text, mode))
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::OnceLock;
  use std::time::Instant;

  fn dict() -> Option<Arc<JapaneseDictionary>> {
    static D: OnceLock<Option<Arc<JapaneseDictionary>>> = OnceLock::new();
    D.get_or_init(|| {
      let home = PathBuf::from(std::env::var_os("HOME")?);
      let path = find_dictionary(&home)?;
      let t = Instant::now();
      let d = load(&path).ok()?;
      eprintln!("loaded {} in {:?}", path.display(), t.elapsed());
      Some(Arc::new(d))
    })
    .clone()
  }

  macro_rules! need_dict {
    () => {
      match dict() {
        Some(d) => d,
        None => {
          eprintln!("Sudachi dictionary not installed; skipping");
          return;
        }
      }
    };
  }

  #[test]
  fn hiragana_conversion() {
    assert_eq!(to_hiragana("タベル"), "たべる");
    assert_eq!(to_hiragana("ヴァイオリン"), "ゔぁいおりん");
    assert_eq!(to_hiragana("コーヒー"), "こーひー");
    assert_eq!(to_hiragana("カ月"), "か月");
  }

  #[test]
  fn modes_parse() {
    assert!(matches!(mode_of(None), Ok(Mode::C)));
    assert!(matches!(mode_of(Some("A")), Ok(Mode::A)));
    assert!(mode_of(Some("X")).is_err());
  }

  #[test]
  fn lemmas_readings_and_offsets() {
    let d = need_dict!();
    let text = "昨日、友だちと映画を見ました。";
    let tokens = analyze_with(&d, text, Mode::C).unwrap();
    let mi = tokens.iter().find(|t| t.surface == "見").expect("見 token");
    assert_eq!(mi.dictionary_form, "見る");
    assert_eq!(mi.reading, "み");
    assert_eq!(mi.pos[0], "動詞");
    let tomo = tokens.iter().find(|t| t.surface == "友だち").expect("友だち token");
    assert_eq!(tomo.normalized_form, "友達");
    assert_eq!(tomo.reading, "ともだち");
    let chars: Vec<char> = text.chars().collect();
    for t in &tokens {
      assert_eq!(chars[t.begin..t.end].iter().collect::<String>(), t.surface);
    }
  }

  #[test]
  fn offsets_span_sentences() {
    let d = need_dict!();
    let text = "猫が好きです。犬も好きです。";
    let tokens = analyze_with(&d, text, Mode::C).unwrap();
    let inu = tokens.iter().find(|t| t.surface == "犬").expect("犬");
    assert_eq!(inu.begin, 7);
  }

  #[test]
  fn inflected_forms_give_the_dictionary_form() {
    let d = need_dict!();
    let tokens = analyze_with(&d, "食べられなかった", Mode::C).unwrap();
    assert_eq!(tokens[0].dictionary_form, "食べる");
    assert_eq!(tokens[0].dictionary_reading, "たべる");
    assert_eq!(tokens[0].reading, "たべ");
    assert!(tokens[0].pos[4].starts_with("下一段"), "{:?}", tokens[0].pos);
  }

  #[test]
  fn speed_on_a_long_text() {
    let d = need_dict!();
    let text = "昨日、友だちと駅の近くの新しい映画館で映画を見ました。とても面白かったです。".repeat(55);
    let t = Instant::now();
    let tokens = analyze_with(&d, &text, Mode::C).unwrap();
    eprintln!("{} chars, {} tokens in {:?}", text.chars().count(), tokens.len(), t.elapsed());
    assert!(tokens.len() > 500);
  }

  #[test]
  fn finds_the_newest_version() {
    let root = std::env::temp_dir().join(format!("jle-sudachi-test-{}", std::process::id()));
    for v in ["20240109", "20261015", "notes"] {
      std::fs::create_dir_all(root.join(v)).unwrap();
      std::fs::write(root.join(v).join("system_core.dic"), b"").unwrap();
    }
    let found = newest_in(&root);
    assert_eq!(found, Some(root.join("20261015").join("system_core.dic")));
    std::fs::remove_dir_all(root).ok();
  }
}
