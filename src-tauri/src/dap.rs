//! Puente con el depurador (Debug Adapter Protocol), usando `lldb-dap`.
//!
//! Igual que con rust-analyzer, el backend solo transporta mensajes
//! (`Content-Length` + JSON) y la lógica vive en `src/debug/`.
//!
//! La entrada del programa depurado se envía por un FIFO: LLDB lo usa como
//! stdin gracias a `settings set target.input-path <fifo>`.
//!
//! Eventos emitidos:
//! - `dap-message` String  un mensaje completo del adaptador
//! - `dap-exit`    ()      el adaptador terminó

use crate::toolchain::{new_command, rustup_tool};
use serde::Serialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct DapState {
    proc: Mutex<Option<DapProc>>,
    stdin: Mutex<Option<(PathBuf, File)>>,
}

struct DapProc {
    child: Child,
    stdin: ChildStdin,
}

impl Drop for DapProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Busca `lldb-dap` (o su nombre antiguo `lldb-vscode`).
fn find_adapter() -> Option<PathBuf> {
    // macOS: viene con las Command Line Tools de Xcode.
    if cfg!(target_os = "macos") {
        if let Ok(o) = new_command("xcrun").args(["-f", "lldb-dap"]).output() {
            let p = PathBuf::from(String::from_utf8_lossy(&o.stdout).trim());
            if o.status.success() && p.is_file() {
                return Some(p);
            }
        }
    }
    let exe = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
    let mut names = vec![exe("lldb-dap")];
    names.extend((14..=24).rev().map(|v| exe(&format!("lldb-dap-{v}"))));
    names.push(exe("lldb-vscode"));
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if cfg!(windows) {
        dirs.push(PathBuf::from(r"C:\Program Files\LLVM\bin"));
    } else {
        dirs.extend(["/usr/bin", "/usr/local/bin", "/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"].map(PathBuf::from));
    }
    names.iter().flat_map(|n| dirs.iter().map(move |d| d.join(n))).find(|p| p.is_file())
}

/// Script de Python que enseña a LLDB a mostrar tipos de Rust (Vec, String, Option…).
fn rust_formatters() -> Option<PathBuf> {
    let out = new_command(rustup_tool("rustc")).args(["--print", "sysroot"]).output().ok()?;
    let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()).join("lib/rustlib/etc/lldb_lookup.py");
    p.is_file().then_some(p)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebuggerInfo {
    adapter: Option<String>,
    formatters: Option<String>,
    /// Si se puede enviar entrada (stdin) al programa depurado.
    stdin_supported: bool,
}

#[tauri::command]
pub async fn debugger_info() -> DebuggerInfo {
    tauri::async_runtime::spawn_blocking(|| DebuggerInfo {
        adapter: find_adapter().map(|p| p.to_string_lossy().into_owned()),
        formatters: rust_formatters().map(|p| p.to_string_lossy().into_owned()),
        stdin_supported: cfg!(unix),
    })
    .await
    .unwrap_or(DebuggerInfo { adapter: None, formatters: None, stdin_supported: false })
}

#[tauri::command]
pub fn dap_start(app: AppHandle, state: State<'_, DapState>) -> Result<(), String> {
    state.proc.lock().unwrap().take();
    let adapter = find_adapter().ok_or(
        "No se encontró el depurador lldb-dap. En macOS instala las herramientas con `xcode-select --install`; \
         en Linux instala el paquete `lldb` (p. ej. `sudo apt install lldb`); en Windows, LLVM.",
    )?;
    let mut child = new_command(&adapter)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo iniciar {}: {e}", adapter.display()))?;
    let stdin = child.stdin.take().ok_or("lldb-dap sin stdin")?;
    let stdout = child.stdout.take().ok_or("lldb-dap sin stdout")?;
    let stderr = child.stderr.take().ok_or("lldb-dap sin stderr")?;

    let app_out = app.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(msg) = read_message(&mut reader) {
            let _ = app_out.emit("dap-message", msg);
        }
        let _ = app_out.emit("dap-exit", ());
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[lldb-dap] {line}");
        }
    });
    *state.proc.lock().unwrap() = Some(DapProc { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn dap_send(state: State<'_, DapState>, msg: String) -> Result<(), String> {
    let mut guard = state.proc.lock().unwrap();
    let p = guard.as_mut().ok_or("El depurador no está en ejecución")?;
    let framed = format!("Content-Length: {}\r\n\r\n{msg}", msg.len());
    p.stdin
        .write_all(framed.as_bytes())
        .and_then(|_| p.stdin.flush())
        .map_err(|e| format!("Error al escribir al depurador: {e}"))
}

#[tauri::command]
pub fn dap_stop(state: State<'_, DapState>) {
    state.proc.lock().unwrap().take();
    close_stdin(&state);
}

fn read_message<R: BufRead>(reader: &mut R) -> Option<String> {
    let mut length: Option<usize> = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            return None;
        }
        let header = header.trim_end();
        if header.is_empty() {
            if length.is_some() {
                break;
            }
            continue;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok();
            }
        }
    }
    let mut body = vec![0u8; length?];
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

// ---------- Entrada del programa depurado (FIFO) ----------

fn close_stdin(state: &DapState) {
    if let Some((path, _)) = state.stdin.lock().unwrap().take() {
        let _ = std::fs::remove_file(path);
    }
}

/// Crea un FIFO para la entrada del programa y devuelve su ruta (solo Unix).
#[tauri::command]
pub fn debug_stdin_create(state: State<'_, DapState>) -> Result<Option<String>, String> {
    close_stdin(&state);
    if !cfg!(unix) {
        return Ok(None);
    }
    let dir = std::env::temp_dir().join("oxide-studio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("stdin-{}.fifo", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let ok = new_command("mkfifo").arg(&path).status().map(|s| s.success()).unwrap_or(false);
    if !ok {
        return Ok(None);
    }
    // Lectura+escritura: abrir así no bloquea aunque el programa aún no lo haya abierto.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("No se pudo abrir el FIFO: {e}"))?;
    let shown = path.to_string_lossy().into_owned();
    *state.stdin.lock().unwrap() = Some((path, file));
    Ok(Some(shown))
}

#[tauri::command]
pub fn debug_stdin_write(state: State<'_, DapState>, text: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().unwrap();
    let (_, file) = guard.as_mut().ok_or("El programa depurado no acepta entrada.")?;
    file.write_all(format!("{text}\n").as_bytes())
        .and_then(|_| file.flush())
        .map_err(|e| format!("No se pudo enviar la entrada: {e}"))
}
