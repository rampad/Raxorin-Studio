//! Soluciones de Raxorin Studio (`.rxsln`), como el `.sln` de Visual Studio:
//! un archivo TOML que agrupa proyectos ubicados en cualquier carpeta.
//!
//! ```toml
//! [solucion]
//! nombre = "MiSolucion"
//! inicio = "mi_app"          # carpeta del proyecto de inicio (relativa)
//!
//! [[proyecto]]
//! ruta = "mi_app"            # relativa a la solución…
//!
//! [[proyecto]]
//! ruta = "../Bibliotecas/utilidades"   # …o en cualquier otro lugar
//! ```

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const EXTENSION: &str = "rxsln";

#[derive(Serialize, Deserialize, Default)]
struct SolutionFile {
    solucion: Info,
    #[serde(default, rename = "proyecto")]
    proyectos: Vec<Entry>,
}

#[derive(Serialize, Deserialize, Default)]
struct Info {
    nombre: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inicio: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    ruta: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolutionProject {
    /// Tal como está escrita en el archivo.
    ruta: String,
    /// Ruta absoluta.
    path: String,
    exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolutionInfo {
    file: String,
    dir: String,
    name: String,
    /// Carpeta absoluta del proyecto de inicio, si hay.
    startup: Option<String>,
    projects: Vec<SolutionProject>,
}

/// Quita `.` y resuelve `..` sin tocar el disco.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn resolve(dir: &Path, ruta: &str) -> PathBuf {
    normalize(&dir.join(ruta))
}

/// Ruta de `target` relativa a `base` (con `/`), o absoluta si no comparten raíz.
fn relative_to(base: &Path, target: &Path) -> String {
    let (b, t) = (normalize(base), normalize(target));
    let bc: Vec<_> = b.components().collect();
    let tc: Vec<_> = t.components().collect();
    let common = bc.iter().zip(&tc).take_while(|(a, b)| a == b).count();
    if common == 0 {
        return t.to_string_lossy().replace('\\', "/");
    }
    let mut parts: Vec<String> = vec!["..".into(); bc.len() - common];
    parts.extend(tc[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    if parts.is_empty() { ".".into() } else { parts.join("/") }
}

fn read(file: &Path) -> Result<SolutionFile, String> {
    let text = std::fs::read_to_string(file).map_err(|e| format!("No se pudo leer {}: {e}", file.display()))?;
    toml::from_str(&text).map_err(|e| format!("El archivo de solución tiene un error: {}", e.message()))
}

fn write(file: &Path, sol: &SolutionFile) -> Result<(), String> {
    let body = toml::to_string_pretty(sol).map_err(|e| e.to_string())?;
    let text = format!("# Solución de Raxorin Studio. Ábrela con Raxorin Studio o edítala a mano.\n\n{body}");
    std::fs::write(file, text).map_err(|e| format!("No se pudo guardar {}: {e}", file.display()))
}

fn info(file: &Path) -> Result<SolutionInfo, String> {
    let sol = read(file)?;
    let dir = file.parent().unwrap_or(Path::new(".")).to_path_buf();
    let projects = sol
        .proyectos
        .iter()
        .map(|e| {
            let path = resolve(&dir, &e.ruta);
            SolutionProject { ruta: e.ruta.clone(), exists: path.join("Cargo.toml").is_file(), path: path.to_string_lossy().into_owned() }
        })
        .collect();
    Ok(SolutionInfo {
        file: file.to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
        name: sol.solucion.nombre.clone(),
        startup: sol.solucion.inicio.as_deref().map(|r| resolve(&dir, r).to_string_lossy().into_owned()),
        projects,
    })
}

fn same(a: &Path, b: &Path) -> bool {
    std::fs::canonicalize(a).unwrap_or(normalize(a)) == std::fs::canonicalize(b).unwrap_or(normalize(b))
}

#[tauri::command]
pub fn solution_read(file: String) -> Result<SolutionInfo, String> {
    info(Path::new(&file))
}

/// Crea `<dir>/<name>.rxsln` con los proyectos indicados (rutas absolutas).
#[tauri::command]
pub fn solution_create(dir: String, name: String, projects: Vec<String>) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("Nombre de solución inválido.".into());
    }
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta: {e}"))?;
    let file = dir.join(format!("{name}.{EXTENSION}"));
    if file.exists() {
        return Err(format!("Ya existe {}", file.display()));
    }
    let sol = SolutionFile {
        solucion: Info { nombre: name.to_string(), inicio: None },
        proyectos: projects.iter().map(|p| Entry { ruta: relative_to(&dir, Path::new(p)) }).collect(),
    };
    write(&file, &sol)?;
    Ok(file.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn solution_add_project(file: String, path: String) -> Result<SolutionInfo, String> {
    let (file, path) = (PathBuf::from(file), PathBuf::from(path));
    if !path.join("Cargo.toml").is_file() {
        return Err(format!("{} no tiene Cargo.toml: no es un proyecto de Rust.", path.display()));
    }
    let mut sol = read(&file)?;
    let dir = file.parent().unwrap_or(Path::new(".")).to_path_buf();
    if sol.proyectos.iter().any(|e| same(&resolve(&dir, &e.ruta), &path)) {
        return Err("Ese proyecto ya está en la solución.".into());
    }
    sol.proyectos.push(Entry { ruta: relative_to(&dir, &path) });
    write(&file, &sol)?;
    info(&file)
}

/// Quita un proyecto de la lista (no borra sus archivos).
#[tauri::command]
pub fn solution_remove_project(file: String, path: String) -> Result<SolutionInfo, String> {
    let (file, path) = (PathBuf::from(file), PathBuf::from(path));
    let mut sol = read(&file)?;
    let dir = file.parent().unwrap_or(Path::new(".")).to_path_buf();
    let before = sol.proyectos.len();
    sol.proyectos.retain(|e| !same(&resolve(&dir, &e.ruta), &path));
    if sol.proyectos.len() == before {
        return Err("Ese proyecto no está en la solución.".into());
    }
    if let Some(start) = &sol.solucion.inicio {
        if same(&resolve(&dir, start), &path) {
            sol.solucion.inicio = None;
        }
    }
    write(&file, &sol)?;
    info(&file)
}

/// Guarda el proyecto de inicio (carpeta absoluta) en la solución.
#[tauri::command]
pub fn solution_set_startup(file: String, dir: Option<String>) -> Result<(), String> {
    let file = PathBuf::from(file);
    let mut sol = read(&file)?;
    let base = file.parent().unwrap_or(Path::new(".")).to_path_buf();
    sol.solucion.inicio = dir.map(|d| relative_to(&base, Path::new(&d)));
    write(&file, &sol)
}

/// Archivo .rxsln (o carpeta) con el que se abrió la app: doble clic en Finder /
/// Explorador, o argumento de línea de comandos. La interfaz lo recoge al iniciar.
#[derive(Default)]
pub struct PendingOpen(pub std::sync::Mutex<Option<String>>);

#[tauri::command]
pub fn take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Primer argumento que sea un .rxsln o una carpeta existente (Windows/Linux).
pub fn path_from_args() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        let p = Path::new(a);
        (p.extension().is_some_and(|x| x == EXTENSION) && p.is_file()) || p.is_dir()
    })
}

/// Busca un `.rxsln` en la carpeta (no en subcarpetas).
#[tauri::command]
pub fn solution_find(dir: String) -> Option<String> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == EXTENSION))
        .collect();
    found.sort();
    found.first().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rutas_relativas() {
        assert_eq!(relative_to(Path::new("/a/b"), Path::new("/a/b/c")), "c");
        assert_eq!(relative_to(Path::new("/a/b"), Path::new("/a/x/y")), "../x/y");
        assert_eq!(relative_to(Path::new("/a/b"), Path::new("/a/b")), ".");
        assert_eq!(resolve(Path::new("/a/b"), "../x/./y"), PathBuf::from("/a/x/y"));
    }

    #[test]
    fn crear_agregar_quitar() {
        let root = std::env::temp_dir().join(format!("raxorin-sol-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for p in ["sol", "app", "libs/util"] {
            std::fs::create_dir_all(root.join(p)).unwrap();
        }
        std::fs::write(root.join("app/Cargo.toml"), "[package]\nname=\"app\"\n").unwrap();
        std::fs::write(root.join("libs/util/Cargo.toml"), "[package]\nname=\"util\"\n").unwrap();
        let app = root.join("app").to_string_lossy().into_owned();
        let util = root.join("libs/util").to_string_lossy().into_owned();

        let file = solution_create(root.join("sol").to_string_lossy().into(), "Mi Solucion".into(), vec![app.clone()]).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("nombre = \"Mi Solucion\"") && text.contains("ruta = \"../app\""), "{text}");

        let i = solution_add_project(file.clone(), util.clone()).unwrap();
        assert_eq!(i.projects.len(), 2);
        assert!(i.projects.iter().all(|p| p.exists));
        assert!(std::fs::read_to_string(&file).unwrap().contains("ruta = \"../libs/util\""));
        assert!(solution_add_project(file.clone(), util.clone()).is_err(), "duplicado");

        solution_set_startup(file.clone(), Some(app.clone())).unwrap();
        assert_eq!(solution_read(file.clone()).unwrap().startup.as_deref(), Some(app.as_str()));

        let i = solution_remove_project(file.clone(), app.clone()).unwrap();
        assert_eq!(i.projects.len(), 1);
        assert_eq!(i.startup, None, "quitar el proyecto de inicio lo limpia");
        assert_eq!(solution_find(root.join("sol").to_string_lossy().into()), Some(file));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
