//! Comandos de archivos y proyectos.

use crate::runner::new_command;
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
const HIDDEN: &[&str] = &["target", ".git", "node_modules", ".DS_Store", ".idea", ".vscode"];

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
            Some(Entry { name, path: e.path().to_string_lossy().into_owned(), is_dir })
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
    println!("¡Hola desde Rust Studio!");

    print!("¿Cómo te llamas? ");
    io::stdout().flush().unwrap();

    let mut nombre = String::new();
    io::stdin().read_line(&mut nombre).unwrap();

    println!("¡Mucho gusto, {}!", nombre.trim());
}
"#;

/// Crea un proyecto nuevo con `cargo new`. `kind` es "bin" (consola) o "lib".
#[tauri::command]
pub fn create_project(parent: String, name: String, kind: String) -> Result<String, String> {
    let valid = !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit() || c == '-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err("Nombre inválido: usa letras, números, '_' o '-', sin empezar con número.".into());
    }
    let parent_path = Path::new(&parent);
    std::fs::create_dir_all(parent_path)
        .map_err(|e| format!("No se pudo crear la carpeta {parent}: {e}"))?;
    let target = parent_path.join(&name);
    if target.exists() {
        return Err(format!("Ya existe una carpeta llamada '{name}' en esa ubicación."));
    }

    let flag = if kind == "lib" { "--lib" } else { "--bin" };
    let out = new_command(crate::runner::cargo_bin())
        .args(["new", flag, &name])
        .current_dir(parent_path)
        .output()
        .map_err(|e| format!("No se pudo ejecutar cargo: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }

    if kind != "lib" {
        let _ = std::fs::write(target.join("src").join("main.rs"), CONSOLE_TEMPLATE);
    }
    Ok(target.to_string_lossy().into_owned())
}
