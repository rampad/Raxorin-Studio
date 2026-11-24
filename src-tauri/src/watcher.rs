//! Vigila la carpeta del proyecto y avisa a la interfaz qué carpetas cambiaron,
//! para que el explorador se actualice solo (archivos creados por cargo, git, etc.).
//!
//! Evento emitido: `fs-changed` Vec<String> con las carpetas afectadas.

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WatchState(Mutex<Option<RecommendedWatcher>>);

const IGNORED: &[&str] = &["target", ".git", "node_modules"];

fn ignored(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .map(|rel| {
            rel.components()
                .any(|c| IGNORED.contains(&c.as_os_str().to_string_lossy().as_ref()))
        })
        .unwrap_or(true)
}

#[tauri::command]
pub fn watch_project(
    app: AppHandle,
    state: State<'_, WatchState>,
    root: String,
) -> Result<(), String> {
    // Al soltar el watcher anterior se cierra su canal y termina su hilo.
    state.0.lock().unwrap().take();

    let root = PathBuf::from(root);
    let (tx, rx) = mpsc::channel::<Event>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            let _ = tx.send(ev);
        }
    })
    .map_err(|e| format!("No se pudo vigilar la carpeta: {e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("No se pudo vigilar la carpeta: {e}"))?;

    // Agrupar ráfagas de eventos: emitir cuando haya 150 ms de calma.
    thread::spawn(move || {
        let mut dirs: HashSet<String> = HashSet::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(150)) {
                Ok(ev) => {
                    for p in ev.paths.iter().filter(|p| !ignored(&root, p)) {
                        if let Some(parent) = p.parent() {
                            dirs.insert(parent.to_string_lossy().into_owned());
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !dirs.is_empty() {
                        let _ = app.emit("fs-changed", dirs.drain().collect::<Vec<_>>());
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}
