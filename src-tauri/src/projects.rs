//! "Solución": una carpeta que puede contener varios proyectos de Rust
//! (independientes o miembros de un workspace de Cargo).

use crate::toolchain::{cargo_bin, new_command};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    name: String,
    /// Carpeta del proyecto (donde está su Cargo.toml).
    dir: String,
    manifest: String,
    /// "bin" si genera un ejecutable, "lib" si es solo biblioteca.
    kind: String,
    /// Cargo.toml raíz del workspace al que pertenece (o el propio).
    workspace_manifest: String,
}

const SKIP: &[&str] = &["target", "node_modules"];
const MAX_DEPTH: usize = 4;

fn find_manifests(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let manifest = dir.join("Cargo.toml");
    if manifest.is_file() {
        out.push(manifest);
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            !name.starts_with('.') && !SKIP.contains(&name.as_str())
        })
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for d in dirs {
        find_manifests(&d, depth + 1, out);
    }
}

/// Cargo devuelve rutas canónicas (p. ej. /private/tmp en vez de /tmp);
/// las traducimos a la forma en que el usuario abrió la carpeta.
fn display_path(p: &Path, root: &Path, canonical_root: &Path) -> String {
    match p.strip_prefix(canonical_root) {
        Ok(rel) if rel.as_os_str().is_empty() => root.to_string_lossy().into_owned(),
        Ok(rel) => root.join(rel).to_string_lossy().into_owned(),
        Err(_) => p.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub async fn find_projects(root: String) -> Result<Vec<ProjectInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(scan(Path::new(&root))))
        .await
        .map_err(|e| e.to_string())?
}

/// Busca todos los Cargo.toml bajo `root` y describe cada paquete.
fn scan(root: &Path) -> Vec<ProjectInfo> {
    let root = root.to_path_buf();
    let canonical_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let mut manifests = Vec::new();
    find_manifests(&root, 0, &mut manifests);

    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut projects = Vec::new();
    for manifest in manifests {
        let canonical = std::fs::canonicalize(&manifest).unwrap_or(manifest.clone());
        if seen.contains(&canonical) {
            continue; // ya lo listó el workspace que lo contiene
        }
        let out = new_command(cargo_bin())
            .args([
                "metadata",
                "--no-deps",
                "--format-version",
                "1",
                "--manifest-path",
            ])
            .arg(&manifest)
            .env("CARGO_TERM_COLOR", "never")
            .output();
        let Ok(out) = out else { continue };
        if !out.status.success() {
            eprintln!(
                "cargo metadata falló en {}: {}",
                manifest.display(),
                String::from_utf8_lossy(&out.stderr)
            );
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) else {
            continue;
        };
        let ws_root = PathBuf::from(v["workspace_root"].as_str().unwrap_or_default());
        let ws_manifest = display_path(&ws_root.join("Cargo.toml"), &root, &canonical_root);
        for pkg in v["packages"].as_array().into_iter().flatten() {
            let Some(m) = pkg["manifest_path"].as_str().map(PathBuf::from) else {
                continue;
            };
            if !seen.insert(m.clone()) {
                continue;
            }
            let is_bin = pkg["targets"].as_array().into_iter().flatten().any(|t| {
                t["kind"]
                    .as_array()
                    .is_some_and(|k| k.iter().any(|x| x.as_str() == Some("bin")))
            });
            let dir = m.parent().unwrap_or(&m).to_path_buf();
            projects.push(ProjectInfo {
                name: pkg["name"].as_str().unwrap_or("?").to_string(),
                dir: display_path(&dir, &root, &canonical_root),
                manifest: display_path(&m, &root, &canonical_root),
                kind: if is_bin { "bin" } else { "lib" }.to_string(),
                workspace_manifest: ws_manifest.clone(),
            });
        }
        seen.insert(canonical);
    }
    projects.sort_by(|a, b| a.dir.cmp(&b.dir));
    projects
}

/// Agrega una referencia a otro proyecto local: `cargo add --path <dep>`.
#[tauri::command]
pub async fn add_project_reference(project: String, dependency: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !Path::new(&dependency).join("Cargo.toml").is_file() {
            return Err(format!("{dependency} no es un proyecto de Rust"));
        }
        let out = new_command(cargo_bin())
            .args(["add", "--path"])
            .arg(&dependency)
            .current_dir(&project)
            .env("CARGO_TERM_COLOR", "never")
            .output()
            .map_err(|e| format!("No se pudo ejecutar cargo: {e}"))?;
        let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if out.status.success() {
            Ok(text)
        } else {
            Err(text)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn detecta_proyectos_y_workspaces() {
        let root = std::env::temp_dir().join(format!("rs-sol-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("ws")).unwrap();
        let new = |args: &[&str], dir: &Path| {
            assert!(Command::new(cargo_bin())
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap()
                .status
                .success());
        };
        new(&["new", "-q", "--vcs", "none", "app"], &root);
        new(
            &["new", "-q", "--vcs", "none", "--lib", "utilidades"],
            &root,
        );
        std::fs::write(
            root.join("ws/Cargo.toml"),
            "[workspace]\nmembers = [\"a\", \"b\"]\nresolver = \"2\"\n",
        )
        .unwrap();
        new(&["new", "-q", "--vcs", "none", "a"], &root.join("ws"));
        new(
            &["new", "-q", "--vcs", "none", "--lib", "b"],
            &root.join("ws"),
        );

        let found = scan(&root);
        let summary: Vec<(String, String)> = found
            .iter()
            .map(|p| (p.name.clone(), p.kind.clone()))
            .collect();
        assert_eq!(
            summary,
            [
                ("app", "bin"),
                ("utilidades", "lib"),
                ("a", "bin"),
                ("b", "lib")
            ]
            .map(|(a, b)| (a.to_string(), b.to_string()))
        );
        assert!(found
            .iter()
            .all(|p| p.dir.starts_with(root.to_str().unwrap())));
        let ws = root.join("ws/Cargo.toml").to_string_lossy().into_owned();
        assert_eq!(found[2].workspace_manifest, ws);
        assert_eq!(found[3].workspace_manifest, ws);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
