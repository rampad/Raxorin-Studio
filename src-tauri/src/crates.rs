//! Gestor de paquetes (crates), al estilo del administrador de NuGet.
//!
//! - Búsqueda, detalles y README: API pública de crates.io.
//! - Instalar / quitar / features: `cargo add` y `cargo remove` (editan Cargo.toml).
//! - Dependencias del proyecto y versiones reales: `cargo metadata`.

use crate::toolchain::{cargo_bin, new_command};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

const API: &str = "https://crates.io/api/v1";
// crates.io pide identificar al cliente con un User-Agent propio.
const USER_AGENT: &str = "oxide-studio-ide/0.2 (IDE de escritorio para Rust)";

fn http_json(url: &str) -> Result<Value, String> {
    ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => "No se encontró en crates.io".to_string(),
            ureq::Error::Status(code, _) => format!("crates.io respondió con error {code}"),
            ureq::Error::Transport(t) => format!("Sin conexión con crates.io: {t}"),
        })?
        .into_json()
        .map_err(|e| format!("Respuesta inválida de crates.io: {e}"))
}

fn http_text(url: &str) -> Result<String, String> {
    ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

/// Codifica un parámetro de URL (sin dependencias extra).
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn str_of(v: &Value, k: &str) -> Option<String> {
    v[k].as_str().map(String::from)
}

// ---------- Búsqueda ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateSummary {
    name: String,
    description: String,
    version: String,
    downloads: u64,
    recent_downloads: u64,
    updated_at: String,
}

fn summary(c: &Value) -> CrateSummary {
    CrateSummary {
        name: str_of(c, "name").unwrap_or_default(),
        description: str_of(c, "description").unwrap_or_default().trim().to_string(),
        version: str_of(c, "max_stable_version").or_else(|| str_of(c, "max_version")).unwrap_or_default(),
        downloads: c["downloads"].as_u64().unwrap_or(0),
        recent_downloads: c["recent_downloads"].as_u64().unwrap_or(0),
        updated_at: str_of(c, "updated_at").unwrap_or_default(),
    }
}

/// Busca en crates.io. Sin texto, devuelve los más descargados recientemente.
#[tauri::command]
pub async fn crate_search(query: String, page: Option<u32>) -> Result<Vec<CrateSummary>, String> {
    blocking(move || {
        let q = query.trim();
        let page = page.unwrap_or(1).max(1);
        let url = if q.is_empty() {
            format!("{API}/crates?sort=recent-downloads&per_page=30&page={page}")
        } else {
            format!("{API}/crates?q={}&per_page=30&page={page}", encode(q))
        };
        let v = http_json(&url)?;
        Ok(v["crates"].as_array().map(|a| a.iter().map(summary).collect()).unwrap_or_default())
    })
    .await
}

// ---------- Detalles ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    num: String,
    created_at: String,
    license: Option<String>,
    rust_version: Option<String>,
    features: BTreeMap<String, Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateDetails {
    #[serde(flatten)]
    summary: CrateSummary,
    homepage: Option<String>,
    repository: Option<String>,
    documentation: Option<String>,
    keywords: Vec<String>,
    categories: Vec<String>,
    /// Versiones estables, de la más nueva a la más vieja (máx. 40).
    versions: Vec<VersionInfo>,
}

#[tauri::command]
pub async fn crate_details(name: String) -> Result<CrateDetails, String> {
    if !valid_name(&name) {
        return Err(format!("Nombre de crate inválido: {name}"));
    }
    blocking(move || {
        let v = http_json(&format!("{API}/crates/{name}"))?;
        let c = &v["crate"];
        let names = |key: &str, field: &str| -> Vec<String> {
            v[key].as_array().into_iter().flatten().filter_map(|x| str_of(x, field)).collect()
        };
        let versions = v["versions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|x| !x["yanked"].as_bool().unwrap_or(false))
            .filter(|x| !x["num"].as_str().unwrap_or("").contains('-')) // sin pre-releases
            .take(40)
            .map(|x| VersionInfo {
                num: str_of(x, "num").unwrap_or_default(),
                created_at: str_of(x, "created_at").unwrap_or_default(),
                license: str_of(x, "license"),
                rust_version: str_of(x, "rust_version"),
                features: serde_json::from_value(x["features"].clone()).unwrap_or_default(),
            })
            .collect();
        Ok(CrateDetails {
            summary: summary(c),
            homepage: str_of(c, "homepage"),
            repository: str_of(c, "repository"),
            documentation: str_of(c, "documentation"),
            keywords: names("keywords", "keyword"),
            categories: names("categories", "category"),
            versions,
        })
    })
    .await
}

/// README en HTML (crates.io ya lo entrega saneado).
#[tauri::command]
pub async fn crate_readme(name: String, version: String) -> Result<String, String> {
    if !valid_name(&name) || !version.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)) {
        return Err("Parámetros inválidos".into());
    }
    blocking(move || http_text(&format!("{API}/crates/{name}/{version}/readme"))).await
}

/// Última versión estable de varios crates (para detectar actualizaciones).
#[tauri::command]
pub async fn crate_latest(names: Vec<String>) -> Result<HashMap<String, String>, String> {
    blocking(move || {
        let handles: Vec<_> = names
            .into_iter()
            .filter(|n| valid_name(n))
            .take(60)
            .map(|n| {
                std::thread::spawn(move || {
                    let v = http_json(&format!("{API}/crates/{n}")).ok()?;
                    let c = &v["crate"];
                    let ver = str_of(c, "max_stable_version").or_else(|| str_of(c, "max_version"))?;
                    Some((n, ver))
                })
            })
            .collect();
        Ok(handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect())
    })
    .await
}

// ---------- Dependencias del proyecto ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    name: String,
    /// Requisito escrito en Cargo.toml (p. ej. "^1.0").
    req: String,
    /// Versión realmente usada según Cargo.lock (si ya se resolvió).
    resolved: Option<String>,
    /// "normal", "dev" o "build"
    kind: String,
    features: Vec<String>,
    default_features: bool,
    optional: bool,
    /// Ruta si es una referencia a un proyecto local.
    path: Option<String>,
}

fn cargo_output(project: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = new_command(cargo_bin())
        .args(args)
        .current_dir(project)
        .env("CARGO_TERM_COLOR", "never")
        .output()
        .map_err(|e| format!("No se pudo ejecutar cargo: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn crate_list(project: String) -> Result<Vec<Dependency>, String> {
    blocking(move || {
        // Con dependencias resueltas (sin red); si falla, solo lo declarado.
        let (v, resolved) = match cargo_output(&project, &["metadata", "--format-version", "1", "--offline"]) {
            Ok(bytes) => (serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?, true),
            Err(_) => {
                let bytes = cargo_output(&project, &["metadata", "--no-deps", "--format-version", "1"])?;
                (serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?, false)
            }
        };
        let manifest = std::path::Path::new(&project).join("Cargo.toml");
        let canonical = std::fs::canonicalize(&manifest).unwrap_or(manifest.clone());
        let packages = v["packages"].as_array().cloned().unwrap_or_default();
        let is_this = |p: &&Value| {
            let m = std::path::PathBuf::from(p["manifest_path"].as_str().unwrap_or(""));
            m == manifest || m == canonical
        };
        let pkg = packages
            .iter()
            .find(is_this)
            .or_else(|| packages.iter().find(|p| p["source"].is_null()))
            .ok_or("No se encontró el paquete en Cargo.toml")?;

        // Versiones resueltas de las dependencias directas: id → (nombre, versión).
        let mut versions: HashMap<String, String> = HashMap::new();
        if resolved {
            let by_id: HashMap<&str, &Value> =
                packages.iter().filter_map(|p| Some((p["id"].as_str()?, p))).collect();
            let root_id = pkg["id"].as_str().unwrap_or("");
            if let Some(node) = v["resolve"]["nodes"]
                .as_array()
                .and_then(|n| n.iter().find(|n| n["id"].as_str() == Some(root_id)))
            {
                for id in node["dependencies"].as_array().into_iter().flatten().filter_map(|x| x.as_str()) {
                    if let Some(p) = by_id.get(id) {
                        if let (Some(n), Some(ver)) = (p["name"].as_str(), p["version"].as_str()) {
                            versions.insert(n.to_string(), ver.to_string());
                        }
                    }
                }
            }
        }

        if !resolved {
            versions = lockfile_versions(&project);
        }

        Ok(pkg["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| {
                let name = str_of(d, "name").unwrap_or_default();
                Dependency {
                    resolved: versions.get(&name).cloned(),
                    name: str_of(d, "rename").unwrap_or(name),
                    req: str_of(d, "req").unwrap_or_else(|| "*".into()),
                    kind: str_of(d, "kind").unwrap_or_else(|| "normal".into()),
                    features: d["features"]
                        .as_array()
                        .map(|f| f.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                        .unwrap_or_default(),
                    default_features: d["uses_default_features"].as_bool().unwrap_or(true),
                    optional: d["optional"].as_bool().unwrap_or(false),
                    path: str_of(d, "path"),
                }
            })
            .collect())
    })
    .await
}

/// Lee las versiones de Cargo.lock (buscándolo hacia arriba, por si es un workspace).
/// Si un crate aparece en varias versiones, se toma la más alta.
fn lockfile_versions(project: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut dir = Some(std::path::Path::new(project));
    let text = loop {
        let Some(d) = dir else { return out };
        if let Ok(t) = std::fs::read_to_string(d.join("Cargo.lock")) {
            break t;
        }
        dir = d.parent();
    };
    let parse = |v: &str| -> Vec<u64> { v.split(['.', '-', '+']).map(|p| p.parse().unwrap_or(0)).collect() };
    let mut name: Option<String> = None;
    for line in text.lines() {
        if line.starts_with("[[package]]") {
            name = None;
        } else if let Some(n) = line.strip_prefix("name = ") {
            name = Some(n.trim_matches('"').to_string());
        } else if let (Some(v), Some(n)) = (line.strip_prefix("version = "), name.as_ref()) {
            let v = v.trim_matches('"').to_string();
            let newer = out.get(n).is_none_or(|old| parse(&v) > parse(old));
            if newer {
                out.insert(n.clone(), v);
            }
        }
    }
    out
}

// ---------- Instalar / quitar ----------

fn kind_flag(kind: &str) -> Option<&'static str> {
    match kind {
        "dev" => Some("--dev"),
        "build" => Some("--build"),
        _ => None,
    }
}

/// `cargo add` devuelve su resumen por stderr incluso cuando tiene éxito.
fn cargo_add_like(project: &str, args: &[String]) -> Result<String, String> {
    let out = new_command(cargo_bin())
        .args(args)
        .current_dir(project)
        .env("CARGO_TERM_COLOR", "never")
        .output()
        .map_err(|e| format!("No se pudo ejecutar cargo: {e}"))?;
    let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() { Ok(text) } else { Err(text) }
}

/// `cargo add nombre[@versión] [--dev] [--features a,b] [--no-default-features]`
#[tauri::command]
pub async fn crate_add(
    project: String,
    name: String,
    version: Option<String>,
    features: Option<Vec<String>>,
    kind: Option<String>,
    default_features: Option<bool>,
) -> Result<String, String> {
    if !valid_name(&name) {
        return Err(format!("Nombre de crate inválido: {name}"));
    }
    blocking(move || {
        let spec = match version.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            Some(v) => format!("{name}@{v}"),
            None => name,
        };
        let mut args = vec!["add".to_string(), spec];
        if let Some(flag) = kind.as_deref().and_then(kind_flag) {
            args.push(flag.into());
        }
        let feats: Vec<String> = features.unwrap_or_default().into_iter().filter(|f| valid_name(f)).collect();
        if !feats.is_empty() {
            args.push("--features".into());
            args.push(feats.join(","));
        }
        if default_features == Some(false) {
            args.push("--no-default-features".into());
        }
        cargo_add_like(&project, &args)
    })
    .await
}

/// Cambiar las features de una dependencia ya instalada: se quita y se vuelve a agregar
/// con el mismo requisito de versión (cargo add solo sabe agregar features).
#[tauri::command]
pub async fn crate_set_features(
    project: String,
    name: String,
    req: String,
    kind: String,
    features: Vec<String>,
    default_features: bool,
) -> Result<String, String> {
    if !valid_name(&name) {
        return Err(format!("Nombre de crate inválido: {name}"));
    }
    blocking(move || {
        let mut rm = vec!["remove".to_string(), name.clone()];
        if let Some(flag) = kind_flag(&kind) {
            rm.push(flag.into());
        }
        cargo_add_like(&project, &rm)?;
        let version = req.trim_start_matches('^').to_string();
        let mut add = vec!["add".to_string(), format!("{name}@{version}")];
        if let Some(flag) = kind_flag(&kind) {
            add.push(flag.into());
        }
        let feats: Vec<String> = features.into_iter().filter(|f| valid_name(f)).collect();
        if !feats.is_empty() {
            add.push("--features".into());
            add.push(feats.join(","));
        }
        if !default_features {
            add.push("--no-default-features".into());
        }
        cargo_add_like(&project, &add)
    })
    .await
}

#[tauri::command]
pub async fn crate_remove(project: String, name: String, kind: String) -> Result<(), String> {
    if !valid_name(&name) {
        return Err(format!("Nombre de crate inválido: {name}"));
    }
    blocking(move || {
        let mut args = vec!["remove".to_string(), name];
        if let Some(flag) = kind_flag(&kind) {
            args.push(flag.into());
        }
        cargo_add_like(&project, &args).map(|_| ())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_cargo_lock() {
        let dir = std::env::temp_dir().join(format!("rs-lock-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("app")).unwrap();
        std::fs::write(
            dir.join("Cargo.lock"),
            "version = 4\n\n[[package]]\nname = \"rand\"\nversion = \"0.8.5\"\n\n[[package]]\nname = \"rand\"\nversion = \"0.10.4\"\nsource = \"x\"\n",
        )
        .unwrap();
        let v = lockfile_versions(dir.join("app").to_str().unwrap());
        assert_eq!(v.get("rand").map(String::as_str), Some("0.10.4"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn codifica_parametros() {
        assert_eq!(encode("serde json"), "serde%20json");
        assert_eq!(encode("a&b=c"), "a%26b%3Dc");
    }

    /// Requiere red: `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn consulta_crates_io() {
        let v = http_json(&format!("{API}/crates/serde")).unwrap();
        let s = summary(&v["crate"]);
        assert_eq!(s.name, "serde");
        assert!(s.downloads > 1_000_000);
    }
}
