//! Servidor MCP (Model Context Protocol): Raxorin Studio expone sus herramientas para que Claude
//! Code, Claude Desktop u otras IA trabajen con proyectos de Rust: compilar con errores
//! estructurados, revisar con Clippy, probar, ejecutar, explicar errores, paquetes, plantillas,
//! ejemplos y el catálogo de controles del diseñador de Slint.
//!
//! Se inicia con `raxorin-studio --mcp [--root <carpeta>]…`, sin abrir la ventana, y habla
//! JSON-RPC 2.0 por la entrada y la salida estándar (un mensaje por línea), como pide MCP.
//!
//! Seguridad: las herramientas solo leen y escriben dentro de las carpetas autorizadas: las de
//! `--root` y las que comparte el cliente (`roots`). Si no hay ninguna, la carpeta del usuario.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::toolchain::{cargo_bin, new_command, rustup_tool};

/// Versiones del protocolo que entiende este servidor (la primera es la preferida).
const PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// Catálogo de controles del diseñador (lo genera scripts/mcp-catalogo.ts).
const CONTROLES: &str = include_str!("../mcp/controles.json");

const INSTRUCTIONS: &str = "Raxorin Studio is a Rust IDE. Use these tools to work with Rust projects: \
list_projects to find them, build/check/test/run to compile and run them (they return structured \
diagnostics with file, line and message), explain_error for rustc error codes, search_crates and \
add_dependency for packages, create_project or create_from_sample to start new ones. Window apps use \
Slint: call slint_controls before writing .slint files so they open in Raxorin Studio's visual \
designer (use its widget types, property names and events). Paths must be inside the allowed folders.";

struct Server {
    out: Mutex<std::io::Stdout>,
    /// Carpetas de --root (fijas) y las que comparte el cliente.
    cli_roots: Vec<PathBuf>,
    client_roots: Mutex<Vec<PathBuf>>,
    client_has_roots: Mutex<bool>,
}

impl Server {
    fn send(&self, msg: &Value) {
        let mut out = self.out.lock().unwrap();
        let _ = writeln!(out, "{msg}");
        let _ = out.flush();
    }

    fn reply(&self, id: &Value, result: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn reply_error(&self, id: &Value, code: i64, message: &str) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }));
    }

    fn progress(&self, token: &Option<Value>, progress: u64, message: &str) {
        if let Some(t) = token {
            self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/progress",
                "params": { "progressToken": t, "progress": progress, "message": message } }));
        }
    }

    fn roots(&self) -> Vec<PathBuf> {
        let mut r = self.cli_roots.clone();
        r.extend(self.client_roots.lock().unwrap().iter().cloned());
        if r.is_empty() {
            if let Some(home) = home_dir() {
                r.push(home);
            }
        }
        r
    }

    /// Ruta absoluta y dentro de una carpeta autorizada (o un error que lo explica).
    fn allowed(&self, raw: &str) -> Result<PathBuf, String> {
        let p = PathBuf::from(raw);
        if !p.is_absolute() {
            return Err(format!("Use an absolute path (got “{raw}”)."));
        }
        let normal = normalize(&p);
        let roots = self.roots();
        if roots.iter().any(|r| normal.starts_with(normalize(r))) {
            Ok(normal)
        } else {
            Err(format!(
                "“{}” is outside the allowed folders ({}). Add it with --root or share it as a root from the client.",
                normal.display(),
                roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join(", ")
            ))
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Quita `.` y `..` sin tocar el disco (y resuelve enlaces si la ruta existe).
fn normalize(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return plain(c);
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    // La parte que existe, canónica (p. ej. /tmp → /private/tmp en macOS).
    let mut existing = out.clone();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(|f| f.to_os_string()), existing.parent()) {
            (Some(f), Some(parent)) => {
                rest.push(f);
                existing = parent.to_path_buf();
            }
            _ => return out,
        }
    }
    let mut base = existing.canonicalize().map(plain).unwrap_or(existing);
    for f in rest.into_iter().rev() {
        base.push(f);
    }
    base
}

/// En Windows, `canonicalize` devuelve `\\?\C:\…`: se deja como `C:\…` (lo que entienden
/// cargo, los clientes y las personas). Las rutas de red (`\\?\UNC\…`) quedan como están.
fn plain(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC") {
                return PathBuf::from(rest.to_string());
            }
        }
    }
    p
}

fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let decoded = percent_decode(rest);
    // file:///C:/x → C:/x en Windows
    let s = if cfg!(windows) { decoded.trim_start_matches('/').to_string() } else { decoded };
    Some(PathBuf::from(s))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- Herramientas ----------

fn tools() -> Value {
    let s = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required });
    let project = json!({ "type": "string", "description": "Absolute path of the project folder (the one with Cargo.toml)." });
    let ro = json!({ "readOnlyHint": true, "openWorldHint": false });
    let runs = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false });
    json!([
        { "name": "ide_info", "title": "Raxorin Studio info",
          "description": "Raxorin Studio version, the allowed folders, and whether Rust, Cargo, Clippy, rustfmt and rust-analyzer are installed.",
          "inputSchema": s(json!({}), &[]), "annotations": ro },
        { "name": "list_projects", "title": "List Rust projects",
          "description": "Finds every Rust project (Cargo.toml) under a folder: name, folder, and whether it's an executable (bin) or a library (lib).",
          "inputSchema": s(json!({ "path": { "type": "string", "description": "Absolute folder to search." } }), &["path"]), "annotations": ro },
        { "name": "list_dir", "title": "List a folder",
          "description": "Lists the files and subfolders of a folder (skips target/ and .git).",
          "inputSchema": s(json!({ "path": { "type": "string" } }), &["path"]), "annotations": ro },
        { "name": "read_file", "title": "Read a file",
          "description": "Reads a text file (up to 1 MB).",
          "inputSchema": s(json!({ "path": { "type": "string" } }), &["path"]), "annotations": ro },
        { "name": "write_file", "title": "Write a file",
          "description": "Creates or overwrites a text file (creates missing folders). Raxorin Studio reloads it if it's open.",
          "inputSchema": s(json!({ "path": { "type": "string" }, "content": { "type": "string" } }), &["path", "content"]),
          "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false } },
        { "name": "build", "title": "Build (cargo build)",
          "description": "Builds the project and returns the errors and warnings with file, line, column, code and the full compiler message.",
          "inputSchema": s(json!({ "project": project, "release": { "type": "boolean", "description": "Optimized build (default false)." } }), &["project"]), "annotations": runs },
        { "name": "check", "title": "Check with Clippy",
          "description": "Runs Clippy (or cargo check if Clippy isn't installed): errors plus style and correctness suggestions, as structured diagnostics.",
          "inputSchema": s(json!({ "project": project }), &["project"]), "annotations": runs },
        { "name": "test", "title": "Run tests (cargo test)",
          "description": "Runs the project's tests and returns how many passed and failed, the names of the failing tests, and their output.",
          "inputSchema": s(json!({ "project": project, "filter": { "type": "string", "description": "Only tests whose name contains this." } }), &["project"]), "annotations": runs },
        { "name": "run", "title": "Run the program (cargo run)",
          "description": "Builds and runs the program, with optional arguments and standard input, and returns what it printed. Stopped after timeout_secs (default 30). Window (Slint) apps open a window until the timeout.",
          "inputSchema": s(json!({ "project": project,
              "args": { "type": "array", "items": { "type": "string" } },
              "stdin": { "type": "string", "description": "Text sent to the program's input (e.g. answers to prompts, one per line)." },
              "timeout_secs": { "type": "integer", "minimum": 1, "maximum": 600 } }), &["project"]), "annotations": runs },
        { "name": "format", "title": "Format (cargo fmt)",
          "description": "Formats the project's code with rustfmt.",
          "inputSchema": s(json!({ "project": project }), &["project"]),
          "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false } },
        { "name": "explain_error", "title": "Explain a Rust error",
          "description": "The official explanation of a rustc error code, with examples (like `rustc --explain E0382`).",
          "inputSchema": s(json!({ "code": { "type": "string", "description": "For example E0382." } }), &["code"]), "annotations": ro },
        { "name": "search_crates", "title": "Search crates.io",
          "description": "Searches crates.io: name, latest version, description and downloads.",
          "inputSchema": s(json!({ "query": { "type": "string" } }), &["query"]),
          "annotations": { "readOnlyHint": true, "openWorldHint": true } },
        { "name": "add_dependency", "title": "Add a dependency",
          "description": "Adds a crate to the project's Cargo.toml (cargo add), optionally with a version, features, or as a dev-dependency.",
          "inputSchema": s(json!({ "project": project, "name": { "type": "string" }, "version": { "type": "string" },
              "features": { "type": "array", "items": { "type": "string" } }, "dev": { "type": "boolean" } }), &["project", "name"]),
          "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true } },
        { "name": "create_project", "title": "Create a project",
          "description": "Creates a Rust project with Raxorin Studio's templates: console app (bin), library (lib), or window app with a Slint interface for the visual designer (slint).",
          "inputSchema": s(json!({ "parent": { "type": "string", "description": "Absolute folder where it's created." },
              "name": { "type": "string", "description": "Letters, numbers, _ or -, not starting with a number." },
              "kind": { "type": "string", "enum": ["bin", "lib", "slint"] },
              "language": { "type": "string", "enum": ["en", "es"], "description": "Language of the template's texts and comments (default en)." } }), &["parent", "name", "kind"]),
          "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false } },
        { "name": "list_samples", "title": "List sample apps",
          "description": "Raxorin Studio's sample apps (calculator, to-do list, games, a library, a solution…) with what each one teaches.",
          "inputSchema": s(json!({}), &[]), "annotations": ro },
        { "name": "create_from_sample", "title": "Create from a sample",
          "description": "Copies a sample app (see list_samples) into a new project folder.",
          "inputSchema": s(json!({ "id": { "type": "string" }, "parent": { "type": "string" }, "name": { "type": "string" } }), &["id", "parent", "name"]),
          "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true } },
        { "name": "slint_controls", "title": "Slint controls of the designer",
          "description": "The controls Raxorin Studio's visual designer understands: Slint types, properties (with kinds, options and defaults), events and what can be bound from Rust. Use it to write .slint files that open in the designer.",
          "inputSchema": s(json!({ "language": { "type": "string", "enum": ["en", "es"] }, "type": { "type": "string", "description": "Only this widget type (e.g. Button)." } }), &[]),
          "annotations": ro },
    ])
}

/// Resultado de una herramienta: texto para el modelo y datos estructurados.
fn result(text: String, structured: Option<Value>, is_error: bool) -> Value {
    let mut r = json!({ "content": [{ "type": "text", "text": text }], "isError": is_error });
    if let Some(s) = structured {
        r["structuredContent"] = s;
    }
    r
}

fn arg<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args.get(name).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| format!("Missing argument “{name}”."))
}

fn project_dir(server: &Server, args: &Value) -> Result<PathBuf, String> {
    let dir = server.allowed(arg(args, "project")?)?;
    if !dir.join("Cargo.toml").is_file() {
        return Err(format!("{} has no Cargo.toml: it isn't a Rust project.", dir.display()));
    }
    Ok(dir)
}

fn call_tool(server: &Server, name: &str, args: &Value, token: &Option<Value>) -> Result<Value, String> {
    match name {
        "ide_info" => {
            let status = tauri::async_runtime::block_on(crate::toolchain::toolchain_status()).ok();
            let info = json!({
                "version": env!("CARGO_PKG_VERSION"),
                "allowedFolders": server.roots().iter().map(|r| r.display().to_string()).collect::<Vec<_>>(),
                "toolchain": status,
                "docs": "https://raxorin.dev/en/",
            });
            Ok(result(serde_json::to_string_pretty(&info).unwrap(), Some(info), false))
        }
        "list_projects" => {
            let dir = server.allowed(arg(args, "path")?)?;
            let list = tauri::async_runtime::block_on(crate::projects::find_projects(dir.to_string_lossy().into_owned()))?;
            let v = serde_json::to_value(&list).unwrap();
            let text = if list.is_empty() { "No Rust projects found.".to_string() } else { serde_json::to_string_pretty(&v).unwrap() };
            Ok(result(text, Some(json!({ "projects": v })), false))
        }
        "list_dir" => {
            let dir = server.allowed(arg(args, "path")?)?;
            let mut entries: Vec<(bool, String)> = std::fs::read_dir(&dir)
                .map_err(|e| format!("Couldn't read {}: {e}", dir.display()))?
                .flatten()
                .map(|e| (e.path().is_dir(), e.file_name().to_string_lossy().into_owned()))
                .filter(|(_, n)| n != "target" && n != ".git" && n != ".DS_Store")
                .collect();
            entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
            let text = entries.iter().map(|(d, n)| if *d { format!("{n}/") } else { n.clone() }).collect::<Vec<_>>().join("\n");
            Ok(result(if text.is_empty() { "(empty)".into() } else { text }, None, false))
        }
        "read_file" => {
            let path = server.allowed(arg(args, "path")?)?;
            let meta = std::fs::metadata(&path).map_err(|_| format!("{} doesn't exist.", path.display()))?;
            if meta.len() > 1024 * 1024 {
                return Err(format!("{} is larger than 1 MB.", path.display()));
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let text = String::from_utf8(bytes).map_err(|_| format!("{} isn't a text file.", path.display()))?;
            Ok(result(text, None, false))
        }
        "write_file" => {
            let path = server.allowed(arg(args, "path")?)?;
            let content = args.get("content").and_then(Value::as_str).ok_or("Missing argument “content”.")?;
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
            }
            std::fs::write(&path, content).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
            Ok(result(format!("Wrote {} ({} bytes).", path.display(), content.len()), None, false))
        }
        "build" => {
            let dir = project_dir(server, args)?;
            let mut cargs = vec!["build", "--message-format=json-diagnostic-rendered-ansi"];
            if args.get("release").and_then(Value::as_bool) == Some(true) {
                cargs.push("--release");
            }
            Ok(cargo_diagnostics(server, &dir, &cargs, token, "Build"))
        }
        "check" => {
            let dir = project_dir(server, args)?;
            let clippy = crate::toolchain::clippy_available();
            let cargs: &[&str] = if clippy { &["clippy", "--all-targets", "--message-format=json-diagnostic-rendered-ansi"] } else { &["check", "--all-targets", "--message-format=json-diagnostic-rendered-ansi"] };
            Ok(cargo_diagnostics(server, &dir, cargs, token, if clippy { "Clippy" } else { "Check" }))
        }
        "test" => {
            let dir = project_dir(server, args)?;
            let mut cargs: Vec<String> = vec!["test".into(), "--message-format=json-diagnostic-rendered-ansi".into(), "--no-fail-fast".into()];
            if let Some(f) = args.get("filter").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                cargs.push(f.into());
            }
            cargs.extend(["--".into(), "--color".into(), "never".into()]);
            let refs: Vec<&str> = cargs.iter().map(String::as_str).collect();
            Ok(cargo_tests(server, &dir, &refs, token))
        }
        "run" => {
            let dir = project_dir(server, args)?;
            let timeout = args.get("timeout_secs").and_then(Value::as_u64).unwrap_or(30).clamp(1, 600);
            let extra: Vec<String> = args.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            let stdin = args.get("stdin").and_then(Value::as_str).unwrap_or("").to_string();
            Ok(cargo_run(server, &dir, &extra, &stdin, timeout, token))
        }
        "format" => {
            let dir = project_dir(server, args)?;
            let out = new_command(cargo_bin()).arg("fmt").current_dir(&dir).output().map_err(|e| format!("Couldn't run cargo fmt: {e}"))?;
            if out.status.success() {
                Ok(result("Formatted with rustfmt.".into(), None, false))
            } else {
                Ok(result(String::from_utf8_lossy(&out.stderr).into_owned(), None, true))
            }
        }
        "explain_error" => {
            let code = arg(args, "code")?.trim().to_uppercase();
            let code = if code.starts_with('E') { code } else { format!("E{code}") };
            if !code[1..].chars().all(|c| c.is_ascii_digit()) || code.len() != 5 {
                return Err(format!("“{code}” isn't an error code like E0382."));
            }
            let out = new_command(rustup_tool("rustc")).args(["--explain", &code]).output().map_err(|e| format!("Couldn't run rustc: {e}"))?;
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            if out.status.success() && !text.trim().is_empty() {
                Ok(result(text, None, false))
            } else {
                Ok(result(format!("{code} isn't a known error code."), None, true))
            }
        }
        "search_crates" => {
            let q = arg(args, "query")?.to_string();
            let found = tauri::async_runtime::block_on(crate::crates::crate_search(q, None))?;
            let v = serde_json::to_value(&found).unwrap();
            Ok(result(serde_json::to_string_pretty(&v).unwrap(), Some(json!({ "crates": v })), false))
        }
        "add_dependency" => {
            let dir = project_dir(server, args)?;
            let name = arg(args, "name")?.to_string();
            let version = args.get("version").and_then(Value::as_str).map(String::from);
            let features = args.get("features").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect());
            let kind = if args.get("dev").and_then(Value::as_bool) == Some(true) { Some("dev".to_string()) } else { None };
            let msg = tauri::async_runtime::block_on(crate::crates::crate_add(dir.to_string_lossy().into_owned(), name, version, features, kind, None))?;
            Ok(result(if msg.trim().is_empty() { "Dependency added to Cargo.toml.".into() } else { msg }, None, false))
        }
        "create_project" => {
            let parent = server.allowed(arg(args, "parent")?)?;
            let kind = arg(args, "kind")?;
            if !["bin", "lib", "slint"].contains(&kind) {
                return Err("“kind” must be bin, lib or slint.".into());
            }
            let lang = args.get("language").and_then(Value::as_str).unwrap_or("en").to_string();
            let path = crate::fs_cmds::create_project(parent.to_string_lossy().into_owned(), arg(args, "name")?.to_string(), kind.to_string(), Some(lang))?;
            let main = if kind == "slint" { "ui/app-window.slint and src/main.rs" } else if kind == "lib" { "src/lib.rs" } else { "src/main.rs" };
            Ok(result(format!("Created {path} ({main}). Open it in Raxorin Studio with File → Open folder…"), Some(json!({ "path": path })), false))
        }
        "list_samples" => {
            let catalog = tauri::async_runtime::block_on(crate::samples::samples_list())?;
            let list: Vec<Value> = catalog.samples.iter().map(|s| {
                let en = s.en.clone().unwrap_or(Value::Null);
                json!({ "id": s.id, "name": en.get("nombre").cloned().unwrap_or(json!(s.nombre)),
                    "description": en.get("descripcion").cloned().unwrap_or(json!(s.descripcion)),
                    "kind": s.tipo, "level": en.get("nivel").cloned().unwrap_or(json!(s.nivel)),
                    "teaches": en.get("aprenderas").cloned().unwrap_or(json!(s.aprenderas)) })
            }).collect();
            let v = json!(list);
            Ok(result(serde_json::to_string_pretty(&v).unwrap(), Some(json!({ "samples": v })), false))
        }
        "create_from_sample" => {
            let parent = server.allowed(arg(args, "parent")?)?;
            let id = arg(args, "id")?;
            let catalog = tauri::async_runtime::block_on(crate::samples::samples_list())?;
            let sample = catalog.samples.iter().find(|s| s.id == id).ok_or_else(|| format!("There's no sample “{id}” (see list_samples)."))?;
            let created = crate::samples::create(sample, &parent, arg(args, "name")?, catalog.online)?;
            let v = serde_json::to_value(&created).unwrap();
            Ok(result(format!("Created {} (main file: {}).", created.open, created.file), Some(v), false))
        }
        "slint_controls" => {
            let all: Value = serde_json::from_str(CONTROLES).map_err(|e| e.to_string())?;
            let lang = if args.get("language").and_then(Value::as_str) == Some("es") { "es" } else { "en" };
            let mut cat = all[lang].clone();
            if let Some(t) = args.get("type").and_then(Value::as_str) {
                let w = cat["widgets"].as_array().and_then(|ws| ws.iter().find(|w| w["type"] == t).cloned())
                    .ok_or_else(|| format!("The designer has no “{t}” control."))?;
                cat = w;
            }
            cat["slintVersion"] = all["slint"].clone();
            Ok(result(serde_json::to_string(&cat).unwrap(), Some(cat), false))
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}

// ---------- Cargo ----------

/// Un diagnóstico del compilador, como lo entrega cargo --message-format=json.
fn diagnostic(msg: &Value) -> Option<Value> {
    let m = &msg["message"];
    let level = m["level"].as_str()?;
    if level == "failure-note" || m["message"].as_str().is_some_and(|t| t.starts_with("aborting due to")) {
        return None;
    }
    let span = m["spans"].as_array().and_then(|s| s.iter().find(|sp| sp["is_primary"].as_bool() == Some(true)));
    let rendered = m["rendered"].as_str().map(strip_ansi);
    Some(json!({
        "level": level,
        "message": m["message"],
        "code": m["code"]["code"],
        "file": span.map(|s| s["file_name"].clone()),
        "line": span.map(|s| s["line_start"].clone()),
        "column": span.map(|s| s["column_start"].clone()),
        "rendered": rendered,
    }))
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Ejecuta cargo leyendo sus mensajes JSON línea a línea (para el progreso).
fn cargo_lines(server: &Server, dir: &Path, args: &[&str], token: &Option<Value>, mut on_text: impl FnMut(&str)) -> Result<(bool, Vec<Value>, String), String> {
    let mut cmd = new_command(cargo_bin());
    cmd.args(args).current_dir(dir).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't run cargo: {e}"))?;
    let stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s);
        s
    });
    let mut diags = Vec::new();
    let mut step = 0;
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        if !line.starts_with('{') {
            on_text(&line);
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        match msg["reason"].as_str() {
            Some("compiler-message") => {
                if let Some(d) = diagnostic(&msg) {
                    diags.push(d);
                }
            }
            Some("compiler-artifact") => {
                step += 1;
                server.progress(token, step, &format!("Compiled {}", msg["target"]["name"].as_str().unwrap_or("?")));
            }
            _ => {}
        }
    }
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    Ok((ok, diags, err_thread.join().unwrap_or_default()))
}

fn cargo_diagnostics(server: &Server, dir: &Path, args: &[&str], token: &Option<Value>, what: &str) -> Value {
    match cargo_lines(server, dir, args, token, |_| {}) {
        Err(e) => result(e, None, true),
        Ok((ok, diags, stderr)) => {
            let errors = diags.iter().filter(|d| d["level"].as_str().is_some_and(|l| l.starts_with("error"))).count();
            let warnings = diags.iter().filter(|d| d["level"] == "warning").count();
            let mut text = format!("{what} {}: {errors} error(s), {warnings} warning(s).", if ok { "succeeded" } else { "failed" });
            for d in &diags {
                text.push_str("\n\n");
                text.push_str(d["rendered"].as_str().unwrap_or(""));
            }
            // Fallos que no son del compilador (Cargo.toml inválido, sin red…): el stderr de cargo.
            if !ok && errors == 0 {
                text.push_str("\n\n");
                text.push_str(&strip_ansi(stderr.trim()));
            }
            result(text, Some(json!({ "success": ok, "errors": errors, "warnings": warnings, "diagnostics": diags })), !ok)
        }
    }
}

fn cargo_tests(server: &Server, dir: &Path, args: &[&str], token: &Option<Value>) -> Value {
    let mut output = String::new();
    let (mut passed, mut failed, mut ignored) = (0u64, 0u64, 0u64);
    let mut failing = Vec::new();
    let r = cargo_lines(server, dir, args, token, |line| {
        output.push_str(line);
        output.push('\n');
        if let Some(rest) = line.strip_prefix("test result: ") {
            let num = |key: &str| rest.split(';').find_map(|p| p.trim().strip_suffix(key).and_then(|n| n.split_whitespace().last()?.parse::<u64>().ok())).unwrap_or(0);
            passed += num(" passed");
            failed += num(" failed");
            ignored += num(" ignored");
        }
        if let Some(name) = line.strip_prefix("test ").and_then(|l| l.strip_suffix(" ... FAILED")) {
            failing.push(name.to_string());
        }
    });
    match r {
        Err(e) => result(e, None, true),
        Ok((ok, diags, stderr)) => {
            let errors = diags.iter().filter(|d| d["level"].as_str().is_some_and(|l| l.starts_with("error"))).count();
            let mut text = if errors > 0 {
                format!("The tests didn't compile: {errors} error(s).")
            } else {
                format!("{passed} passed, {failed} failed, {ignored} ignored.")
            };
            if !failing.is_empty() {
                text.push_str(&format!("\nFailing: {}", failing.join(", ")));
            }
            for d in diags.iter().filter(|d| d["level"].as_str().is_some_and(|l| l.starts_with("error"))) {
                text.push_str("\n\n");
                text.push_str(d["rendered"].as_str().unwrap_or(""));
            }
            if !ok {
                text.push_str("\n\n--- output ---\n");
                text.push_str(&tail(&output, 12_000));
                if errors == 0 && failed == 0 {
                    text.push_str(&strip_ansi(stderr.trim()));
                }
            }
            result(text, Some(json!({ "success": ok, "passed": passed, "failed": failed, "ignored": ignored, "failing": failing, "diagnostics": diags })), !ok)
        }
    }
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

fn cargo_run(server: &Server, dir: &Path, extra: &[String], stdin: &str, timeout: u64, token: &Option<Value>) -> Value {
    // Primero compilar (con errores estructurados); después ejecutar el binario con el tiempo límite.
    let build = cargo_diagnostics(server, dir, &["build", "--message-format=json-diagnostic-rendered-ansi"], token, "Build");
    if build["isError"] == true {
        return build;
    }
    let mut cmd = new_command(cargo_bin());
    cmd.args(["run", "-q", "--"]).args(extra).current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return result(format!("Couldn't run the program: {e}"), None, true),
    };
    if let Some(mut input) = child.stdin.take() {
        let text = stdin.to_string();
        std::thread::spawn(move || {
            let _ = input.write_all(text.as_bytes());
        });
    }
    let read = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = Vec::new();
            if let Some(r) = r {
                let _ = r.take(2 * 1024 * 1024).read_to_end(&mut s);
            }
            String::from_utf8_lossy(&s).into_owned()
        })
    };
    let out_t = read(child.stdout.take().map(|o| Box::new(o) as Box<dyn Read + Send>));
    let err_t = read(child.stderr.take().map(|o| Box::new(o) as Box<dyn Read + Send>));
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if start.elapsed() > Duration::from_secs(timeout) => {
                let _ = child.kill();
                timed_out = true;
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break None,
        }
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    let code = status.and_then(|s| s.code());
    let mut text = String::new();
    text.push_str(&tail(&stdout, 20_000));
    if !stderr.trim().is_empty() {
        text.push_str("\n--- stderr ---\n");
        text.push_str(&tail(&stderr, 8_000));
    }
    text.push_str(&if timed_out {
        format!("\n--- stopped after {timeout} s (timeout) ---")
    } else {
        format!("\n--- exit code {} ---", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
    });
    let failed = !timed_out && code != Some(0);
    result(text, Some(json!({ "exitCode": code, "timedOut": timed_out, "stdout": stdout, "stderr": stderr })), failed)
}

// ---------- Protocolo ----------

fn handle(server: &Arc<Server>, msg: Value) {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).map(String::from);
    let params = msg.get("params").cloned().unwrap_or(json!({}));

    // Respuesta a una petición nuestra (roots/list).
    if method.is_none() {
        if id == Some(json!("raxorin-roots")) {
            if let Some(roots) = msg.pointer("/result/roots").and_then(Value::as_array) {
                let paths: Vec<PathBuf> = roots.iter().filter_map(|r| r["uri"].as_str().and_then(uri_to_path)).collect();
                *server.client_roots.lock().unwrap() = paths;
            }
        }
        return;
    }
    let method = method.unwrap();
    match (method.as_str(), id) {
        ("initialize", Some(id)) => {
            let asked = params["protocolVersion"].as_str().unwrap_or(PROTOCOLS[0]);
            let version = if PROTOCOLS.contains(&asked) { asked } else { PROTOCOLS[0] };
            *server.client_has_roots.lock().unwrap() = params.pointer("/capabilities/roots").is_some();
            server.reply(&id, json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "raxorin-studio", "title": "Raxorin Studio", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }));
        }
        ("notifications/initialized" | "notifications/roots/list_changed", None) => {
            if *server.client_has_roots.lock().unwrap() {
                server.send(&json!({ "jsonrpc": "2.0", "id": "raxorin-roots", "method": "roots/list" }));
            }
        }
        ("ping", Some(id)) => server.reply(&id, json!({})),
        ("tools/list", Some(id)) => server.reply(&id, json!({ "tools": tools() })),
        ("tools/call", Some(id)) => {
            let server = server.clone();
            // En un hilo propio: una compilación larga no bloquea los demás mensajes.
            std::thread::spawn(move || {
                let name = params["name"].as_str().unwrap_or("").to_string();
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let token = params.pointer("/_meta/progressToken").cloned();
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call_tool(&server, &name, &args, &token)));
                match res {
                    Ok(Ok(v)) => server.reply(&id, v),
                    // Errores de la herramienta: como resultado con isError (el modelo los ve y corrige).
                    Ok(Err(e)) => server.reply(&id, result(e, None, true)),
                    Err(_) => server.reply_error(&id, -32603, "Internal error in the tool."),
                }
            });
        }
        (_, Some(id)) => server.reply_error(&id, -32601, &format!("Method not found: {method}")),
        (_, None) => {} // otras notificaciones: se ignoran
    }
}

/// `raxorin-studio --mcp [--root <carpeta>]…`: atiende MCP por stdio hasta que se cierra la entrada.
pub fn run_stdio(args: &[String]) -> i32 {
    let mut cli_roots = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--root" {
            if let Some(r) = it.next() {
                cli_roots.push(normalize(Path::new(r)));
            }
        } else if let Some(r) = a.strip_prefix("--root=") {
            cli_roots.push(normalize(Path::new(r)));
        }
    }
    let server = Arc::new(Server {
        out: Mutex::new(std::io::stdout()),
        cli_roots,
        client_roots: Mutex::new(Vec::new()),
        client_has_roots: Mutex::new(false),
    });
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => batch.into_iter().for_each(|m| handle(&server, m)),
            Ok(msg) => handle(&server, msg),
            Err(_) => server.send(&json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })),
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(roots: &[&str]) -> Server {
        Server {
            out: Mutex::new(std::io::stdout()),
            cli_roots: roots.iter().map(|r| normalize(Path::new(r))).collect(),
            client_roots: Mutex::new(Vec::new()),
            client_has_roots: Mutex::new(false),
        }
    }

    #[test]
    fn solo_carpetas_autorizadas() {
        let base = std::env::temp_dir().join(format!("raxorin-mcp-{}", std::process::id()));
        std::fs::create_dir_all(base.join("proyecto")).unwrap();
        let s = server(&[base.join("proyecto").to_str().unwrap()]);
        assert!(s.allowed(base.join("proyecto/src/main.rs").to_str().unwrap()).is_ok());
        assert!(s.allowed(base.join("proyecto/../otro/x.rs").to_str().unwrap()).is_err(), "no se sale con ..");
        assert!(s.allowed("/etc/passwd").is_err());
        assert!(s.allowed("relativo.rs").is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn uris_de_carpetas() {
        assert_eq!(percent_decode("Mis%20proyectos"), "Mis proyectos");
        if !cfg!(windows) {
            assert_eq!(uri_to_path("file:///Users/ana/Mis%20proyectos"), Some(PathBuf::from("/Users/ana/Mis proyectos")));
        }
        assert_eq!(uri_to_path("https://x"), None);
    }

    #[test]
    fn catalogo_y_herramientas_validos() {
        let all: Value = serde_json::from_str(CONTROLES).unwrap();
        assert!(all["en"]["widgets"].as_array().unwrap().len() >= 20);
        let tools = tools();
        let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        for n in ["build", "check", "test", "run", "explain_error", "slint_controls", "create_project"] {
            assert!(names.contains(&n), "falta {n}");
        }
        for t in tools.as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
        }
    }
}

// ---------- Configurar clientes (ventana "Conectar con IA" del IDE) ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetup {
    /// Ejecutable de Raxorin Studio que lanzan los clientes.
    pub exe: String,
    /// La app corre desde un lugar temporal (el .dmg, una copia translocada): la ruta no durará.
    pub temporary_location: bool,
    /// Configuración de Claude Desktop (exista o no).
    pub claude_desktop_config: Option<String>,
    /// Raxorin Studio ya está en esa configuración.
    pub in_claude_desktop: bool,
}

fn claude_desktop_config_path() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        home_dir().map(|h| h.join("Library/Application Support/Claude/claude_desktop_config.json"))
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Claude").join("claude_desktop_config.json"))
    } else {
        home_dir().map(|h| h.join(".config/Claude/claude_desktop_config.json"))
    }
}

#[tauri::command]
pub fn mcp_setup() -> Result<McpSetup, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let s = exe.to_string_lossy().into_owned();
    let cfg = claude_desktop_config_path();
    let in_desktop = cfg
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .is_some_and(|v| v.pointer("/mcpServers/raxorin-studio").is_some());
    Ok(McpSetup {
        temporary_location: s.starts_with("/Volumes/") || s.contains("/AppTranslocation/"),
        exe: s,
        claude_desktop_config: cfg.map(|p| p.to_string_lossy().into_owned()),
        in_claude_desktop: in_desktop,
    })
}

/// Agrega (o actualiza) Raxorin Studio en la configuración de Claude Desktop, guardando antes una
/// copia de la anterior (claude_desktop_config.json.bak). Devuelve la ruta del archivo.
#[tauri::command]
pub fn mcp_add_to_claude_desktop(roots: Vec<String>) -> Result<String, String> {
    let path = claude_desktop_config_path().ok_or("No se encontró la carpeta de configuración de Claude Desktop.")?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    add_server_to_config(&path, &exe.to_string_lossy(), &roots)?;
    Ok(path.to_string_lossy().into_owned())
}

fn add_server_to_config(path: &Path, exe: &str, roots: &[String]) -> Result<(), String> {
    let mut config: Value = match std::fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).map_err(|e| format!("La configuración de Claude Desktop no es un JSON válido ({e}); no se cambió."))?
        }
        _ => json!({}),
    };
    if !config.is_object() {
        return Err("La configuración de Claude Desktop no tiene el formato esperado; no se cambió.".into());
    }
    if path.exists() {
        std::fs::copy(path, path.with_extension("json.bak")).map_err(|e| format!("No se pudo guardar la copia de respaldo: {e}"))?;
    }
    let mut args = vec![json!("--mcp")];
    for r in roots {
        args.push(json!("--root"));
        args.push(json!(r));
    }
    if !config["mcpServers"].is_object() {
        config["mcpServers"] = json!({});
    }
    config["mcpServers"]["raxorin-studio"] = json!({ "command": exe, "args": args });
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&config).unwrap() + "\n").map_err(|e| format!("No se pudo guardar {}: {e}", path.display()))
}

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn agrega_sin_tocar_lo_demas_y_con_respaldo() {
        let dir = std::env::temp_dir().join(format!("raxorin-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("claude_desktop_config.json");
        std::fs::write(&p, r#"{ "mcpServers": { "otro": { "command": "x" } }, "theme": "dark" }"#).unwrap();
        add_server_to_config(&p, "/Apps/raxorin-studio", &["/Users/ana/proyecto".into()]).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["otro"]["command"], "x");
        assert_eq!(v["mcpServers"]["raxorin-studio"]["args"], json!(["--mcp", "--root", "/Users/ana/proyecto"]));
        assert!(dir.join("claude_desktop_config.json.bak").exists());
        // Un archivo dañado no se pisa.
        std::fs::write(&p, "{ roto").unwrap();
        assert!(add_server_to_config(&p, "/x", &[]).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{ roto");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
