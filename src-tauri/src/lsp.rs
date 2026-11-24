//! Puente entre la interfaz y rust-analyzer (Language Server Protocol).
//!
//! El backend solo transporta mensajes: lanza `rust-analyzer`, le escribe con
//! el encabezado `Content-Length` y reenvía cada respuesta a la interfaz con
//! el evento `lsp-message`. La lógica del protocolo vive en `src/lsp/client.ts`.
//!
//! Eventos emitidos:
//! - `lsp-message` String  un mensaje JSON-RPC completo del servidor
//! - `lsp-exit`    ()      el servidor terminó

use crate::toolchain::{new_command, rustup_tool};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct LspState(Mutex<Option<LspProc>>);

pub struct LspProc {
    child: Child,
    stdin: ChildStdin,
}

impl Drop for LspProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tauri::command]
pub fn lsp_start(app: AppHandle, state: State<'_, LspState>, root: String) -> Result<(), String> {
    // Detener el servidor anterior (al cambiar de proyecto).
    state.0.lock().unwrap().take();

    let bin = rustup_tool("rust-analyzer");
    let mut child = new_command(&bin)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo iniciar rust-analyzer: {e}"))?;

    let stdin = child.stdin.take().ok_or("rust-analyzer sin stdin")?;
    let stdout = child.stdout.take().ok_or("rust-analyzer sin stdout")?;
    let stderr = child.stderr.take().ok_or("rust-analyzer sin stderr")?;

    let app_out = app.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(msg) = read_message(&mut reader) {
            let _ = app_out.emit("lsp-message", msg);
        }
        let _ = app_out.emit("lsp-exit", ());
    });
    // El registro de rust-analyzer va a la consola de desarrollo.
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[rust-analyzer] {line}");
        }
    });

    *state.0.lock().unwrap() = Some(LspProc { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn lsp_send(state: State<'_, LspState>, msg: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let proc = guard.as_mut().ok_or("rust-analyzer no está en ejecución")?;
    let framed = format!("Content-Length: {}\r\n\r\n{msg}", msg.len());
    proc.stdin
        .write_all(framed.as_bytes())
        .and_then(|_| proc.stdin.flush())
        .map_err(|e| format!("Error al escribir a rust-analyzer: {e}"))
}

#[tauri::command]
pub fn lsp_stop(state: State<'_, LspState>) {
    state.0.lock().unwrap().take();
}

/// Lee un mensaje con el formato `Content-Length: N\r\n\r\n<N bytes>`.
fn read_message<R: BufRead>(reader: &mut R) -> Option<String> {
    let mut length: Option<usize> = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            return None; // fin del flujo
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
