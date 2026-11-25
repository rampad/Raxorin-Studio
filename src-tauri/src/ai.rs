//! Chat con IA del IDE: lo que necesita del sistema la interfaz (src/ai/).
//!
//! - Claves de API (Anthropic, Gemini) en el llavero del sistema.
//! - Las herramientas del servidor MCP (src/mcp.rs) para los agentes por API, limitadas al proyecto.
//! - Agentes por CLI (Claude Code, GitHub Copilot): se lanzan con stdio por tuberías y cada línea
//!   de su salida llega como evento `ai-agent-line`. El protocolo (stream-json de Claude Code, ACP de
//!   Copilot) lo habla la interfaz.
//! - Puente de aprobación: Claude Code pregunta por permisos a la herramienta `approve` del MCP de
//!   Raxorin, que pregunta a esta ventana por un socket local con clave (evento `ai-approval`).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

const SERVICE: &str = "dev.raxorin.studio.ai";

fn provider_ok(p: &str) -> Result<(), String> {
    if ["anthropic", "gemini"].contains(&p) { Ok(()) } else { Err(format!("Proveedor desconocido: {p}")) }
}

#[tauri::command]
pub fn ai_key_get(provider: String) -> Result<Option<String>, String> {
    provider_ok(&provider)?;
    let entry = keyring::Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("No se pudo leer la clave del llavero: {e}")),
    }
}

#[tauri::command]
pub fn ai_key_set(provider: String, key: Option<String>) -> Result<(), String> {
    provider_ok(&provider)?;
    let entry = keyring::Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    match key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => entry.set_password(&k).map_err(|e| format!("No se pudo guardar la clave en el llavero: {e}")),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("No se pudo borrar la clave del llavero: {e}")),
        },
    }
}

// ---------- Herramientas (agentes por API) ----------

#[tauri::command]
pub fn ai_tools() -> Value {
    crate::mcp::tools()
}

/// Ejecuta una herramienta del MCP limitada a las carpetas del proyecto. La interfaz ya pidió
/// aprobación para las que cambian archivos o ejecutan el programa.
#[tauri::command]
pub async fn ai_tool(roots: Vec<String>, name: String, args: Value) -> Result<Value, String> {
    if roots.is_empty() {
        return Err("Abre un proyecto para que la IA pueda usar sus archivos.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<PathBuf> = roots.iter().map(PathBuf::from).collect();
        let server = crate::mcp::Server::for_roots(&roots);
        Ok(match crate::mcp::call_tool(&server, &name, &args, &None) {
            Ok(v) => v,
            Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Agentes por CLI ----------

#[derive(Serialize, Clone)]
pub struct CliInfo {
    path: String,
    version: String,
}

#[derive(Serialize)]
pub struct CliStatus {
    claude: Option<CliInfo>,
    copilot: Option<CliInfo>,
    gemini: Option<CliInfo>,
    /// Ejecutable de Raxorin Studio (para lanzar su MCP desde los agentes).
    exe: String,
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Carpetas donde suelen quedar las CLI (una app abierta desde Finder no tiene el PATH de la terminal).
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(h) = home() {
        for d in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin", "bin"] {
            dirs.push(h.join(d));
        }
        // nvm: todas las versiones de Node instaladas.
        if let Ok(rd) = std::fs::read_dir(h.join(".nvm/versions/node")) {
            dirs.extend(rd.flatten().map(|e| e.path().join("bin")));
        }
    }
    if cfg!(windows) {
        if let Some(a) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(a).join("npm"));
        }
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&l).join("Programs").join("claude"));
        }
    } else {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    }
    dirs
}

fn find_cli(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) { vec![format!("{name}.exe"), format!("{name}.cmd")] } else { vec![name.to_string()] };
    search_dirs().into_iter().flat_map(|d| names.iter().map(move |n| d.join(n)).collect::<Vec<_>>()).find(|p| p.is_file())
}

/// PATH para los agentes: el del sistema más las carpetas habituales (Copilot necesita `node`).
fn agent_path() -> Option<std::ffi::OsString> {
    std::env::join_paths(search_dirs()).ok()
}

fn cli_info(name: &str) -> Option<CliInfo> {
    let path = find_cli(name)?;
    let mut cmd = crate::toolchain::new_command(&path);
    if let Some(p) = agent_path() {
        cmd.env("PATH", p);
    }
    let out = cmd.arg("--version").stdin(Stdio::null()).output().ok()?;
    let version = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
    Some(CliInfo { path: path.to_string_lossy().into_owned(), version })
}

#[tauri::command]
pub async fn ai_cli_status() -> Result<CliStatus, String> {
    tauri::async_runtime::spawn_blocking(|| CliStatus {
        claude: cli_info("claude"),
        copilot: cli_info("copilot"),
        gemini: cli_info("gemini"),
        exe: std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    })
    .await
    .map_err(|e| e.to_string())
}

/// Las CLI de IA que el chat puede ejecutar.
const AGENT_CLIS: &[&str] = &["claude", "copilot", "gemini"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAuth {
    /// None: la CLI no dice si hay sesión (se sabe al usarla).
    logged_in: Option<bool>,
    /// Cuenta y forma de acceso, para mostrar (p. ej. «ana@… · suscripción de Claude»).
    account: Option<String>,
    method: Option<String>,
}

/// Si la CLI tiene la sesión iniciada. Claude Code lo dice (`claude auth status`); Gemini CLI guarda
/// sus credenciales de Google en ~/.gemini/oauth_creds.json; Copilot no lo informa.
#[tauri::command]
pub async fn ai_cli_auth(program: String) -> Result<CliAuth, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let unknown = CliAuth { logged_in: None, account: None, method: None };
        match program.as_str() {
            "claude" => {
                let Some(path) = find_cli("claude") else { return unknown };
                let mut cmd = crate::toolchain::new_command(&path);
                if let Some(p) = agent_path() {
                    cmd.env("PATH", p);
                }
                let Ok(out) = cmd.args(["auth", "status", "--json"]).stdin(Stdio::null()).output() else { return unknown };
                let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) else { return unknown };
                CliAuth {
                    logged_in: v["loggedIn"].as_bool(),
                    account: v["email"].as_str().map(String::from),
                    method: v["authMethod"].as_str().map(String::from),
                }
            }
            "gemini" => {
                let google = home().is_some_and(|h| h.join(".gemini").join("oauth_creds.json").is_file());
                if google { CliAuth { logged_in: Some(true), account: None, method: Some("google".into()) } } else { unknown }
            }
            _ => unknown,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Modelos de Gemini CLI (`gemini --list-models`); vacío si no se pudo.
#[tauri::command]
pub async fn ai_cli_models(program: String) -> Result<Vec<String>, String> {
    if program != "gemini" {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = find_cli("gemini") else { return Vec::new() };
        let mut cmd = crate::toolchain::new_command(&path);
        if let Some(p) = agent_path() {
            cmd.env("PATH", p);
        }
        let Ok(out) = cmd.arg("--list-models").stdin(Stdio::null()).output() else { return Vec::new() };
        parse_gemini_models(&String::from_utf8_lossy(&out.stdout))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Líneas «gemini-3.5-flash (gemini-3.5-flash)» o «auto (Auto)» de `gemini --list-models`.
fn parse_gemini_models(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.starts_with(char::is_whitespace))
        .filter_map(|l| l.split_once(" (").map(|(id, _)| id.trim().to_string()))
        .filter(|id| !id.is_empty() && !id.contains(' '))
        .collect()
}

struct Agent {
    child: Child,
    stdin: Option<ChildStdin>,
}

fn agents() -> &'static Mutex<HashMap<String, Agent>> {
    static A: OnceLock<Mutex<HashMap<String, Agent>>> = OnceLock::new();
    A.get_or_init(Default::default)
}

#[derive(Serialize, Clone)]
struct AgentLine {
    id: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct AgentExit {
    id: String,
    code: Option<i32>,
    stderr: String,
}

/// Lanza `claude` o `copilot` con los argumentos dados. `env` agrega variables (p. ej. la clave del
/// puente de aprobación). Cada línea de la salida estándar llega como `ai-agent-line`.
#[tauri::command]
pub fn ai_agent_start(app: AppHandle, id: String, program: String, args: Vec<String>, cwd: String, env: Option<HashMap<String, String>>) -> Result<(), String> {
    if !AGENT_CLIS.contains(&program.as_str()) {
        return Err(format!("Programa no permitido: {program}"));
    }
    let path = find_cli(&program).ok_or_else(|| format!("No se encontró «{program}» instalado."))?;
    ai_agent_stop(id.clone());
    let mut cmd = crate::toolchain::new_command(&path);
    cmd.args(&args).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(p) = agent_path() {
        cmd.env("PATH", p);
    }
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo iniciar {program}: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdin = child.stdin.take();
    let err_buf = Arc::new(Mutex::new(String::new()));
    {
        let err_buf = err_buf.clone();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = BufReader::new(stderr).take(256 * 1024).read_to_string(&mut s);
            *err_buf.lock().unwrap() = s;
        });
    }
    agents().lock().unwrap().insert(id.clone(), Agent { child, stdin });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = app.emit("ai-agent-line", AgentLine { id: id.clone(), line });
            }
        }
        // Terminó: esperar el proceso (si sigue en la tabla) y avisar.
        let child = agents().lock().unwrap().remove(&id);
        let code = child.and_then(|mut a| a.child.wait().ok()).and_then(|s| s.code());
        std::thread::sleep(Duration::from_millis(100));
        let stderr = err_buf.lock().unwrap().clone();
        let tail: String = stderr.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect();
        let _ = app.emit("ai-agent-exit", AgentExit { id, code, stderr: tail });
    });
    Ok(())
}

#[tauri::command]
pub fn ai_agent_send(id: String, line: String) -> Result<(), String> {
    let mut map = agents().lock().unwrap();
    let agent = map.get_mut(&id).ok_or("El agente ya no está en ejecución.")?;
    let stdin = agent.stdin.as_mut().ok_or("El agente no acepta más mensajes.")?;
    writeln!(stdin, "{line}").and_then(|_| stdin.flush()).map_err(|e| format!("No se pudo enviar al agente: {e}"))
}

#[tauri::command]
pub fn ai_agent_stop(id: String) {
    if let Some(mut a) = agents().lock().unwrap().remove(&id) {
        drop(a.stdin.take());
        let _ = a.child.kill();
        let _ = a.child.wait();
    }
}

/// Al cerrar Raxorin Studio: terminar los agentes.
pub fn stop_all() {
    for (_, mut a) in agents().lock().unwrap().drain() {
        let _ = a.child.kill();
    }
}

// ---------- Puente de aprobación ----------

#[derive(Serialize, Clone)]
pub struct Bridge {
    addr: String,
    token: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequest {
    req_id: u64,
    tool_name: String,
    input: Value,
}

fn pending() -> &'static Mutex<HashMap<u64, Sender<Value>>> {
    static P: OnceLock<Mutex<HashMap<u64, Sender<Value>>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

fn random_token() -> String {
    // 32 bytes aleatorios: /dev/urandom, o en Windows las claves de RandomState (que std toma del
    // generador del sistema) aplicadas a la hora.
    let mut bytes = [0u8; 32];
    #[cfg(unix)]
    {
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            let _ = f.read_exact(&mut bytes);
        }
    }
    #[cfg(windows)]
    {
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        for chunk in bytes.chunks_mut(8) {
            let mut h = RandomState::new().build_hasher();
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
            chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Inicia (una vez) el puente local de aprobación y devuelve su dirección y clave.
#[tauri::command]
pub fn ai_bridge(app: AppHandle) -> Result<Bridge, String> {
    static B: OnceLock<Bridge> = OnceLock::new();
    if let Some(b) = B.get() {
        return Ok(b.clone());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let bridge = Bridge { addr: listener.local_addr().map_err(|e| e.to_string())?.to_string(), token: random_token() };
    let token = bridge.token.clone();
    std::thread::spawn(move || {
        let next = Arc::new(Mutex::new(0u64));
        for stream in listener.incoming().flatten() {
            let (app, token, next) = (app.clone(), token.clone(), next.clone());
            std::thread::spawn(move || handle_bridge(stream, &app, &token, &next));
        }
    });
    Ok(B.get_or_init(|| bridge).clone())
}

fn handle_bridge(stream: TcpStream, app: &AppHandle, token: &str, next: &Mutex<u64>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let Ok(msg) = serde_json::from_str::<Value>(&line) else { return };
    let mut out = stream;
    if msg["token"].as_str() != Some(token) {
        let _ = writeln!(out, "{}", json!({ "allow": false, "message": "Invalid approval token." }));
        return;
    }
    let req_id = {
        let mut n = next.lock().unwrap();
        *n += 1;
        *n
    };
    let (tx, rx) = channel();
    pending().lock().unwrap().insert(req_id, tx);
    let _ = app.emit("ai-approval", ApprovalRequest {
        req_id,
        tool_name: msg["toolName"].as_str().unwrap_or("?").to_string(),
        input: msg["input"].clone(),
    });
    // Sin límite de tiempo: la persona puede tardar en revisar un cambio.
    let reply = rx.recv().unwrap_or(json!({ "allow": false, "message": "Raxorin Studio closed." }));
    let _ = writeln!(out, "{reply}");
}

#[tauri::command]
pub fn ai_approval_reply(req_id: u64, allow: bool, message: Option<String>) {
    if let Some(tx) = pending().lock().unwrap().remove(&req_id) {
        let _ = tx.send(json!({ "allow": allow, "message": message }));
    }
}

/// Escribe un archivo que solo puede leer el usuario (p. ej. la configuración MCP de Claude Code con
/// la clave del puente) y devuelve su ruta. Se guarda en la carpeta temporal de Raxorin Studio.
#[tauri::command]
pub fn ai_private_file(name: String, content: String) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("Nombre de archivo inválido.".into());
    }
    let dir = std::env::temp_dir().join(format!("raxorin-studio-ai-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        opts.mode(0o600);
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let mut f = opts.open(&path).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn modelos_de_gemini_cli() {
        let out = "Available Gemini Models:\n\nauto (Auto)\n  Description:   Let Gemini CLI decide\n  Context limit: 1,048,576 input tokens\n\ngemini-2.5-pro (gemini-2.5-pro)\n  Context limit: 1\n\ngemini-3.5-flash (gemini-3.5-flash)\n";
        assert_eq!(super::parse_gemini_models(out), ["auto", "gemini-2.5-pro", "gemini-3.5-flash"]);
    }
}
