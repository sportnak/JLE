//! Starts the local VOICEVOX engine when the app opens, and stops it on quit if the app started it.
//! An engine that was already running (started by hand, or by the VOICEVOX app) is left alone.
//! The pid of an engine the app starts is recorded, so if the app is killed rather than quit,
//! the next launch takes that engine back and the next normal quit stops it.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const HOST: &str = "127.0.0.1";
pub const PORT: u16 = 50021;

enum Owned {
  Child(Child),
  Adopted(u32),
}

#[derive(Default)]
pub struct Engine(Mutex<Option<Owned>>);

fn pid_file(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_data_dir().ok().map(|d| d.join("voicevox.pid"))
}

/// The pid from our pid file, if that process is still the engine we started.
fn orphan_from_last_run(app: &AppHandle, run: &Path) -> Option<u32> {
  let pid: u32 = std::fs::read_to_string(pid_file(app)?).ok()?.trim().parse().ok()?;
  let out = Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output().ok()?;
  String::from_utf8_lossy(&out.stdout).contains(run.to_str()?).then_some(pid)
}

fn responding() -> bool {
  let agent: ureq::Agent = ureq::Agent::config_builder()
    .timeout_global(Some(Duration::from_millis(800)))
    .build()
    .into();
  agent.get(format!("http://{HOST}:{PORT}/version")).call().is_ok()
}

/// The newest engine under `<root>/<version>/run`. `JLE_VOICEVOX_DIR` overrides the root.
fn find_engine(home: &Path) -> Option<PathBuf> {
  let root = std::env::var_os("JLE_VOICEVOX_DIR")
    .map(PathBuf::from)
    .unwrap_or_else(|| home.join("Library/Application Support/jle-voicevox"));
  let mut versions: Vec<(Vec<u32>, PathBuf)> = std::fs::read_dir(&root)
    .ok()?
    .filter_map(|e| e.ok())
    .filter_map(|e| {
      let run = e.path().join("run");
      let name = e.file_name().into_string().ok()?;
      let parts = name.split('.').map(|p| p.parse::<u32>().ok()).collect::<Option<Vec<_>>>()?;
      run.is_file().then_some((parts, run))
    })
    .collect();
  versions.sort();
  versions.pop().map(|(_, run)| run)
}

/// Called from setup. Runs off the main thread so a slow probe never delays the window.
pub fn start_if_needed(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || {
    let Some(home) = app.path().home_dir().ok() else { return };
    let run = find_engine(&home);
    if responding() {
      match run.as_deref().and_then(|r| orphan_from_last_run(&app, r)) {
        Some(pid) => {
          log::info!("took back VOICEVOX left running by the last session (pid {pid})");
          *app.state::<Engine>().0.lock().unwrap() = Some(Owned::Adopted(pid));
        }
        None => log::info!("VOICEVOX already running; leaving it alone"),
      }
      return;
    }
    let Some(run) = run else {
      log::info!("VOICEVOX not installed; using the system voice");
      return;
    };
    let log_file = app
      .path()
      .app_log_dir()
      .ok()
      .and_then(|dir| std::fs::create_dir_all(&dir).ok().map(|_| dir.join("voicevox.log")))
      .and_then(|path| std::fs::File::create(path).ok());
    let mut cmd = Command::new(&run);
    cmd.args(["--host", HOST, "--port", &PORT.to_string()])
      .current_dir(run.parent().unwrap_or(Path::new(".")))
      .stdin(Stdio::null());
    match log_file {
      Some(f) => {
        let err = f.try_clone().ok();
        cmd.stdout(f);
        if let Some(err) = err {
          cmd.stderr(err);
        }
      }
      None => {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
      }
    }
    match cmd.spawn() {
      Ok(child) => {
        log::info!("started VOICEVOX from {} (pid {})", run.display(), child.id());
        if let Some(path) = pid_file(&app) {
          let _ = std::fs::write(path, child.id().to_string());
        }
        *app.state::<Engine>().0.lock().unwrap() = Some(Owned::Child(child));
      }
      Err(e) => log::warn!("could not start VOICEVOX: {e}"),
    }
  });
}

/// Called on exit: stops the engine only if this app started it.
pub fn stop(app: &AppHandle) {
  let owned = app.state::<Engine>().0.lock().unwrap().take();
  match owned {
    Some(Owned::Child(mut child)) => {
      let _ = child.kill();
      let _ = child.wait();
    }
    Some(Owned::Adopted(pid)) => {
      let _ = Command::new("kill").arg(pid.to_string()).status();
    }
    None => return,
  }
  if let Some(path) = pid_file(app) {
    let _ = std::fs::remove_file(path);
  }
  log::info!("stopped VOICEVOX");
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn picks_the_newest_installed_version() {
    let root = std::env::temp_dir().join(format!("jle-vv-find-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for v in ["0.9.1", "0.26.2", "0.25.10", "notes"] {
      std::fs::create_dir_all(root.join(v)).unwrap();
      if v != "notes" {
        std::fs::write(root.join(v).join("run"), "").unwrap();
      }
    }
    // SAFETY: tests in this module do not read this variable concurrently.
    unsafe { std::env::set_var("JLE_VOICEVOX_DIR", &root) };
    let found = find_engine(Path::new("/nowhere")).unwrap();
    unsafe { std::env::remove_var("JLE_VOICEVOX_DIR") };
    assert_eq!(found, root.join("0.26.2").join("run"));
    let _ = std::fs::remove_dir_all(&root);
  }
}
