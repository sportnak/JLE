mod events;
mod voice;
mod voicevox;

use std::sync::Mutex;
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
      voicevox::start_if_needed(app.handle());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      events::events_load,
      events::events_append,
      events::events_reset,
      voice::speak,
      voice::voice_info,
      voice::voices,
      voice::voice_terms,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let RunEvent::Exit = event {
        voicevox::stop(app);
      }
    });
}
