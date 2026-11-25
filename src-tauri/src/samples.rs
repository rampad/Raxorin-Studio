//! Hub de ejemplos: aplicaciones de muestra listas para abrir, compilar y estudiar.
//!
//! Los ejemplos están en la carpeta `ejemplos/` del repositorio. Van incluidos en la app (funcionan
//! sin internet) y además se consulta el catálogo de GitHub, para que los ejemplos nuevos aparezcan
//! sin esperar a una versión nueva de Raxorin Studio.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

// EJEMPLOS: los archivos de ejemplos/ (los genera build.rs a partir de ejemplos/index.json).
include!(concat!(env!("OUT_DIR"), "/ejemplos.rs"));

fn embedded(path: &str) -> Option<&'static [u8]> {
    EJEMPLOS.iter().find(|(p, _)| *p == path).map(|(_, b)| *b)
}

/// Donde están los ejemplos en GitHub (rama principal).
const EN_LINEA: &str = "https://raw.githubusercontent.com/rampad/Raxorin-Studio/main/ejemplos";
/// Formato del índice que entiende esta versión.
const FORMATO: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Sample {
    pub id: String,
    pub nombre: String,
    pub descripcion: String,
    pub categoria: String,
    pub nivel: String,
    pub icono: String,
    /// "ventana", "consola", "biblioteca" o "solucion".
    pub tipo: String,
    /// Archivo que se abre al crear el ejemplo (relativo a su carpeta).
    pub abrir: String,
    /// Para las soluciones: el archivo .rxsln.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solucion: Option<String>,
    #[serde(default)]
    pub aprenderas: Vec<String>,
    pub archivos: Vec<String>,
    /// Textos de la ficha en inglés (nombre, descripcion, categoria, nivel, aprenderas).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub en: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct Index {
    formato: u32,
    ejemplos: Vec<Sample>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub samples: Vec<Sample>,
    /// El catálogo vino de GitHub (si no, son los incluidos en la app).
    pub online: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    /// Carpeta del proyecto, o el .rxsln si es una solución.
    pub open: String,
    /// Archivo para mostrar en el editor.
    pub file: String,
}

fn parse(text: &str) -> Result<Vec<Sample>, String> {
    let index: Index = serde_json::from_str(text).map_err(|e| format!("Índice de ejemplos inválido: {e}"))?;
    if index.formato != FORMATO {
        return Err(format!("Formato de ejemplos {} no compatible", index.formato));
    }
    Ok(index.ejemplos)
}

fn included() -> Vec<Sample> {
    embedded("index.json").and_then(|b| std::str::from_utf8(b).ok()).and_then(|t| parse(t).ok()).unwrap_or_default()
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(6)).user_agent("RaxorinStudio-ejemplos").build()
}

fn online() -> Result<Vec<Sample>, String> {
    let text = agent().get(&format!("{EN_LINEA}/index.json")).call().map_err(|e| e.to_string())?.into_string().map_err(|e| e.to_string())?;
    parse(&text)
}

/// El catálogo: el de GitHub si responde (y es compatible), si no el incluido.
#[tauri::command]
pub async fn samples_list() -> Result<Catalog, String> {
    tauri::async_runtime::spawn_blocking(|| match online() {
        Ok(samples) if !samples.is_empty() => Catalog { samples, online: true },
        _ => Catalog { samples: included(), online: false },
    })
    .await
    .map_err(|e| e.to_string())
}

/// Contenido de un archivo de un ejemplo: de GitHub si el catálogo vino de allí (puede ser más
/// nuevo), si no (o si falla) el incluido.
fn file_bytes(id: &str, file: &str, prefer_online: bool) -> Result<Vec<u8>, String> {
    let local = || embedded(&format!("{id}/{file}")).map(<[u8]>::to_vec);
    if prefer_online {
        let url = format!("{EN_LINEA}/{id}/{file}");
        if let Ok(resp) = agent().get(&url).call() {
            let mut buf = Vec::new();
            if std::io::Read::read_to_end(&mut resp.into_reader(), &mut buf).is_ok() {
                return Ok(buf);
            }
        }
    }
    local().ok_or_else(|| format!("No se pudo obtener {file} del ejemplo «{id}» (¿sin conexión?)."))
}

/// Un archivo del índice no puede salirse de la carpeta del ejemplo.
fn safe_rel(file: &str) -> Option<PathBuf> {
    let p = Path::new(file);
    p.components().all(|c| matches!(c, std::path::Component::Normal(_))).then(|| p.to_path_buf())
}

/// Cambia el nombre del paquete (la primera línea `name = "…"` de [package]).
fn rename_package(toml: &str, old: &str, new: &str) -> String {
    toml.replacen(&format!("name = \"{old}\""), &format!("name = \"{new}\""), 1)
}

/// Copia el ejemplo a `parent/name`. Proyectos: el paquete pasa a llamarse `name`.
/// Soluciones: el .rxsln pasa a llamarse `name.rxsln` (y la solución, `name`).
pub fn create(sample: &Sample, parent: &Path, name: &str, prefer_online: bool) -> Result<Created, String> {
    let dest = parent.join(name);
    if dest.exists() {
        return Err(format!("Ya existe {}", dest.display()));
    }
    let mut files = Vec::new();
    for f in &sample.archivos {
        let rel = safe_rel(f).ok_or_else(|| format!("Ruta no válida en el ejemplo: {f}"))?;
        files.push((rel, file_bytes(&sample.id, f, prefer_online)?));
    }
    let solution = sample.solucion.as_deref();
    for (rel, mut bytes) in files {
        let mut target = dest.join(&rel);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if Some(rel_str.as_str()) == solution {
            target = dest.join(format!("{name}.rxsln"));
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let renamed = text
                .lines()
                .map(|l| if l.trim_start().starts_with("nombre =") { format!("nombre = {:?}", name) } else { l.to_string() })
                .collect::<Vec<_>>()
                .join("\n");
            bytes = (renamed + "\n").into_bytes();
        } else if solution.is_none() && rel_str == "Cargo.toml" {
            bytes = rename_package(&String::from_utf8_lossy(&bytes), &sample.id, name).into_bytes();
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
        }
        std::fs::write(&target, bytes).map_err(|e| format!("No se pudo escribir {}: {e}", target.display()))?;
    }
    let open = match solution {
        Some(_) => dest.join(format!("{name}.rxsln")),
        None => dest.clone(),
    };
    Ok(Created { open: open.to_string_lossy().into_owned(), file: dest.join(&sample.abrir).to_string_lossy().into_owned() })
}

#[tauri::command]
pub async fn sample_create(sample: Sample, parent: String, name: String, online: bool) -> Result<Created, String> {
    tauri::async_runtime::spawn_blocking(move || create(&sample, Path::new(&parent), &name, online)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_catalogo_incluido_esta_completo() {
        let samples = included();
        assert!(samples.len() >= 10, "{}", samples.len());
        for s in &samples {
            for f in &s.archivos {
                assert!(embedded(&format!("{}/{f}", s.id)).is_some(), "{}: falta {f}", s.id);
            }
            assert!(s.archivos.contains(&s.abrir), "{}: no existe {}", s.id, s.abrir);
        }
    }

    #[test]
    fn crea_proyectos_y_soluciones_con_otro_nombre() {
        let parent = std::env::temp_dir().join(format!("raxorin-ejemplos-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        std::fs::create_dir_all(&parent).unwrap();
        let samples = included();
        let get = |id: &str| samples.iter().find(|s| s.id == id).unwrap();

        let c = create(get("calculadora"), &parent, "mi_calc", false).unwrap();
        let toml = std::fs::read_to_string(parent.join("mi_calc/Cargo.toml")).unwrap();
        assert!(toml.contains("name = \"mi_calc\"") && !toml.contains("calculadora"), "{toml}");
        assert!(c.file.ends_with("app-window.slint") && Path::new(&c.file).is_file());
        assert!(create(get("calculadora"), &parent, "mi_calc", false).unwrap_err().contains("Ya existe"));

        let c = create(get("tienda"), &parent, "Mi tienda", false).unwrap();
        assert!(c.open.ends_with("Mi tienda.rxsln"));
        let sln = std::fs::read_to_string(&c.open).unwrap();
        assert!(sln.contains("nombre = \"Mi tienda\"") && sln.contains("ruta = \"caja\""), "{sln}");
        assert!(!parent.join("Mi tienda/tienda.rxsln").exists());
        // Los proyectos de una solución conservan su nombre (caja usa inventario por su nombre).
        assert!(std::fs::read_to_string(parent.join("Mi tienda/caja/Cargo.toml")).unwrap().contains("name = \"caja\""));
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn rutas_seguras() {
        assert!(safe_rel("src/main.rs").is_some());
        assert!(safe_rel("../fuera.rs").is_none());
        assert!(safe_rel("/etc/passwd").is_none());
    }
}
