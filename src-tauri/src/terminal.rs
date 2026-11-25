//! Terminal integrado: una pseudo-terminal (PTY) con el shell del sistema, que la interfaz
//! muestra con xterm.js. Varias terminales a la vez, cada una con su número.
//!
//! Eventos: `terminal-data` { id, data } con lo que escribe el shell, y `terminal-exit` { id }.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next: Mutex<u32>,
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Serialize, Clone)]
struct Data {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct Exit {
    id: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: u32,
    /// Nombre del shell para la pestaña (zsh, bash, powershell…).
    pub shell: String,
}

/// El shell del sistema: $SHELL (como shell de inicio de sesión, para que cargue el perfil del
/// usuario) en macOS/Linux; PowerShell en Windows.
fn shell_command() -> (CommandBuilder, String) {
    if cfg!(windows) {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        (cmd, "powershell".into())
    } else {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
            if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }
        });
        let name = std::path::Path::new(&shell).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "shell".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        (cmd, name)
    }
}

/// Convierte bytes a texto sin partir un carácter UTF-8 entre dos lecturas: lo incompleto
/// del final se guarda en `pending` para la siguiente.
fn decode(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(), // falta el resto del carácter
        Err(_) => pending.len(),                               // bytes inválidos: se reemplazan
    };
    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
    pending.drain(..valid);
    text
}

#[tauri::command]
pub fn terminal_open(app: AppHandle, state: State<'_, Terminals>, cwd: Option<String>, cols: u16, rows: u16) -> Result<Opened, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("No se pudo abrir la terminal: {e}"))?;
    let (mut cmd, shell) = shell_command();
    let dir = cwd.filter(|d| std::path::Path::new(d).is_dir()).or_else(|| dirs_home().map(|h| h.to_string_lossy().into_owned()));
    if let Some(d) = dir {
        cmd.cwd(d);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "RaxorinStudio");
    if let Some(path) = crate::toolchain::path_with_cargo() {
        cmd.env("PATH", path);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("No se pudo iniciar {shell}: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        *n
    };
    state.sessions.lock().unwrap().insert(id, Session { master: pair.master, writer, killer });

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = decode(&mut pending, &buf[..n]);
                    if !data.is_empty() {
                        let _ = app.emit("terminal-data", Data { id, data });
                    }
                }
            }
        }
        let _ = child.wait();
        let _ = app.emit("terminal-exit", Exit { id });
    });
    Ok(Opened { id, shell })
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(Into::into)
}

#[tauri::command]
pub fn terminal_write(state: State<'_, Terminals>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("La terminal ya se cerró.")?;
    s.writer.write_all(data.as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get(&id) {
        s.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_close(state: State<'_, Terminals>, id: u32) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
    }
}

/// Al cerrar la app: terminar todos los shells.
pub fn close_all(state: &Terminals) {
    for (_, mut s) in state.sessions.lock().unwrap().drain() {
        let _ = s.killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_parte_caracteres_utf8() {
        let mut pending = Vec::new();
        let bytes = "¡Añoño ✔".as_bytes();
        let (a, b) = bytes.split_at(1); // a mitad de "¡" (2 bytes)
        let mut out = decode(&mut pending, a);
        out += &decode(&mut pending, b);
        assert_eq!(out, "¡Añoño ✔");
        // Cortar a mitad de "✔" (3 bytes).
        let mut pending = Vec::new();
        let (a, b) = bytes.split_at(bytes.len() - 1);
        let first = decode(&mut pending, a);
        assert!(!first.contains('\u{FFFD}'), "{first:?}");
        assert_eq!(first + &decode(&mut pending, b), "¡Añoño ✔");
    }

    #[test]
    fn abre_un_shell_real() {
        // Sin Tauri: probar la PTY y el shell directamente.
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let (mut cmd, _) = shell_command();
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let fin = if cfg!(windows) { "echo raxorin-$((6*7))\r\nexit\r\n" } else { "echo raxorin-$((6*7)); exit\n" };
        if cfg!(windows) {
            // ConPTY pregunta la posición del cursor (ESC[6n) y espera la respuesta antes de
            // mostrar nada. En la app la da xterm.js; aquí, la prueba.
            std::thread::sleep(std::time::Duration::from_millis(500));
            writer.write_all(b"\x1b[1;1R").unwrap();
        }
        writer.write_all(fin.as_bytes()).unwrap();
        let all = std::sync::Arc::new(Mutex::new(Vec::new()));
        let shared = all.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                shared.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        // Quitar las secuencias de escape (Windows/ConPTY redibuja la pantalla con ellas).
        let plain = |bytes: &[u8]| {
            let text = String::from_utf8_lossy(bytes);
            let mut out = String::new();
            let mut chars = text.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\x1b' {
                    if chars.peek() == Some(&'[') {
                        chars.next();
                        for c in chars.by_ref() { if c.is_ascii_alphabetic() { break; } }
                    } else if chars.peek() == Some(&']') {
                        for c in chars.by_ref() { if c == '\x07' { break; } }
                    }
                } else {
                    out.push(c);
                }
            }
            out
        };
        let start = std::time::Instant::now();
        let out = loop {
            let out = plain(&all.lock().unwrap());
            if out.contains("raxorin-42") || start.elapsed() > std::time::Duration::from_secs(40) { break out; }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        let _ = child.kill();
        assert!(out.contains("raxorin-42"), "{out}");
    }
}
