//! Localizar e instalar las herramientas de Rust (cargo, rust-analyzer, clippy, rustfmt).

use serde::Serialize;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Command;

/// Carpeta de binarios de rustup (`~/.cargo/bin` o `$CARGO_HOME/bin`).
fn cargo_bin_dir() -> Option<PathBuf> {
    std::env::var_os("CARGO_HOME")
        .map(|h| PathBuf::from(h).join("bin"))
        .or_else(|| std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|h| PathBuf::from(h).join(".cargo").join("bin")))
        .filter(|d| d.is_dir())
}

/// PATH con `~/.cargo/bin` al principio. Una app abierta desde Finder/Explorer no
/// hereda el PATH de la terminal, y cargo necesita encontrar rustc, rustfmt, etc.
fn path_with_cargo() -> Option<std::ffi::OsString> {
    let bin = cargo_bin_dir()?;
    let current = std::env::var_os("PATH").unwrap_or_default();
    if std::env::split_paths(&current).any(|p| p == bin) {
        return None;
    }
    std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(&current))).ok()
}

/// Busca un programa en el PATH y en las carpetas habituales de Homebrew (que una app
/// abierta desde Finder no tiene en su PATH).
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file())
}

/// Crea un `Command` sin ventana de consola extra en Windows y con `~/.cargo/bin` en el PATH.
pub fn new_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    if let Some(path) = path_with_cargo() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Busca una herramienta instalada por rustup (cargo, rustup, rust-analyzer…).
/// Las apps abiertas desde Finder/Explorer no heredan el PATH de la terminal,
/// así que primero miramos `~/.cargo/bin`.
pub fn rustup_tool(name: &str) -> PathBuf {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("CARGO_HOME") {
        dirs.push(PathBuf::from(home).join("bin"));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        dirs.push(PathBuf::from(home).join(".cargo").join("bin"));
    }
    dirs.into_iter()
        .map(|d| d.join(&exe))
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(exe))
}

pub fn cargo_bin() -> PathBuf {
    rustup_tool("cargo")
}

fn runs_ok(program: PathBuf, args: &[&str]) -> bool {
    new_command(program)
        .args(args)
        .output()
        .is_ok_and(|o| o.status.success())
}

pub fn clippy_available() -> bool {
    runs_ok(cargo_bin(), &["clippy", "--version"])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainStatus {
    cargo: Option<String>,
    rust_analyzer: bool,
    clippy: bool,
    rustfmt: bool,
    rust_src: bool,
}

#[tauri::command]
pub async fn toolchain_status() -> Result<ToolchainStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let cargo = new_command(cargo_bin())
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        let rust_src = new_command(rustup_tool("rustc"))
            .args(["--print", "sysroot"])
            .output()
            .ok()
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
            .is_some_and(|root| root.join("lib/rustlib/src/rust/library").exists());
        ToolchainStatus {
            cargo,
            rust_analyzer: runs_ok(rustup_tool("rust-analyzer"), &["--version"]),
            clippy: clippy_available(),
            rustfmt: runs_ok(rustup_tool("rustfmt"), &["--version"]),
            rust_src,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Instala componentes con `rustup component add`.
#[tauri::command]
pub async fn install_components(components: Vec<String>) -> Result<String, String> {
    const ALLOWED: &[&str] = &["rust-analyzer", "clippy", "rustfmt", "rust-src"];
    if let Some(bad) = components.iter().find(|c| !ALLOWED.contains(&c.as_str())) {
        return Err(format!("Componente no permitido: {bad}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = new_command(rustup_tool("rustup"))
            .args(["component", "add"])
            .args(&components)
            .output()
            .map_err(|e| {
                format!("No se pudo ejecutar rustup: {e}. Instala Rust desde https://rustup.rs")
            })?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if out.status.success() {
            Ok(text)
        } else {
            Err(text)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
