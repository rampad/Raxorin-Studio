//! Compilar, ejecutar y detener programas con cargo, enviando la salida
//! a la interfaz en tiempo real mediante eventos de Tauri.
//!
//! Eventos emitidos:
//! - `output`        { text, kind }   trozo de texto para el panel Salida
//! - `diagnostic`    Diagnostic        un error/advertencia del compilador
//! - `task-finished` TaskFinished      la tarea terminó

use crate::toolchain::{cargo_bin, clippy_available, new_command};
use serde::{Deserialize, Serialize};
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
pub(crate) struct Inner {
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

#[derive(Clone, Serialize)]
struct DebugReady {
    program: String,
    cwd: String,
}

pub(crate) fn out(app: &AppHandle, text: impl Into<String>, kind: &'static str) {
    let _ = app.emit(
        "output",
        OutputChunk {
            text: text.into(),
            kind,
        },
    );
}

/// Opciones de "Publicar": compilar en Release y dejar el ejecutable listo para distribuir.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublishOptions {
    /// Carpeta donde se crea `<nombre>-<versión>-<plataforma>/`.
    pub out_dir: String,
    /// Plataforma de destino (`--target`); None = la de esta computadora.
    pub target: Option<String>,
    /// Crear además un .zip de la carpeta.
    pub zip: bool,
    /// Mostrar el resultado en Finder/Explorador al terminar.
    pub open: bool,
}

/// Inicia una tarea: "build", "check", "test", "run", "debug" o "publish".
#[tauri::command]
pub fn start_task(
    app: AppHandle,
    state: State<'_, ProcState>,
    project: String,
    task: String,
    external: Option<bool>,
    release: Option<bool>,
    publish: Option<PublishOptions>,
) -> Result<(), String> {
    let inner = state.0.clone();
    if inner.running.swap(true, SeqCst) {
        return Err("Ya hay una tarea en ejecución. Detenla primero.".into());
    }
    inner.cancelled.store(false, SeqCst);

    thread::spawn(move || {
        let opts = TaskOptions {
            external: external.unwrap_or(false),
            // Depurar siempre usa Debug (con símbolos); publicar siempre Release.
            release: task == "publish" || (task != "debug" && release.unwrap_or(false)),
            publish,
        };
        let result = run_task(&app, &inner, Path::new(&project), &task, &opts);
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

struct TaskOptions {
    external: bool,
    release: bool,
    publish: Option<PublishOptions>,
}

fn run_task(
    app: &AppHandle,
    inner: &Arc<Inner>,
    project: &Path,
    task: &str,
    opts: &TaskOptions,
) -> Result<(bool, Option<i32>), String> {
    let external = opts.external;
    if let Some(tool) = task.strip_prefix("setup:") {
        return crate::setup::install(app, inner, tool);
    }
    if task == "setup-target" {
        let target = opts.publish.as_ref().and_then(|p| p.target.clone()).ok_or("Falta la plataforma")?;
        return setup_target(app, inner, &target);
    }
    let sub = match task {
        "build" | "run" | "debug" | "publish" => "build",
        // "Revisar" usa Clippy (más sugerencias) si está instalado.
        "check" if clippy_available() => "clippy",
        "check" => "check",
        "test" => "test",
        other => return Err(format!("Tarea desconocida: {other}")),
    };

    // 1) Compilar con salida JSON para obtener errores estructurados.
    let mut extra: Vec<String> = Vec::new();
    if opts.release {
        extra.push("--release".into());
    }
    let target = opts.publish.as_ref().and_then(|p| p.target.clone()).filter(|t| !t.is_empty());
    if let Some(t) = &target {
        extra.push("--target".into());
        extra.push(t.clone());
    }
    out(app, format!("> cargo {sub}{}{}\n", if extra.is_empty() { "" } else { " " }, extra.join(" ")), "info");
    let start = Instant::now();
    let cmd = cargo_command(project, sub, &extra, target.as_deref());

    let mut executable: Option<PathBuf> = None;
    let (mut errors, mut warnings) = (0u32, 0u32);
    let mut linker_problem = false;
    let mut on_line = |line: &str| {
        // Errores del enlazador (sin link.exe, sin el SDK de Windows, sin compilador de C).
        if linker_hint(line) {
            linker_problem = true;
        }
        handle_cargo_line(
            app,
            project,
            line,
            &mut executable,
            &mut errors,
            &mut warnings,
        )
    };
    let status = run_child(app, inner, cmd, false, "muted", Some(&mut on_line), None)?;

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
        if linker_problem {
            out(
                app,
                "→ El error viene del enlazador: falta (o está incompleto) el compilador de C/C++ del sistema. \
                 Abre Ayuda → Herramientas necesarias para instalarlo o repararlo.\n",
                "warning",
            );
        }
        return Ok((false, status.and_then(|s| s.code())));
    }
    let msg = if task == "test" {
        format!("✔ Todas las pruebas pasaron ({secs:.1}s)\n")
    } else {
        format!("✔ Compilación correcta: 0 errores, {warnings} advertencia(s) ({secs:.1}s)\n")
    };
    out(app, msg, "success");
    if task == "publish" {
        let opts = opts.publish.as_ref().ok_or("Faltan las opciones de publicación")?;
        let exe = executable.ok_or(
            "Este proyecto no genera un ejecutable (¿es una biblioteca?). Elige un proyecto de consola o de ventana.",
        )?;
        let result = publish_output(&|t, k| out(app, t, k), project, &exe, opts, target.as_deref())?;
        if opts.open {
            let _ = crate::fs_cmds::reveal_path(result.to_string_lossy().into_owned());
        }
        return Ok((true, Some(0)));
    }
    if task != "run" && task != "debug" {
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

    if task == "debug" {
        out(app, "> Iniciando el depurador…\n", "info");
        let _ = app.emit(
            "debug-ready",
            DebugReady { program: exe.to_string_lossy().into_owned(), cwd: project.to_string_lossy().into_owned() },
        );
        return Ok((true, Some(0)));
    }

    if external {
        launch_in_terminal(project, &exe)?;
        crate::monitor::start(app, crate::monitor::Target::Exe(exe.clone()), "run");
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
    let status = run_child(app, inner, cmd, true, "stderr", None, Some(&|pid| {
        crate::monitor::start(app, crate::monitor::Target::Pid(pid), "run")
    }))?;
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
pub(crate) fn run_child(
    app: &AppHandle,
    inner: &Arc<Inner>,
    mut cmd: Command,
    with_stdin: bool,
    stderr_kind: &'static str,
    on_line: Option<&mut dyn FnMut(&str)>,
    on_spawn: Option<&dyn Fn(u32)>,
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
    if let Some(f) = on_spawn {
        f(child.id());
    }
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
    let dir = std::env::temp_dir().join("raxorin-studio");
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

/// ¿La línea de cargo habla de un problema del enlazador?
fn linker_hint(line: &str) -> bool {
    ["linker `link.exe` not found", "linking with `link.exe` failed", "LNK1181", "LNK1104", "kernel32.lib",
     "linker `cc` not found", "linker `clang` not found", "link: extra operand", "xcrun: error: invalid active developer path"]
        .iter()
        .any(|p| line.contains(p))
}

/// Comando de cargo para compilar. Si se compila para otra plataforma, le indica el
/// enlazador y pone sus herramientas en el PATH (una app abierta desde Finder no las ve).
fn cargo_command(project: &Path, sub: &str, extra: &[String], target: Option<&str>) -> Command {
    let mut cmd = new_command(cargo_bin());
    cmd.arg(sub)
        .args(extra)
        .arg("--message-format=json")
        .current_dir(project)
        .env("CARGO_TERM_COLOR", "never");
    if let Some(t) = target {
        // Indicar a cargo el enlazador por ruta completa: una app abierta desde Finder no
        // tiene /opt/homebrew/bin en el PATH.
        if let Some(linker) = cross_linker(t).and_then(crate::toolchain::find_tool) {
            cmd.env(format!("CARGO_TARGET_{}_LINKER", t.to_uppercase().replace(['-', '.'], "_")), &linker);
            // rustc también usa otras herramientas de MinGW (dlltool) y las busca en el PATH.
            if let Some(dir) = linker.parent() {
                // Partir del PATH que ya tiene el comando (incluye ~/.cargo/bin).
                let current = cmd
                    .get_envs()
                    .find(|(k, _)| *k == "PATH")
                    .and_then(|(_, v)| v.map(|v| v.to_os_string()))
                    .or_else(|| std::env::var_os("PATH"))
                    .unwrap_or_default();
                let paths = std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&current));
                if let Ok(joined) = std::env::join_paths(paths) {
                    cmd.env("PATH", joined);
                }
            }
        }
    }
    cmd
}

// ---------- Publicar ----------

/// Nombre y versión del paquete (de su Cargo.toml).
fn package_info(project: &Path, exe: &Path) -> (String, Option<String>) {
    let fallback = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "programa".into());
    let Ok(text) = std::fs::read_to_string(project.join("Cargo.toml")) else { return (fallback, None) };
    let Ok(doc) = text.parse::<toml::Table>() else { return (fallback, None) };
    let pkg = doc.get("package").and_then(|p| p.as_table());
    let name = pkg.and_then(|p| p.get("name")).and_then(|v| v.as_str()).map(String::from).unwrap_or(fallback);
    let version = pkg.and_then(|p| p.get("version")).and_then(|v| v.as_str()).map(String::from);
    (name, version)
}

/// Etiqueta de la plataforma: el `--target` elegido o la de esta computadora.
pub fn platform_label(target: Option<&str>) -> String {
    match target {
        Some(t) if t.contains("windows") => format!("windows-{}", t.split('-').next().unwrap_or("x86_64")),
        Some(t) if t.contains("apple-darwin") => format!("macos-{}", t.split('-').next().unwrap_or("")),
        Some(t) if t.contains("linux") => format!("linux-{}", t.split('-').next().unwrap_or("")),
        Some(t) => t.to_string(),
        None => {
            format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
        }
    }
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", (bytes / 1024).max(1))
    }
}

/// Copia el ejecutable (y README/LICENSE si existen) a una carpeta lista para distribuir
/// y, si se pidió, la comprime en .zip. Devuelve la ruta del resultado.
fn publish_output(
    log: &dyn Fn(String, &'static str),
    project: &Path,
    exe: &Path,
    opts: &PublishOptions,
    target: Option<&str>,
) -> Result<PathBuf, String> {
    let (name, version) = package_info(project, exe);
    let folder_name = match &version {
        Some(v) => format!("{name}-{v}-{}", platform_label(target)),
        None => format!("{name}-{}", platform_label(target)),
    };
    let out_dir = PathBuf::from(&opts.out_dir);
    let folder = out_dir.join(&folder_name);
    if folder.exists() {
        std::fs::remove_dir_all(&folder).map_err(|e| format!("No se pudo limpiar {}: {e}", folder.display()))?;
    }
    std::fs::create_dir_all(&folder).map_err(|e| format!("No se pudo crear {}: {e}", folder.display()))?;

    let exe_name = exe.file_name().ok_or("Ejecutable sin nombre")?;
    let dest = folder.join(exe_name);
    std::fs::copy(exe, &dest).map_err(|e| format!("No se pudo copiar el ejecutable: {e}"))?;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    log(format!("  {} ({})\n", exe_name.to_string_lossy(), human_size(size)), "muted");

    // Archivos que conviene acompañar al ejecutable.
    if let Ok(entries) = std::fs::read_dir(project) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_uppercase();
            let wanted = n.starts_with("README") || n.starts_with("LICENSE") || n.starts_with("LICENCIA");
            if wanted && e.path().is_file() && std::fs::copy(e.path(), folder.join(e.file_name())).is_ok() {
                log(format!("  {}\n", e.file_name().to_string_lossy()), "muted");
            }
        }
    }

    let mut result = folder.clone();
    if opts.zip {
        let zip = out_dir.join(format!("{folder_name}.zip"));
        let _ = std::fs::remove_file(&zip);
        make_zip(&out_dir, &folder_name, &zip)?;
        let zsize = std::fs::metadata(&zip).map(|m| m.len()).unwrap_or(0);
        log(format!("  {} ({})\n", zip.file_name().unwrap().to_string_lossy(), human_size(zsize)), "muted");
        result = zip;
    }
    log(format!("✔ Publicado en {}\n", result.display()), "success");
    Ok(result)
}

/// Comprime `dir/name` en `zip` con las herramientas del sistema
/// (bsdtar en macOS y Windows 10+, `zip` en Linux).
fn make_zip(dir: &Path, name: &str, zip: &Path) -> Result<(), String> {
    let status = if cfg!(target_os = "linux") {
        Command::new("zip").arg("-rq").arg(zip).arg(name).current_dir(dir).status()
    } else {
        new_command("tar").arg("-a").arg("-c").arg("-f").arg(zip).arg(name).current_dir(dir).status()
    };
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("No se pudo crear el .zip (código {:?})", s.code())),
        Err(e) => Err(format!("No se pudo crear el .zip: {e}")),
    }
}

/// Plataformas para las que se puede compilar: la de esta computadora y las instaladas con rustup.
#[derive(Serialize)]
pub struct RustTargets {
    host: String,
    installed: Vec<String>,
}

#[tauri::command]
pub fn rust_targets() -> RustTargets {
    let host = new_command(crate::toolchain::rustup_tool("rustc"))
        .arg("-vV")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("host: ").map(String::from)))
        .unwrap_or_default();
    let installed = new_command(crate::toolchain::rustup_tool("rustup"))
        .args(["target", "list", "--installed"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();
    RustTargets { host, installed }
}

// ---------- Compilar para otras plataformas ----------

/// Enlazador que necesita una plataforma ajena (None = el de Rust alcanza).
fn cross_linker(target: &str) -> Option<&'static str> {
    match target {
        "x86_64-pc-windows-gnu" => Some("x86_64-w64-mingw32-gcc"),
        "i686-pc-windows-gnu" => Some("i686-w64-mingw32-gcc"),
        _ => None,
    }
}

fn target_installed(target: &str) -> bool {
    new_command(crate::toolchain::rustup_tool("rustup"))
        .args(["target", "list", "--installed"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim() == target))
        .unwrap_or(false)
}

/// Qué tiene y qué le falta a esta computadora para compilar para `target`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossStatus {
    target: String,
    rust_target: bool,
    linker: Option<String>,
    linker_found: bool,
    /// Se puede instalar lo que falta con un clic (rustup + Homebrew en macOS).
    can_install: bool,
    /// Instrucciones si hay que instalar algo a mano.
    manual: Option<String>,
}

#[tauri::command]
pub fn cross_status(target: String) -> CrossStatus {
    let linker = cross_linker(&target);
    let linker_found = linker.map(|l| crate::toolchain::find_tool(l).is_some()).unwrap_or(true);
    let brew = crate::toolchain::find_tool("brew").is_some();
    let manual = if linker_found {
        None
    } else if cfg!(target_os = "macos") && !brew {
        Some("Instala Homebrew (https://brew.sh) y luego: brew install mingw-w64".into())
    } else if cfg!(target_os = "linux") {
        Some("Instala MinGW-w64 con tu gestor de paquetes, por ejemplo: sudo apt install mingw-w64".into())
    } else {
        None
    };
    CrossStatus {
        rust_target: target_installed(&target),
        linker: linker.map(String::from),
        linker_found,
        can_install: linker_found || (cfg!(target_os = "macos") && brew),
        manual,
        target,
    }
}

/// Instala lo necesario para compilar para `target`: la plataforma de Rust y, en macOS, el enlazador.
fn setup_target(app: &AppHandle, inner: &Arc<Inner>, target: &str) -> Result<(bool, Option<i32>), String> {
    if !target_installed(target) {
        out(app, format!("> rustup target add {target}\n"), "info");
        let mut cmd = new_command(crate::toolchain::rustup_tool("rustup"));
        cmd.args(["target", "add", target]);
        let ok = run_child(app, inner, cmd, false, "muted", None, None)?.map(|s| s.success()).unwrap_or(false);
        if !ok || inner.cancelled.load(SeqCst) {
            out(app, "✖ No se pudo instalar la plataforma de Rust.\n", "error");
            return Ok((false, None));
        }
    } else {
        out(app, format!("✔ La plataforma {target} ya está instalada.\n"), "muted");
    }
    if let Some(linker) = cross_linker(target) {
        if crate::toolchain::find_tool(linker).is_some() {
            out(app, format!("✔ El enlazador {linker} ya está instalado.\n"), "muted");
        } else if cfg!(target_os = "macos") {
            let brew = crate::toolchain::find_tool("brew").ok_or("Falta Homebrew: instálalo desde https://brew.sh")?;
            out(app, "> brew install mingw-w64   (puede tardar unos minutos)\n", "info");
            let mut cmd = new_command(brew);
            cmd.args(["install", "mingw-w64"]).env("HOMEBREW_NO_AUTO_UPDATE", "1");
            let ok = run_child(app, inner, cmd, false, "muted", None, None)?.map(|s| s.success()).unwrap_or(false);
            if !ok || inner.cancelled.load(SeqCst) {
                out(app, "✖ No se pudo instalar MinGW-w64.\n", "error");
                return Ok((false, None));
            }
        } else {
            return Err("Instala MinGW-w64 con tu gestor de paquetes (por ejemplo: sudo apt install mingw-w64).".into());
        }
    }
    out(app, "✔ Listo: ya puedes publicar para esta plataforma.\n", "success");
    Ok((true, Some(0)))
}

#[cfg(test)]
mod publish_tests {
    use super::*;

    #[test]
    fn nombre_y_version_del_paquete() {
        let dir = std::env::temp_dir().join(format!("raxorin-pub-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"mi_app\"\nversion = \"1.2.3\"\n").unwrap();
        let (n, v) = package_info(&dir, Path::new("/x/mi_app"));
        assert_eq!((n.as_str(), v.as_deref()), ("mi_app", Some("1.2.3")));
        // version.workspace = true: sin versión, pero con nombre.
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"otra\"\nversion.workspace = true\n").unwrap();
        assert_eq!(package_info(&dir, Path::new("/x/otra")), ("otra".into(), None));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn etiqueta_de_plataforma() {
        assert_eq!(platform_label(Some("x86_64-pc-windows-gnu")), "windows-x86_64");
        assert_eq!(platform_label(Some("wasm32-unknown-unknown")), "wasm32-unknown-unknown");
        assert!(platform_label(None).contains(std::env::consts::ARCH));
    }

    #[test]
    fn publica_carpeta_y_zip() {
        let dir = std::env::temp_dir().join(format!("raxorin-pubfull-{}", std::process::id()));
        let proj = dir.join("proyecto");
        std::fs::create_dir_all(proj.join("target/release")).unwrap();
        std::fs::write(proj.join("Cargo.toml"), "[package]\nname = \"mi_app\"\nversion = \"0.3.0\"\n").unwrap();
        std::fs::write(proj.join("README.md"), "# Mi app").unwrap();
        std::fs::write(proj.join("notas.txt"), "no se copia").unwrap();
        let exe = proj.join("target/release/mi_app");
        std::fs::write(&exe, b"binario").unwrap();
        let opts = PublishOptions { out_dir: dir.join("salida").to_string_lossy().into(), target: None, zip: true, open: false };
        let lines = std::cell::RefCell::new(Vec::new());
        let res = publish_output(&|t, _| lines.borrow_mut().push(t), &proj, &exe, &opts, None).unwrap();
        let folder = dir.join("salida").join(format!("mi_app-0.3.0-{}", platform_label(None)));
        assert_eq!(std::fs::read(folder.join("mi_app")).unwrap(), b"binario");
        assert!(folder.join("README.md").exists(), "copia el README");
        assert!(!folder.join("notas.txt").exists(), "no copia otros archivos");
        assert_eq!(res.extension().unwrap(), "zip");
        assert_eq!(&std::fs::read(&res).unwrap()[..2], b"PK");
        assert!(lines.borrow().last().unwrap().contains("Publicado"));
        // Publicar de nuevo reemplaza la carpeta anterior sin fallar.
        publish_output(&|_, _| {}, &proj, &exe, &opts, None).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Compila de verdad para Windows (necesita la plataforma y MinGW-w64 instalados):
    /// RAXORIN_WIN_PROJECT=/ruta/a/proyecto cargo test --lib -- --ignored compila_para_windows
    #[test]
    #[ignore]
    fn compila_para_windows() {
        let project = std::env::var("RAXORIN_WIN_PROJECT").expect("RAXORIN_WIN_PROJECT");
        let mut cmd = cargo_command(Path::new(&project), "build", &["--release".into(), "--target".into(), "x86_64-pc-windows-gnu".into()], Some("x86_64-pc-windows-gnu"));
        // Simular una app abierta desde Finder: sin Homebrew en el PATH del proceso.
        let path = cmd.get_envs().find(|(k, _)| *k == "PATH").and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned())).unwrap_or_default();
        assert!(path.starts_with("/opt/homebrew/bin") || path.contains("mingw"), "PATH sin MinGW: {path}");
        let status = cmd.env("CARGO_TERM_COLOR", "never").stdout(Stdio::null()).status().unwrap();
        assert!(status.success());
    }

    #[test]
    fn detecta_errores_del_enlazador() {
        assert!(linker_hint(r#"{"message":"linker `link.exe` not found"}"#));
        assert!(linker_hint("LINK : fatal error LNK1181: cannot open input file 'kernel32.lib'"));
        assert!(!linker_hint("error[E0425]: cannot find value `x` in this scope"));
    }

    #[test]
    fn crea_zip() {
        let dir = std::env::temp_dir().join(format!("raxorin-zip-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("app-1.0")).unwrap();
        std::fs::write(dir.join("app-1.0/app"), b"hola").unwrap();
        let zip = dir.join("app-1.0.zip");
        make_zip(&dir, "app-1.0", &zip).unwrap();
        let bytes = std::fs::read(&zip).unwrap();
        assert_eq!(&bytes[..2], b"PK", "debe ser un .zip");
        std::fs::remove_dir_all(&dir).ok();
    }
}
