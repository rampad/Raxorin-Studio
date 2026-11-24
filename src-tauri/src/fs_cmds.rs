//! Comandos de archivos y proyectos.

use crate::toolchain::{cargo_bin, new_command};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Carpetas/archivos que no se muestran en el explorador.
const HIDDEN: &[&str] = &[
    "target",
    ".git",
    "node_modules",
    ".DS_Store",
    ".idea",
    ".vscode",
];

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = std::fs::read_dir(&path)
        .map_err(|e| format!("No se pudo leer la carpeta {path}: {e}"))?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if HIDDEN.contains(&name.as_str()) {
                return None;
            }
            let is_dir = e.file_type().ok()?.is_dir();
            Some(Entry {
                name,
                path: e.path().to_string_lossy().into_owned(),
                is_dir,
            })
        })
        .collect();
    // Carpetas primero, luego orden alfabético.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("No se pudo abrir {path}: {e}"))
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("No se pudo guardar {path}: {e}"))
}

const CONSOLE_TEMPLATE: &str = r#"use std::io::{self, Write};

fn main() {
    println!("¡Hola desde Raxorin Studio!");

    print!("¿Cómo te llamas? ");
    io::stdout().flush().unwrap();

    let mut nombre = String::new();
    io::stdin().read_line(&mut nombre).unwrap();

    println!("¡Mucho gusto, {}!", nombre.trim());
}
"#;

// Plantilla "Aplicación de ventana" (Slint): la interfaz en ui/, el código en main.rs.
const SLINT_UI: &str = r##"import { Button, LineEdit } from "std-widgets.slint";

export component AppWindow inherits Window {
    title: "Mi aplicación";
    width: 400px;
    height: 220px;

    in-out property <string> saludo_text <=> saludo.text;
    in-out property <string> nombre_text <=> nombre.text;
    callback saludar_clicked();

    saludo := Text {
        x: 24px;
        y: 24px;
        width: 352px;
        height: 32px;
        text: "¿Cómo te llamas?";
        font-size: 18px;
    }

    nombre := LineEdit {
        x: 24px;
        y: 72px;
        width: 352px;
        height: 36px;
        placeholder-text: "Escribe tu nombre";
    }

    saludar := Button {
        x: 24px;
        y: 124px;
        width: 120px;
        height: 36px;
        text: "Saludar";
        clicked => {
            root.saludar_clicked();
        }
    }
}
"##;

const SLINT_MAIN: &str = r##"// Código de la ventana (como el "code-behind" de WPF).
// La interfaz está en ui/app-window.slint: ábrela para editarla con el diseñador.

// En Windows, la versión Release no abre una consola detrás de la ventana.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

fn main() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;

    ui.on_saludar_clicked({
        let ui_handle = ui.as_weak();
        move || {
            let ui = ui_handle.unwrap();
            let nombre = ui.get_nombre_text();
            ui.set_saludo_text(format!("¡Hola, {nombre}!").into());
        }
    });

    ui.run()
}
"##;

const SLINT_BUILD: &str = r##"fn main() {
    slint_build::compile("ui/app-window.slint").expect("No se pudo compilar la interfaz .slint");
}
"##;

const SLINT_VERSION: &str = "1.19";

/// Crea un proyecto nuevo con `cargo new`. `kind` es "bin" (consola), "lib" o "slint" (ventana).
#[tauri::command]
pub fn create_project(parent: String, name: String, kind: String) -> Result<String, String> {
    let valid = !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit() || c == '-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err(
            "Nombre inválido: usa letras, números, '_' o '-', sin empezar con número.".into(),
        );
    }
    let parent_path = Path::new(&parent);
    std::fs::create_dir_all(parent_path)
        .map_err(|e| format!("No se pudo crear la carpeta {parent}: {e}"))?;
    let target = parent_path.join(&name);
    if target.exists() {
        return Err(format!(
            "Ya existe una carpeta llamada '{name}' en esa ubicación."
        ));
    }

    let flag = if kind == "lib" { "--lib" } else { "--bin" };
    let out = new_command(cargo_bin())
        // Sin repositorio propio: Git se maneja desde el panel Git (y una solución usa uno solo).
        .args(["new", flag, "--vcs", "none", &name])
        .current_dir(parent_path)
        .output()
        .map_err(|e| format!("No se pudo ejecutar cargo: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }

    let write = |rel: &str, text: &str| -> Result<(), String> {
        let path = target.join(rel);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, text).map_err(|e| format!("No se pudo escribir {rel}: {e}"))
    };
    match kind.as_str() {
        "lib" => {}
        "slint" => {
            // Dependencias escritas directamente (funciona sin internet; cargo descarga al compilar).
            let manifest = target.join("Cargo.toml");
            let mut toml = std::fs::read_to_string(&manifest).map_err(|e| e.to_string())?;
            if !toml.contains("[dependencies]") {
                toml.push_str("\n[dependencies]\n");
            }
            toml = toml.replacen("[dependencies]\n", &format!("[dependencies]\nslint = \"{SLINT_VERSION}\"\n"), 1);
            toml.push_str(&format!("\n[build-dependencies]\nslint-build = \"{SLINT_VERSION}\"\n"));
            std::fs::write(&manifest, toml).map_err(|e| e.to_string())?;
            write("build.rs", SLINT_BUILD)?;
            write("ui/app-window.slint", SLINT_UI)?;
            write("src/main.rs", SLINT_MAIN)?;
        }
        _ => write("src/main.rs", CONSOLE_TEMPLATE)?,
    }
    Ok(target.to_string_lossy().into_owned())
}

// ---------- Operaciones del explorador ----------

fn check_name(path: &Path) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.is_empty() || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(format!("Nombre inválido: “{name}”"));
    }
    Ok(())
}

/// Escribe un archivo binario recibido en base64 (p. ej. imágenes importadas de Figma).
/// Crea las carpetas que falten.
#[tauri::command]
pub fn write_file_base64(path: String, base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("Datos de imagen inválidos: {e}"))?;
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear {}: {e}", parent.display()))?;
    }
    std::fs::write(p, bytes).map_err(|e| format!("No se pudo escribir {path}: {e}"))
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    check_name(p)?;
    if p.exists() {
        return Err(format!("Ya existe “{}”", p.display()));
    }
    std::fs::write(p, "").map_err(|e| format!("No se pudo crear el archivo: {e}"))
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    check_name(p)?;
    if p.exists() {
        return Err(format!("Ya existe “{}”", p.display()));
    }
    std::fs::create_dir_all(p).map_err(|e| format!("No se pudo crear la carpeta: {e}"))
}

/// Renombrar o mover un archivo/carpeta.
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    let (src, dst) = (Path::new(&from), Path::new(&to));
    check_name(dst)?;
    if src == dst {
        return Ok(());
    }
    if dst.starts_with(src) {
        return Err("No se puede mover una carpeta dentro de sí misma.".into());
    }
    // En macOS/Windows el sistema no distingue mayúsculas: permitir "a.rs" → "A.rs".
    let only_case = from.to_lowercase() == to.to_lowercase();
    if dst.exists() && !only_case {
        return Err(format!("Ya existe “{}”", dst.display()));
    }
    std::fs::rename(src, dst).map_err(|e| format!("No se pudo renombrar: {e}"))
}

/// Envía a la papelera (se puede recuperar).
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("No se pudo mover a la papelera: {e}"))
}

/// Mostrar en Finder / Explorador de Windows / gestor de archivos.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(p).spawn()
    } else if cfg!(windows) {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .spawn()
    } else {
        let dir = if p.is_dir() {
            p
        } else {
            p.parent().unwrap_or(p)
        };
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };
    result
        .map(|_| ())
        .map_err(|e| format!("No se pudo abrir el gestor de archivos: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escribe_base64() {
        let dir = std::env::temp_dir().join(format!("raxorin-b64-{}", std::process::id()));
        let file = dir.join("figma/logo.png");
        write_file_base64(file.to_string_lossy().into(), "iVBORw0KGgo=".into()).unwrap();
        assert_eq!(&std::fs::read(&file).unwrap()[..4], &[0x89, b'P', b'N', b'G']);
        assert!(write_file_base64(file.to_string_lossy().into(), "%%%".into()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn crea_proyecto_de_ventana() {
        let parent = std::env::temp_dir().join(format!("raxorin-tpl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        let path = create_project(parent.to_string_lossy().into(), "mi_ventana".into(), "slint".into()).unwrap();
        let p = Path::new(&path);
        let toml = std::fs::read_to_string(p.join("Cargo.toml")).unwrap();
        assert!(toml.contains("[dependencies]\nslint = \"1.19\""), "{toml}");
        assert!(toml.contains("[build-dependencies]\nslint-build = \"1.19\""), "{toml}");
        assert!(p.join("build.rs").is_file());
        assert!(std::fs::read_to_string(p.join("ui/app-window.slint")).unwrap().contains("export component AppWindow inherits Window"));
        assert!(std::fs::read_to_string(p.join("src/main.rs")).unwrap().contains("slint::include_modules!()"));
        println!("PROYECTO={path}");
    }
}
