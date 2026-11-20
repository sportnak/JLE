//! The reference dictionary is a bundle resource (tauri.conf.json), and tauri-build fails on a missing resource.
//! A release build needs it, so a missing file stops the build with the command that makes it. A debug build
//! (cargo test, tauri dev) goes on without it: the resource is dropped and `dictionary_lookup` says what is missing.

use std::path::Path;

const DB: &str = "../../../packages/reference/out/reference.sqlite";

fn main() {
  println!("cargo:rerun-if-changed={DB}");
  if !Path::new(DB).is_file() {
    let fix = "pnpm --filter @jle/reference run fetch && pnpm --filter @jle/reference build:db (from the repo root)";
    if std::env::var("PROFILE").as_deref() == Ok("release") {
      panic!("packages/reference/out/reference.sqlite is missing; build it with: {fix}");
    }
    println!("cargo:warning=reference.sqlite is missing, so the dictionary is left out of this build. Build it with: {fix}");
    let mut merged: serde_json::Value = std::env::var("TAURI_CONFIG")
      .ok()
      .and_then(|s| serde_json::from_str(&s).ok())
      .unwrap_or_else(|| serde_json::json!({}));
    json_merge(&mut merged, serde_json::json!({"bundle": {"resources": null}}));
    // SAFETY: build scripts are single-threaded here; tauri-build reads TAURI_CONFIG right after.
    unsafe { std::env::set_var("TAURI_CONFIG", merged.to_string()) };
  }
  tauri_build::build()
}

fn json_merge(into: &mut serde_json::Value, patch: serde_json::Value) {
  match (into, patch) {
    (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
      for (k, v) in b {
        json_merge(a.entry(k).or_insert(serde_json::Value::Null), v);
      }
    }
    (slot, v) => *slot = v,
  }
}
