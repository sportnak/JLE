//! Japanese speech. The lesson voice is a local VOICEVOX engine; the system voice (Kyoko on macOS)
//! is the fallback while VOICEVOX is not running. Clips are cached on disk by their full request.

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const VOICEVOX_URL: &str = "http://127.0.0.1:50021"; // matches voicevox::HOST and PORT
/// 四国めたん (ノーマル), used until a voice is chosen in Settings.
const DEFAULT_SPEAKER: u32 = 2;

#[derive(Default)]
pub struct Voice(Mutex<Option<Child>>);

#[derive(serde::Serialize)]
pub struct Spoken {
  engine: &'static str,
}

#[tauri::command]
pub async fn speak(
  app: AppHandle,
  voice: State<'_, Voice>,
  text: String,
  speaker: Option<u32>,
  speed: Option<f32>,
) -> Result<Spoken, String> {
  let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("audio");
  let request = text.clone();
  let speaker = speaker.unwrap_or(DEFAULT_SPEAKER);
  let speed = clamp_speed(speed);
  let rendered = tauri::async_runtime::spawn_blocking(move || voicevox_clip(&cache, &request, speaker, speed))
    .await
    .map_err(|e| e.to_string())?;

  let mut current = voice.0.lock().unwrap();
  if let Some(mut child) = current.take() {
    let _ = child.kill();
  }
  match rendered {
    Ok(clip) => {
      *current = Some(play(&clip)?);
      Ok(Spoken { engine: "voicevox" })
    }
    Err(reason) => {
      log::info!("VOICEVOX unavailable ({reason}); using the system voice");
      *current = Some(system_voice(&text, speed)?);
      Ok(Spoken { engine: "system" })
    }
  }
}

/// Renders (or reuses) a VOICEVOX clip for `text`. Pass kana to force a reading.
/// Speech speed, 1.0 = normal. Kept within what stays intelligible.
fn clamp_speed(speed: Option<f32>) -> f32 {
  speed.filter(|s| s.is_finite()).unwrap_or(1.0).clamp(0.5, 1.5)
}

fn voicevox_clip(cache: &Path, text: &str, speaker: u32, speed: f32) -> Result<PathBuf, String> {
  let pct = (speed * 100.0).round() as u32;
  let path = cache.join(format!("vv-{speaker}-s{pct}-{:016x}.wav", fnv1a(text)));
  if path.exists() {
    return Ok(path);
  }
  let agent: ureq::Agent = ureq::Agent::config_builder()
    .timeout_global(Some(Duration::from_secs(15)))
    .build()
    .into();
  let speaker = speaker.to_string();
  let query = agent
    .post(format!("{VOICEVOX_URL}/audio_query"))
    .query("text", text)
    .query("speaker", &speaker)
    .send_empty()
    .map_err(|e| e.to_string())?
    .body_mut()
    .read_to_string()
    .map_err(|e| e.to_string())?;
  // VOICEVOX slows speech without lowering the pitch, which sounds natural even well below 1.0.
  let mut query: serde_json::Value = serde_json::from_str(&query).map_err(|e| e.to_string())?;
  query["speedScale"] = serde_json::json!(speed);
  let query = query.to_string();
  let wav = agent
    .post(format!("{VOICEVOX_URL}/synthesis"))
    .query("speaker", &speaker)
    .header("content-type", "application/json")
    .send(&query)
    .map_err(|e| e.to_string())?
    .body_mut()
    .with_config()
    .limit(50 * 1024 * 1024)
    .read_to_vec()
    .map_err(|e| e.to_string())?;
  std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
  std::fs::write(&path, wav).map_err(|e| e.to_string())?;
  Ok(path)
}

#[derive(serde::Serialize)]
pub struct VoiceInfo {
  engine: &'static str,
  version: Option<String>,
  speaker: Option<String>,
  style: Option<String>,
  credit: Option<String>,
}

/// Which voice is in use. The credit is the character name the VOICEVOX terms ask to be shown.
#[tauri::command]
pub async fn voice_info(speaker: Option<u32>) -> Result<VoiceInfo, String> {
  let speaker = speaker.unwrap_or(DEFAULT_SPEAKER);
  tauri::async_runtime::spawn_blocking(move || {
    let agent: ureq::Agent = ureq::Agent::config_builder()
      .timeout_global(Some(Duration::from_secs(3)))
      .build()
      .into();
    let get = |path: &str| -> Result<String, String> {
      agent
        .get(format!("{VOICEVOX_URL}{path}"))
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())
    };
    let Ok(version) = get("/version") else {
      return Ok(VoiceInfo { engine: "system", version: None, speaker: None, style: None, credit: None });
    };
    let speakers: serde_json::Value = serde_json::from_str(&get("/speakers")?).map_err(|e| e.to_string())?;
    let found = speakers.as_array().into_iter().flatten().find_map(|sp| {
      let style = sp["styles"].as_array()?.iter().find(|st| st["id"].as_u64() == Some(speaker as u64))?;
      Some((sp["name"].as_str()?.to_string(), style["name"].as_str().unwrap_or("").to_string()))
    });
    Ok(VoiceInfo {
      engine: "voicevox",
      version: Some(version.trim_matches('"').to_string()),
      credit: found.as_ref().map(|(name, _)| format!("VOICEVOX:{name}")),
      speaker: found.as_ref().map(|(name, _)| name.clone()),
      style: found.map(|(_, style)| style),
    })
  })
  .await
  .map_err(|e| e.to_string())?
}

fn agent(timeout: Duration) -> ureq::Agent {
  ureq::Agent::config_builder().timeout_global(Some(timeout)).build().into()
}

#[derive(serde::Serialize)]
pub struct VoiceOption {
  id: u32,
  name: String,
  style: String,
  uuid: String,
}

/// One entry per character, in its plain speaking style, for lessons.
#[tauri::command]
pub async fn voices() -> Result<Vec<VoiceOption>, String> {
  tauri::async_runtime::spawn_blocking(list_voices).await.map_err(|e| e.to_string())?
}

fn list_voices() -> Result<Vec<VoiceOption>, String> {
  let body = agent(Duration::from_secs(3))
    .get(format!("{VOICEVOX_URL}/speakers"))
    .call()
    .map_err(|e| e.to_string())?
    .body_mut()
    .read_to_string()
    .map_err(|e| e.to_string())?;
  let speakers: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
  Ok(speakers.as_array().into_iter().flatten().filter_map(plain_style).collect())
}

fn plain_style(sp: &serde_json::Value) -> Option<VoiceOption> {
  let styles = sp["styles"].as_array()?;
  // Speaking styles are "talk" or "streaming_talk" (0.26); singing styles are excluded.
  let talk = |st: &&serde_json::Value| st["type"].as_str().map_or(true, |t| matches!(t, "talk" | "streaming_talk"));
  let style = styles
    .iter()
    .filter(talk)
    .find(|st| matches!(st["name"].as_str(), Some("ノーマル" | "ふつう")))
    .or_else(|| styles.iter().find(talk))?;
  Some(VoiceOption {
    id: style["id"].as_u64()? as u32,
    name: sp["name"].as_str()?.to_string(),
    style: style["name"].as_str()?.to_string(),
    uuid: sp["speaker_uuid"].as_str()?.to_string(),
  })
}

/// The voice's usage terms, as the engine ships them. The portraits in the same response are dropped.
#[tauri::command]
pub async fn voice_terms(uuid: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = agent(Duration::from_secs(10))
      .get(format!("{VOICEVOX_URL}/speaker_info"))
      .query("speaker_uuid", &uuid)
      .call()
      .map_err(|e| e.to_string())?
      .body_mut()
      .with_config()
      .limit(64 * 1024 * 1024)
      .read_to_string()
      .map_err(|e| e.to_string())?;
    let info: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(info["policy"].as_str().unwrap_or("").to_string())
  })
  .await
  .map_err(|e| e.to_string())?
}

fn fnv1a(s: &str) -> u64 {
  s.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

#[cfg(target_os = "macos")]
fn play(clip: &Path) -> Result<Child, String> {
  Command::new("afplay").arg(clip).spawn().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn system_voice(text: &str, speed: f32) -> Result<Child, String> {
  let rate = ((175.0 * speed).round() as u32).to_string();
  Command::new("say").args(["-v", "Kyoko", "-r", &rate, "--", text]).spawn().map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn play(_clip: &Path) -> Result<Child, String> {
  Err("audio playback is not wired up on this platform yet".into())
}

#[cfg(not(target_os = "macos"))]
fn system_voice(_text: &str, _speed: f32) -> Result<Child, String> {
  Err("system voice not available on this platform".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn keeps_speed_in_an_intelligible_range() {
    assert_eq!(clamp_speed(None), 1.0);
    assert_eq!(clamp_speed(Some(0.1)), 0.5);
    assert_eq!(clamp_speed(Some(3.0)), 1.5);
    assert_eq!(clamp_speed(Some(f32::NAN)), 1.0);
    assert_eq!(clamp_speed(Some(0.75)), 0.75);
  }

  #[test]
  fn picks_the_plain_talking_style() {
    let sp = serde_json::json!({"name": "A", "speaker_uuid": "u", "styles": [
      {"id": 0, "name": "あまあま", "type": "talk"},
      {"id": 9, "name": "ノーマル", "type": "singing_teacher"},
      {"id": 2, "name": "ノーマル", "type": "streaming_talk"}]});
    let v = plain_style(&sp).unwrap();
    assert_eq!((v.id, v.style.as_str()), (2, "ノーマル"));
    let only = serde_json::json!({"name": "B", "speaker_uuid": "u", "styles": [{"id": 12, "name": "ふつう"}]});
    assert_eq!(plain_style(&only).unwrap().id, 12);
    let none = serde_json::json!({"name": "C", "speaker_uuid": "u", "styles": [{"id": 5, "name": "わーい"}]});
    assert_eq!(plain_style(&none).unwrap().id, 5, "falls back to the first talking style");
  }

  #[test]
  fn lists_one_plain_voice_per_character_when_voicevox_runs() {
    if ureq::get(format!("{VOICEVOX_URL}/version")).call().is_err() {
      return;
    }
    let voices = list_voices().unwrap();
    assert!(voices.len() > 10, "got {}", voices.len());
    assert!(voices.iter().any(|v| v.id == DEFAULT_SPEAKER && v.style == "ノーマル"));
  }

  /// Runs only when a VOICEVOX engine is listening locally.
  #[test]
  fn renders_and_caches_a_clip_when_voicevox_runs() {
    if ureq::get(format!("{VOICEVOX_URL}/version")).call().is_err() {
      eprintln!("VOICEVOX not running; skipped");
      return;
    }
    let cache = std::env::temp_dir().join(format!("jle-voice-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&cache);
    let clip = voicevox_clip(&cache, "たべる", DEFAULT_SPEAKER, 1.0).unwrap();
    let bytes = std::fs::read(&clip).unwrap();
    assert_eq!(&bytes[..4], b"RIFF");
    let modified = std::fs::metadata(&clip).unwrap().modified().unwrap();
    assert_eq!(voicevox_clip(&cache, "たべる", DEFAULT_SPEAKER, 1.0).unwrap(), clip);
    assert_ne!(voicevox_clip(&cache, "たべる", 3, 1.0).unwrap(), clip, "another voice gets its own clip");
    let slow = voicevox_clip(&cache, "たべる", DEFAULT_SPEAKER, 0.7).unwrap();
    assert_ne!(slow, clip, "another speed gets its own clip");
    let (fast_len, slow_len) = (std::fs::metadata(&clip).unwrap().len(), std::fs::metadata(&slow).unwrap().len());
    assert!(slow_len > fast_len * 12 / 10, "slower speech is longer audio ({slow_len} vs {fast_len} bytes)");
    assert_eq!(std::fs::metadata(&clip).unwrap().modified().unwrap(), modified, "second call reuses the cache");
    let _ = std::fs::remove_dir_all(&cache);
  }
}
