//! The Anthropic API key (architecture §7.3). It lives in the macOS keychain and never goes back to the webview:
//! the webview can only set it, clear it and ask whether one is set. `JLE_ANTHROPIC_API_KEY` overrides the
//! keychain, for tests and development.

use serde::Serialize;

const SERVICE: &str = "app.jle.desktop";
const ACCOUNT: &str = "anthropic-api-key";
const ENV: &str = "JLE_ANTHROPIC_API_KEY";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
  pub set: bool,
}

/// Trimmed, non-empty and shaped like an Anthropic key.
fn clean(key: &str) -> Result<&str, String> {
  let key = key.trim();
  if key.is_empty() {
    return Err("The API key is empty".into());
  }
  if !key.starts_with("sk-ant-") || key.chars().any(char::is_whitespace) {
    return Err("That does not look like an Anthropic API key (it should start with sk-ant-)".into());
  }
  Ok(key)
}

fn from_env() -> Option<String> {
  std::env::var(ENV).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// The key for a request: the environment override, else the keychain. `None` when neither has one.
pub fn load() -> Result<Option<String>, String> {
  if let Some(key) = from_env() {
    return Ok(Some(key));
  }
  keychain::get()
}

#[tauri::command]
pub fn api_key_set(key: String) -> Result<(), String> {
  keychain::set(clean(&key)?)
}

#[tauri::command]
pub fn api_key_status() -> Result<ApiKeyStatus, String> {
  Ok(ApiKeyStatus { set: load()?.is_some() })
}

#[tauri::command]
pub fn api_key_clear() -> Result<(), String> {
  keychain::clear()
}

#[cfg(target_os = "macos")]
mod keychain {
  use super::{ACCOUNT, SERVICE};
  use security_framework::base::Error;
  use security_framework::passwords::{
    delete_generic_password, generic_password, set_generic_password, PasswordOptions,
  };

  const NOT_FOUND: i32 = -25300; // errSecItemNotFound

  fn message(e: Error) -> String {
    format!("Keychain: {}", e.message().unwrap_or_else(|| e.code().to_string()))
  }

  pub fn get() -> Result<Option<String>, String> {
    match generic_password(PasswordOptions::new_generic_password(SERVICE, ACCOUNT)) {
      Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| "Keychain: the stored key is not text".into()),
      Err(e) if e.code() == NOT_FOUND => Ok(None),
      Err(e) => Err(message(e)),
    }
  }

  pub fn set(key: &str) -> Result<(), String> {
    set_generic_password(SERVICE, ACCOUNT, key.as_bytes()).map_err(message)
  }

  pub fn clear() -> Result<(), String> {
    match delete_generic_password(SERVICE, ACCOUNT) {
      Err(e) if e.code() != NOT_FOUND => Err(message(e)),
      _ => Ok(()),
    }
  }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
  const UNSUPPORTED: &str = "The keychain is only supported on macOS; set JLE_ANTHROPIC_API_KEY";

  pub fn get() -> Result<Option<String>, String> {
    Ok(None)
  }

  pub fn set(_: &str) -> Result<(), String> {
    Err(UNSUPPORTED.into())
  }

  pub fn clear() -> Result<(), String> {
    Err(UNSUPPORTED.into())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cleans_and_checks_the_key() {
    assert_eq!(clean("  sk-ant-api03-abc\n"), Ok("sk-ant-api03-abc"));
    assert!(clean("   ").is_err());
    assert!(clean("sk-proj-abc").is_err());
    assert!(clean("sk-ant-a b").is_err());
  }

  // The only test that touches JLE_ANTHROPIC_API_KEY, so it cannot race another test. Never reaches the keychain.
  #[test]
  fn the_environment_overrides_the_keychain() {
    // SAFETY: no other test reads or writes this variable.
    unsafe { std::env::set_var(ENV, "  sk-ant-test-key  ") };
    assert_eq!(load(), Ok(Some("sk-ant-test-key".to_string())));
    assert_eq!(api_key_status(), Ok(ApiKeyStatus { set: true }));
    unsafe { std::env::set_var(ENV, "  ") };
    assert_eq!(from_env(), None);
    unsafe { std::env::remove_var(ENV) };
  }
}
