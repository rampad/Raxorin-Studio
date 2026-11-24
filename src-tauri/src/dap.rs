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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct DapState {
    proc: Mutex<Option<DapProc>>,
    stdin: Mutex<Option<(PathBuf, File)>>,
    /// Número de sesión: los eventos de un adaptador viejo no deben afectar a la sesión nueva.
    session: AtomicU64,
}

/// Mensaje del adaptador etiquetado con su sesión.
#[derive(Clone, Serialize)]
struct DapEvent {
    session: u64,
    msg: Option<String>,
}

/// Registro del tráfico con el depurador (carpeta temporal/raxorin-studio/dap-trace.log).
type Trace = Arc<Mutex<Option<File>>>;

fn trace(t: &Trace, dir: &str, msg: &str) {
    if let Some(f) = t.lock().unwrap().as_mut() {
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() % 1_000_000).unwrap_or(0);
        let short: String = msg.chars().take(1500).collect();
        let _ = writeln!(f, "{ms:>7} {dir} {short}");
    }
}

struct DapProc {
    child: Child,
    stdin: Option<ChildStdin>,
    trace: Trace,
    /// PID del programa depurado (llega en el evento `process` del adaptador).
    debuggee: Arc<Mutex<Option<u32>>>,
}

/// ¿Sigue vivo el proceso? (sin dependencias extra: `kill -0` / `tasklist`)
fn alive(pid: u32) -> bool {
    if cfg!(windows) {
        new_command("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    } else {
        new_command("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false)
    }
}

fn force_kill(pid: u32) {
    let _ = if cfg!(windows) {
        new_command("taskkill").args(["/F", "/PID", &pid.to_string()]).status()
    } else {
        new_command("kill").args(["-9", &pid.to_string()]).status()
    };
}

impl Drop for DapProc {
    /// Cierre ordenado. Si se mata lldb-dap sin más, el programa depurado queda
    /// huérfano con sus puntos de interrupción puestos y macOS lo cierra con SIGTRAP.
    fn drop(&mut self) {
        trace(&self.trace, "##", "cerrando la sesión");
        if matches!(self.child.try_wait(), Ok(None)) {
            if let Some(mut stdin) = self.stdin.take() {
                let msg = r#"{"seq":999999,"type":"request","command":"disconnect","arguments":{"terminateDebuggee":true}}"#;
                let _ = stdin
                    .write_all(format!("Content-Length: {}\r\n\r\n{msg}", msg.len()).as_bytes())
                    .and_then(|_| stdin.flush());
                // Al cerrar su entrada, lldb-dap termina la sesión (y el programa) y sale solo.
                drop(stdin);
            }
            // Esperar a que el adaptador salga por sí mismo (máx. 3 s) y, si se conoce, al programa.
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                let adapter_done = !matches!(self.child.try_wait(), Ok(None));
                let program_done = self.debuggee.lock().unwrap().is_none_or(|pid| !alive(pid));
                if adapter_done && program_done {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        let pid = *self.debuggee.lock().unwrap();
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Último recurso: que nunca quede vivo un programa sin depurador.
        if let Some(pid) = pid {
            if alive(pid) {
                force_kill(pid);
            }
        }
    }
}

impl DapState {
    /// Cierra la sesión (si hay) de forma ordenada. Se usa también al salir de la app.
    pub fn shutdown(&self) {
        self.proc.lock().unwrap().take();
        close_stdin(self);
    }
}

/// Extrae el PID del evento `process` (`body.systemProcessId`).
fn debuggee_pid(msg: &str) -> Option<u32> {
    if !msg.contains("\"process\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(msg).ok()?;
    (v["type"] == "event" && v["event"] == "process").then(|| v["body"]["systemProcessId"].as_u64())?.map(|p| p as u32)
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

/// Protección para los formateadores de Rust: sin ella, tipos recursivos (como los de
/// Slint) agotan la pila de Python al mostrar variables y matan a lldb-dap.
const FORMATTER_GUARD: &str = include_str!("raxorin_lldb_guard.py");

fn formatter_guard() -> Option<PathBuf> {
    let dir = std::env::temp_dir().join("raxorin-studio");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("raxorin_lldb_guard.py");
    std::fs::write(&path, FORMATTER_GUARD).ok()?;
    Some(path)
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
    /// Script que limita la profundidad de esos formateadores (se carga después).
    formatter_guard: Option<String>,
    /// Si se puede enviar entrada (stdin) al programa depurado.
    stdin_supported: bool,
}

#[tauri::command]
pub async fn debugger_info() -> DebuggerInfo {
    tauri::async_runtime::spawn_blocking(|| DebuggerInfo {
        adapter: find_adapter().map(|p| p.to_string_lossy().into_owned()),
        formatters: rust_formatters().map(|p| p.to_string_lossy().into_owned()),
        formatter_guard: formatter_guard().map(|p| p.to_string_lossy().into_owned()),
        stdin_supported: cfg!(unix),
    })
    .await
    .unwrap_or(DebuggerInfo { adapter: None, formatters: None, formatter_guard: None, stdin_supported: false })
}

#[tauri::command]
pub fn dap_start(app: AppHandle, state: State<'_, DapState>) -> Result<u64, String> {
    // Si quedó un depurador anterior (p. ej. la interfaz se recargó), cerrarlo de forma ordenada.
    // Ojo: NO tocar el FIFO de entrada; el controlador lo crea justo antes de llamar aquí.
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

    let session = state.session.fetch_add(1, Ordering::SeqCst) + 1;
    let log_dir = std::env::temp_dir().join("raxorin-studio");
    let _ = std::fs::create_dir_all(&log_dir);
    let trace_file: Trace = Arc::new(Mutex::new(File::create(log_dir.join("dap-trace.log")).ok()));
    trace(&trace_file, "##", &format!("sesión {session} · {}", adapter.display()));
    let trace_reader = trace_file.clone();
    let debuggee = Arc::new(Mutex::new(None));
    let debuggee_reader = debuggee.clone();
    let app_out = app.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(msg) = read_message(&mut reader) {
            if let Some(pid) = debuggee_pid(&msg) {
                *debuggee_reader.lock().unwrap() = Some(pid);
                crate::monitor::start(&app_out, crate::monitor::Target::Pid(pid), "debug");
            }
            if !msg.contains("\"category\":\"telemetry\"") {
                trace(&trace_reader, "<-", &msg);
            }
            let _ = app_out.emit("dap-message", DapEvent { session, msg: Some(msg) });
        }
        trace(&trace_reader, "##", "el adaptador terminó");
        let _ = app_out.emit("dap-exit", DapEvent { session, msg: None });
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[lldb-dap] {line}");
        }
    });
    *state.proc.lock().unwrap() = Some(DapProc { child, stdin: Some(stdin), trace: trace_file, debuggee });
    Ok(session)
}

#[tauri::command]
pub fn dap_send(state: State<'_, DapState>, msg: String) -> Result<(), String> {
    let mut guard = state.proc.lock().unwrap();
    let p = guard.as_mut().ok_or("El depurador no está en ejecución")?;
    let framed = format!("Content-Length: {}\r\n\r\n{msg}", msg.len());
    trace(&p.trace, "->", &msg);
    let stdin = p.stdin.as_mut().ok_or("El depurador se está cerrando")?;
    stdin
        .write_all(framed.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Error al escribir al depurador: {e}"))
}

#[tauri::command]
pub fn dap_stop(state: State<'_, DapState>) {
    state.shutdown();
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
    create_stdin_fifo(&state)
}

fn create_stdin_fifo(state: &DapState) -> Result<Option<String>, String> {
    close_stdin(state);
    if !cfg!(unix) {
        return Ok(None);
    }
    let dir = std::env::temp_dir().join("raxorin-studio");
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
    write_stdin(&state, &text)
}

fn write_stdin(state: &DapState, text: &str) -> Result<(), String> {
    let mut guard = state.stdin.lock().unwrap();
    let (_, file) = guard.as_mut().ok_or("El programa depurado no acepta entrada.")?;
    file.write_all(format!("{text}\n").as_bytes())
        .and_then(|_| file.flush())
        .map_err(|e| format!("No se pudo enviar la entrada: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn lee_pid_del_evento_process() {
        let m = r#"{"seq":5,"type":"event","event":"process","body":{"name":"/x/mi_app","systemProcessId":4321,"startMethod":"launch"}}"#;
        assert_eq!(debuggee_pid(m), Some(4321));
        assert_eq!(debuggee_pid(r#"{"type":"event","event":"output","body":{"output":"process"}}"#), None);
    }

    /// Secuencia completa como la hace la app: FIFO → limpiar depurador previo → lanzar con
    /// la configuración del controlador → escribir entrada → leer salida → cerrar.
    /// `RAXORIN_DBG_STDIN_PROGRAM=/ruta/binario_que_lee_una_linea cargo test -- --ignored`
    #[test]
    #[ignore]
    fn secuencia_de_la_app_con_entrada() {
        let Ok(program) = std::env::var("RAXORIN_DBG_STDIN_PROGRAM") else {
            eprintln!("falta RAXORIN_DBG_STDIN_PROGRAM; se omite");
            return;
        };
        let state = DapState::default();
        // 1) El controlador crea el FIFO…
        let fifo = create_stdin_fifo(&state).unwrap().expect("FIFO en Unix");
        // 2) …y dap_start limpia el depurador anterior (no debe borrar el FIFO).
        state.proc.lock().unwrap().take();
        assert!(Path::new(&fifo).exists(), "dap_start borró el FIFO");
        // 3) Lanzar con la misma configuración que src/debug/controller.ts.
        let mut child = new_command(find_adapter().expect("lldb-dap"))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut send = |seq: u32, cmd: &str, args: serde_json::Value| {
            let m = serde_json::json!({"seq": seq, "type": "request", "command": cmd, "arguments": args}).to_string();
            stdin.write_all(format!("Content-Length: {}\r\n\r\n{m}", m.len()).as_bytes()).unwrap();
            stdin.flush().unwrap();
        };
        let fmt = rust_formatters().map(|p| p.to_string_lossy().into_owned());
        send(1, "initialize", serde_json::json!({"adapterID": "lldb-dap", "linesStartAt1": true, "columnsStartAt1": true, "pathFormat": "path"}));
        send(2, "launch", serde_json::json!({
            "program": program, "stopOnEntry": false,
            "initCommands": fmt.map(|f| vec![format!("command script import \"{f}\"")]).unwrap_or_default(),
            "preRunCommands": ["breakpoint set --name rust_panic", format!("settings set target.input-path \"{fifo}\"")],
        }));
        let (mut out, mut launched, mut wrote) = (String::new(), false, false);
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            let Some(msg) = read_message(&mut reader) else { break };
            let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
            if v["event"] == "initialized" {
                send(3, "configurationDone", serde_json::json!({}));
            }
            if v["type"] == "response" && v["command"] == "launch" {
                assert!(v["success"].as_bool().unwrap(), "launch falló: {}", v["message"]);
                launched = true;
            }
            if v["event"] == "output" && v["body"]["category"] == "stdout" {
                out.push_str(v["body"]["output"].as_str().unwrap_or(""));
            }
            // 4) Escribir la entrada como lo hace la caja "Entrada" del panel.
            if launched && !wrote {
                write_stdin(&state, "Ana").unwrap();
                wrote = true;
            }
            if v["event"] == "exited" || v["event"] == "terminated" {
                break;
            }
        }
        let _ = child.kill();
        state.shutdown();
        assert!(launched, "no se lanzó el programa");
        assert!(out.contains("Ana"), "el programa no recibió la entrada; salida: {out:?}");
        assert!(!Path::new(&fifo).exists(), "el FIFO no se borró al cerrar");
    }

    /// Con tipos recursivos (Slint), mostrar variables no debe matar a lldb-dap.
    /// `RAXORIN_DBG_SLINT_PROGRAM=… RAXORIN_DBG_SLINT_SOURCE=…/main.rs RAXORIN_DBG_SLINT_LINE=9 cargo test -- --ignored`
    #[test]
    #[ignore]
    fn variables_de_slint_no_matan_al_depurador() {
        let (Ok(program), Ok(source), Ok(line)) = (
            std::env::var("RAXORIN_DBG_SLINT_PROGRAM"),
            std::env::var("RAXORIN_DBG_SLINT_SOURCE"),
            std::env::var("RAXORIN_DBG_SLINT_LINE"),
        ) else {
            eprintln!("faltan variables RAXORIN_DBG_SLINT_*; se omite");
            return;
        };
        let (fmt, guard) = (rust_formatters().expect("lldb_lookup.py"), formatter_guard().expect("guard"));
        let mut child = new_command(find_adapter().expect("lldb-dap"))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut send = |seq: u32, cmd: &str, args: serde_json::Value| {
            let m = serde_json::json!({"seq": seq, "type": "request", "command": cmd, "arguments": args}).to_string();
            stdin.write_all(format!("Content-Length: {}\r\n\r\n{m}", m.len()).as_bytes()).unwrap();
            stdin.flush().unwrap();
        };
        send(1, "initialize", serde_json::json!({"adapterID": "lldb-dap", "linesStartAt1": true, "columnsStartAt1": true, "pathFormat": "path"}));
        send(2, "launch", serde_json::json!({
            "program": program,
            "initCommands": [format!("command script import \"{}\"", fmt.display()), format!("command script import \"{}\"", guard.display())],
        }));
        let mut pid = None;
        let mut variables: Option<serde_json::Value> = None;
        while let Some(msg) = read_message(&mut reader) {
            if let Some(p) = debuggee_pid(&msg) {
                pid = Some(p);
            }
            let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
            if v["event"] == "initialized" {
                send(3, "setBreakpoints", serde_json::json!({"source": {"path": source}, "breakpoints": [{"line": line.parse::<u32>().unwrap()}]}));
                send(4, "configurationDone", serde_json::json!({}));
            } else if v["event"] == "stopped" {
                send(5, "stackTrace", serde_json::json!({"threadId": v["body"]["threadId"], "levels": 1}));
            } else if v["command"] == "stackTrace" {
                send(6, "scopes", serde_json::json!({"frameId": v["body"]["stackFrames"][0]["id"]}));
            } else if v["command"] == "scopes" {
                send(7, "variables", serde_json::json!({"variablesReference": v["body"]["scopes"][0]["variablesReference"]}));
            } else if v["command"] == "variables" {
                variables = Some(v["body"]["variables"].clone());
                break;
            }
        }
        let alive_adapter = matches!(child.try_wait(), Ok(None));
        drop(DapProc { child, stdin: None, trace: Arc::new(Mutex::new(None)), debuggee: Arc::new(Mutex::new(pid)) });
        let vars = variables.expect("lldb-dap murió antes de responder las variables");
        assert!(alive_adapter, "lldb-dap terminó");
        let names: Vec<&str> = vars.as_array().unwrap().iter().filter_map(|v| v["name"].as_str()).collect();
        println!("variables: {names:?}");
        assert!(names.contains(&"ui"), "no apareció la variable ui: {names:?}");
    }

    /// Reproduce el fallo SIGTRAP: cerrar la sesión con el programa detenido en un
    /// breakpoint no debe dejarlo huérfano. Requiere lldb-dap y un programa que no termine:
    /// `RAXORIN_DBG_PROGRAM=/ruta/binario RAXORIN_DBG_SOURCE=/ruta/main.rs RAXORIN_DBG_LINE=4 cargo test -- --ignored`
    #[test]
    #[ignore]
    fn cerrar_sesion_no_deja_huerfanos() {
        let (Ok(program), Ok(source), Ok(line)) = (
            std::env::var("RAXORIN_DBG_PROGRAM"),
            std::env::var("RAXORIN_DBG_SOURCE"),
            std::env::var("RAXORIN_DBG_LINE"),
        ) else {
            eprintln!("faltan variables RAXORIN_DBG_*; se omite");
            return;
        };
        let adapter = find_adapter().expect("lldb-dap");
        let mut child = new_command(&adapter).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut send = |seq: u32, cmd: &str, args: serde_json::Value| {
            let m = serde_json::json!({"seq": seq, "type": "request", "command": cmd, "arguments": args}).to_string();
            stdin.write_all(format!("Content-Length: {}\r\n\r\n{m}", m.len()).as_bytes()).unwrap();
            stdin.flush().unwrap();
        };
        send(1, "initialize", serde_json::json!({"adapterID": "lldb-dap", "linesStartAt1": true, "columnsStartAt1": true, "pathFormat": "path"}));
        send(2, "launch", serde_json::json!({"program": program}));
        let mut pid = None;
        loop {
            let msg = read_message(&mut reader).expect("lldb-dap terminó");
            if let Some(p) = debuggee_pid(&msg) {
                pid = Some(p);
            }
            if msg.contains("\"event\":\"initialized\"") {
                send(3, "setBreakpoints", serde_json::json!({"source": {"path": source}, "breakpoints": [{"line": line.parse::<u32>().unwrap()}]}));
                send(4, "configurationDone", serde_json::json!({}));
            }
            if msg.contains("\"event\":\"stopped\"") {
                break;
            }
        }
        let pid = pid.expect("PID del programa");
        assert!(alive(pid), "el programa debería estar vivo y detenido");
        // Peor caso (sesión recién iniciada): el backend aún no conoce el PID.
        let known_pid = if std::env::var("RAXORIN_DBG_UNKNOWN_PID").is_ok() { None } else { Some(pid) };
        // Lo que hace dap_stop / dap_start / salir de la app:
        let reader_thread = thread::spawn(move || while read_message(&mut reader).is_some() {});
        drop(DapProc { child, stdin: Some(stdin), trace: Arc::new(Mutex::new(None)), debuggee: Arc::new(Mutex::new(known_pid)) });
        let _ = reader_thread.join();
        thread::sleep(Duration::from_millis(300));
        assert!(!alive(pid), "el programa depurado quedó huérfano (pid {pid})");
    }
}
