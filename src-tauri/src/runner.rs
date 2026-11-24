//! Compilar, ejecutar y detener programas con cargo, enviando la salida
//! a la interfaz en tiempo real mediante eventos de Tauri.
//!
//! Eventos emitidos:
//! - `output`        { text, kind }   trozo de texto para el panel Salida
//! - `diagnostic`    Diagnostic        un error/advertencia del compilador
//! - `task-finished` TaskFinished      la tarea terminó

use crate::toolchain::{cargo_bin, clippy_available, new_command};
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct ProcState(Arc<Inner>);

#[derive(Default)]
struct Inner {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    running: AtomicBool,
    cancelled: AtomicBool,
}

#[derive(Clone, Serialize)]
struct OutputChunk {
    text: String,
    kind: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    level: String,
    message: String,
    code: Option<String>,
    file: Option<String>,
    line: u64,
    column: u64,
    end_line: u64,
    end_column: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskFinished {
    task: String,
    success: bool,
    code: Option<i32>,
    cancelled: bool,
}

fn out(app: &AppHandle, text: impl Into<String>, kind: &'static str) {
    let _ = app.emit(
        "output",
        OutputChunk {
            text: text.into(),
            kind,
        },
    );
}

/// Inicia una tarea: "build", "check", "test" o "run".
#[tauri::command]
pub fn start_task(
    app: AppHandle,
    state: State<'_, ProcState>,
    project: String,
    task: String,
    external: Option<bool>,
) -> Result<(), String> {
    let inner = state.0.clone();
    if inner.running.swap(true, SeqCst) {
        return Err("Ya hay una tarea en ejecución. Detenla primero.".into());
    }
    inner.cancelled.store(false, SeqCst);

    thread::spawn(move || {
        let result = run_task(
            &app,
            &inner,
            Path::new(&project),
            &task,
            external.unwrap_or(false),
        );
        let cancelled = inner.cancelled.load(SeqCst);
        let (success, code) = result.unwrap_or_else(|e| {
            out(&app, format!("✖ {e}\n"), "error");
            (false, None)
        });
        if cancelled {
            out(&app, "\n■ Detenido por el usuario.\n", "warning");
        }
        inner.running.store(false, SeqCst);
        let _ = app.emit(
            "task-finished",
            TaskFinished {
                task,
                success: success && !cancelled,
                code,
                cancelled,
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub fn stop_task(state: State<'_, ProcState>) -> Result<(), String> {
    state.0.cancelled.store(true, SeqCst);
    if let Some(child) = state.0.child.lock().unwrap().as_mut() {
        let _ = child.kill();
    }
    Ok(())
}

/// Envía una línea de texto a la entrada estándar del programa en ejecución.
#[tauri::command]
pub fn send_stdin(state: State<'_, ProcState>, text: String) -> Result<(), String> {
    let mut guard = state.0.stdin.lock().unwrap();
    let stdin = guard
        .as_mut()
        .ok_or("No hay ningún programa esperando entrada.")?;
    stdin
        .write_all(format!("{text}\n").as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("No se pudo enviar la entrada: {e}"))
}

fn run_task(
    app: &AppHandle,
    inner: &Arc<Inner>,
    project: &Path,
    task: &str,
    external: bool,
) -> Result<(bool, Option<i32>), String> {
    let sub = match task {
        "build" | "run" => "build",
        // "Revisar" usa Clippy (más sugerencias) si está instalado.
        "check" if clippy_available() => "clippy",
        "check" => "check",
        "test" => "test",
        other => return Err(format!("Tarea desconocida: {other}")),
    };

    // 1) Compilar con salida JSON para obtener errores estructurados.
    out(app, format!("> cargo {sub}\n"), "info");
    let start = Instant::now();
    let mut cmd = new_command(cargo_bin());
    cmd.arg(sub)
        .arg("--message-format=json")
        .current_dir(project)
        .env("CARGO_TERM_COLOR", "never");

    let mut executable: Option<PathBuf> = None;
    let (mut errors, mut warnings) = (0u32, 0u32);
    let mut on_line = |line: &str| {
        handle_cargo_line(
            app,
            project,
            line,
            &mut executable,
            &mut errors,
            &mut warnings,
        )
    };
    let status = run_child(app, inner, cmd, false, "muted", Some(&mut on_line))?;

    if inner.cancelled.load(SeqCst) {
        return Ok((false, None));
    }
    let secs = start.elapsed().as_secs_f32();
    let ok = status.map(|s| s.success()).unwrap_or(false);
    if !ok {
        let msg = if task == "test" {
            format!("✖ Las pruebas fallaron o no compilaron ({errors} error(es), {warnings} advertencia(s), {secs:.1}s)\n")
        } else {
            format!("✖ Falló la compilación: {errors} error(es), {warnings} advertencia(s) ({secs:.1}s)\n")
        };
        out(app, msg, "error");
        return Ok((false, status.and_then(|s| s.code())));
    }
    let msg = if task == "test" {
        format!("✔ Todas las pruebas pasaron ({secs:.1}s)\n")
    } else {
        format!("✔ Compilación correcta: 0 errores, {warnings} advertencia(s) ({secs:.1}s)\n")
    };
    out(app, msg, "success");
    if task != "run" {
        return Ok((true, Some(0)));
    }

    // 2) Ejecutar el binario directamente (así su salida no se mezcla con el JSON de cargo).
    let exe = executable.ok_or(
        "Este proyecto no genera un ejecutable (¿es una biblioteca?). Usa Compilar o Probar.",
    )?;
    let name = exe
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    if external {
        launch_in_terminal(project, &exe)?;
        out(
            app,
            format!("▶ {name} se está ejecutando en una terminal externa.\n"),
            "info",
        );
        return Ok((true, Some(0)));
    }

    out(app, format!("> Ejecutando {name}\n\n"), "info");

    let mut cmd = new_command(&exe);
    cmd.current_dir(project);
    let status = run_child(app, inner, cmd, true, "stderr", None)?;
    if inner.cancelled.load(SeqCst) {
        return Ok((false, None));
    }
    let code = status.and_then(|s| s.code());
    match code {
        Some(0) => out(app, "\n✔ El programa terminó (código 0)\n", "success"),
        Some(c) => out(
            app,
            format!("\n✖ El programa terminó con código {c}\n"),
            "error",
        ),
        None => out(app, "\n✖ El programa terminó de forma anormal\n", "error"),
    }
    Ok((code == Some(0), code))
}

/// Lanza un proceso, lo registra para poder detenerlo y transmite su salida.
/// Si `on_line` es `Some`, stdout se procesa línea a línea; si no, se envía
/// tal cual en trozos (para que funcionen los `print!` sin salto de línea).
fn run_child(
    app: &AppHandle,
    inner: &Arc<Inner>,
    mut cmd: Command,
    with_stdin: bool,
    stderr_kind: &'static str,
    on_line: Option<&mut dyn FnMut(&str)>,
) -> Result<Option<ExitStatus>, String> {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if with_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo iniciar {:?}: {e}", cmd.get_program()))?;
    let stdout = child.stdout.take().ok_or("Proceso sin stdout")?;
    let stderr = child.stderr.take().ok_or("Proceso sin stderr")?;
    *inner.stdin.lock().unwrap() = if with_stdin { child.stdin.take() } else { None };
    *inner.child.lock().unwrap() = Some(child);
    // Por si pulsaron Detener justo mientras arrancaba.
    if inner.cancelled.load(SeqCst) {
        if let Some(c) = inner.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }

    let app_err = app.clone();
    let err_thread = thread::spawn(move || stream_chunks(&app_err, stderr, stderr_kind));
    match on_line {
        Some(f) => {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                f(&line);
            }
        }
        None => stream_chunks(app, stdout, "stdout"),
    }
    let _ = err_thread.join();

    *inner.stdin.lock().unwrap() = None;
    let child = inner.child.lock().unwrap().take();
    Ok(child.and_then(|mut c| c.wait().ok()))
}

/// Lee bytes a medida que llegan y los emite como texto, sin partir caracteres UTF-8.
fn stream_chunks<R: Read>(app: &AppHandle, mut reader: R, kind: &'static str) {
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..n]);
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(), // carácter incompleto al final
            Err(_) => pending.len(), // bytes inválidos: se muestran con �
        };
        if valid > 0 {
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out(app, text, kind);
        }
    }
    if !pending.is_empty() {
        out(app, String::from_utf8_lossy(&pending).into_owned(), kind);
    }
}

/// Interpreta una línea JSON de `cargo --message-format=json`.
fn handle_cargo_line(
    app: &AppHandle,
    project: &Path,
    line: &str,
    executable: &mut Option<PathBuf>,
    errors: &mut u32,
    warnings: &mut u32,
) {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            // No es JSON: p. ej. la salida de `cargo test`.
            out(app, format!("{line}\n"), "stdout");
            return;
        }
    };
    match v["reason"].as_str() {
        Some("compiler-message") => {
            let msg = &v["message"];
            let level = msg["level"].as_str().unwrap_or("").to_string();
            let kind = match level.as_str() {
                l if l.starts_with("error") => "error",
                "warning" => "warning",
                _ => "stdout",
            };
            if let Some(rendered) = msg["rendered"].as_str() {
                out(app, rendered.to_string(), kind);
            }
            let primary = msg["spans"]
                .as_array()
                .and_then(|s| s.iter().find(|sp| sp["is_primary"].as_bool() == Some(true)));
            // Los mensajes sin ubicación ("aborting due to...") son solo resúmenes.
            let Some(sp) = primary else { return };
            match kind {
                "error" => *errors += 1,
                "warning" => *warnings += 1,
                _ => {}
            }
            let file = sp["file_name"].as_str().map(|f| {
                let p = Path::new(f);
                let abs = if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    project.join(p)
                };
                abs.to_string_lossy().into_owned()
            });
            let num = |k: &str| sp[k].as_u64().unwrap_or(1);
            let _ = app.emit(
                "diagnostic",
                Diagnostic {
                    level,
                    message: msg["message"].as_str().unwrap_or("").to_string(),
                    code: msg["code"]["code"].as_str().map(String::from),
                    file,
                    line: num("line_start"),
                    column: num("column_start"),
                    end_line: num("line_end"),
                    end_column: num("column_end"),
                },
            );
        }
        Some("compiler-artifact") => {
            let is_bin = v["target"]["kind"]
                .as_array()
                .is_some_and(|k| k.iter().any(|x| x.as_str() == Some("bin")));
            if let (true, Some(exe)) = (is_bin, v["executable"].as_str()) {
                *executable = Some(PathBuf::from(exe));
            }
        }
        _ => {}
    }
}

// ---------- Terminal externa ----------

/// Abre una ventana de terminal del sistema que ejecuta el programa y,
/// al terminar, espera una tecla para que se pueda leer la salida.
fn launch_in_terminal(project: &Path, exe: &Path) -> Result<(), String> {
    let name = exe
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "programa".into());
    let dir = std::env::temp_dir().join("oxide-studio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let err = |e: std::io::Error| format!("No se pudo abrir una terminal: {e}");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = dir.join(format!("{name}.bat"));
        let content = format!(
            "@echo off\r\ntitle {name}\r\ncd /d \"{}\"\r\n\"{}\"\r\necho.\r\necho -- El programa termino con codigo %ERRORLEVEL% --\r\npause\r\n",
            project.display(),
            exe.display()
        );
        std::fs::write(&script, content).map_err(|e| e.to_string())?;
        Command::new("cmd")
            .arg("/C")
            .arg(&script)
            .creation_flags(0x0000_0010) // CREATE_NEW_CONSOLE
            .spawn()
            .map_err(err)?;
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let q = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"));
        let ext = if cfg!(target_os = "macos") {
            "command"
        } else {
            "sh"
        };
        let script = dir.join(format!("{name}.{ext}"));
        let content = format!(
            "#!/bin/bash\nclear\ncd {}\n{}\ncode=$?\necho\necho \"── El programa terminó con código $code. Presiona Enter para cerrar ──\"\nread -r\n",
            q(project),
            q(exe)
        );
        std::fs::write(&script, content).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;

        if cfg!(target_os = "macos") {
            Command::new("open")
                .args(["-a", "Terminal"])
                .arg(&script)
                .spawn()
                .map_err(err)?;
            return Ok(());
        }
        // Linux: probar las terminales más comunes.
        const TERMINALS: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["-e"]),
            ("gnome-terminal", &["--"]),
            ("konsole", &["-e"]),
            ("xfce4-terminal", &["-x"]),
            ("alacritty", &["-e"]),
            ("kitty", &[]),
            ("xterm", &["-e"]),
        ];
        for (term, args) in TERMINALS {
            if Command::new(term)
                .args(*args)
                .arg("bash")
                .arg(&script)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("No se encontró ninguna terminal (gnome-terminal, konsole, xterm…).".into())
    }
}
