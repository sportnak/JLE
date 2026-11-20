mod apikey;
mod content;
mod dictionary;
mod events;
mod explanation;
mod grade;
mod llm;
mod tokenizer;
mod voice;
mod voicevox;

use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      let dir = app.path().app_data_dir()?;
      std::fs::create_dir_all(&dir)?;
      let store = events::EventStore::open(dir.join("jle.sqlite"))?;
      log::info!("event store at {}", store.path().display());
      app.manage(Mutex::new(store));
      app.manage(voice::Voice::default());
      app.manage(voicevox::Engine::default());
      app.manage(Arc::new(tokenizer::Tokenizer::default()));
      app.manage(dictionary::Dictionary::default());
      voicevox::start_if_needed(app.handle());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      events::events_load,
      events::events_append,
      events::events_reset,
      voice::speak,
      voice::speak_sequence,
      voice::prepare_speech,
      voice::voice_info,
      voice::voices,
      voice::voice_terms,
      tokenizer::analyze,
      apikey::api_key_set,
      apikey::api_key_status,
      apikey::api_key_clear,
      llm::llm_call,
      llm::llm_usage,
      content::content_put,
      content::content_load,
      grade::grade_put,
      grade::grade_load,
      explanation::explanation_get,
      explanation::explanation_put,
      dictionary::dictionary_lookup,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let RunEvent::Exit = event {
        voicevox::stop(app);
      }
    });
}
