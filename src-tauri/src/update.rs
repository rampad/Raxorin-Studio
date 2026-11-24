// Actualizaciones de Raxorin Studio con el actualizador oficial de Tauri.
// Las versiones están firmadas: la app solo instala archivos firmados con la clave del
// proyecto (la pública está en tauri.conf.json). Hay dos canales: "estable" (la última
// versión publicada) y "beta" (también las versiones de prueba, p. ej. v0.4.0-beta.1).

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

const REPO: &str = "rampad/Raxorin-Studio";
const STABLE_URL: &str = "https://github.com/rampad/Raxorin-Studio/releases/latest/download/latest.json";

/// Actualización encontrada, a la espera de que el usuario decida instalarla.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    done: bool,
}

/// Elige la dirección del `latest.json` según el canal.
/// `RAXORIN_UPDATE_ENDPOINT` la reemplaza (para probar con un servidor local).
fn endpoint(channel: &str) -> Result<String, String> {
    if let Ok(e) = std::env::var("RAXORIN_UPDATE_ENDPOINT") {
        return Ok(e);
    }
    if channel != "beta" {
        return Ok(STABLE_URL.into());
    }
    // Beta: la versión más nueva publicada (aunque sea de prueba) que tenga latest.json.
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=15");
    let releases: serde_json::Value = ureq::get(&url)
        .set("User-Agent", "RaxorinStudio-updater")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("No se pudo consultar GitHub: {e}"))?
        .into_json()
        .map_err(|e| e.to_string())?;
    pick_latest_json(&releases).ok_or_else(|| "No hay versiones con actualización automática todavía.".into())
}

/// De la lista de versiones de GitHub, la URL del latest.json de la más nueva publicada.
pub fn pick_latest_json(releases: &serde_json::Value) -> Option<String> {
    releases.as_array()?.iter().filter(|r| !r["draft"].as_bool().unwrap_or(false)).find_map(|r| {
        r["assets"].as_array()?.iter().find(|a| a["name"] == "latest.json").and_then(|a| a["browser_download_url"].as_str().map(String::from))
    })
}

/// Explica los errores del actualizador en español.
fn explain(e: &str) -> String {
    if e.contains("Could not fetch a valid release JSON") || e.contains("404") {
        "Todavía no hay información de actualizaciones publicada.".into()
    } else if e.contains("signature") || e.contains("Signature") {
        format!("La actualización no tiene una firma válida y no se instaló (por seguridad). Detalle: {e}")
    } else if e.contains("dns") || e.contains("connect") || e.contains("timed out") {
        "No hay conexión a internet (o GitHub no responde).".into()
    } else {
        e.to_string()
    }
}

async fn find(app: &AppHandle, channel: String) -> Result<Option<Update>, String> {
    let url = tauri::async_runtime::spawn_blocking(move || endpoint(&channel)).await.map_err(|e| e.to_string())??;
    let url: Url = url.parse().map_err(|e| format!("Dirección inválida: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| explain(&e.to_string()))?
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| explain(&e.to_string()))?;
    updater.check().await.map_err(|e| explain(&e.to_string()))
}

fn info(u: &Update) -> UpdateInfo {
    UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        date: u.date.map(|d| d.date().to_string()),
    }
}

/// Busca una versión nueva. None = ya está al día.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: tauri::State<'_, PendingUpdate>, channel: String) -> Result<Option<UpdateInfo>, String> {
    let found = find(&app, channel).await?;
    let out = found.as_ref().map(info);
    *state.0.lock().unwrap() = found;
    Ok(out)
}

async fn install(app: &AppHandle, update: Update) -> Result<(), String> {
    let mut downloaded = 0u64;
    let progress = app.clone();
    let done = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit("update-progress", Progress { downloaded, total, done: false });
            },
            move || {
                let _ = done.emit("update-progress", Progress { downloaded: 0, total: None, done: true });
            },
        )
        .await
        .map_err(|e| explain(&e.to_string()))
}

/// Descarga, verifica la firma e instala la versión encontrada con `update_check`.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: tauri::State<'_, PendingUpdate>) -> Result<(), String> {
    let update = state.0.lock().unwrap().take().ok_or("Primero busca actualizaciones.")?;
    install(&app, update).await
}

/// Reinicia la app (después de instalar).
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart();
}

/// `raxorin-studio --actualizar [--beta]`: busca e instala sin abrir la ventana.
pub fn cli_requested() -> Option<&'static str> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--actualizar" || a == "--update") {
        Some(if args.iter().any(|a| a == "--beta") { "beta" } else { "stable" })
    } else {
        None
    }
}

pub async fn cli_update(app: AppHandle, channel: &str) -> i32 {
    println!("Raxorin Studio {}: buscando actualizaciones (canal {channel})…", app.package_info().version);
    match find(&app, channel.to_string()).await {
        Ok(None) => {
            println!("✔ Ya tienes la última versión.");
            0
        }
        Ok(Some(u)) => {
            println!("Instalando la versión {}…", u.version);
            match install(&app, u).await {
                Ok(()) => {
                    println!("✔ Actualización instalada.");
                    0
                }
                Err(e) => {
                    eprintln!("✖ {e}");
                    1
                }
            }
        }
        Err(e) => {
            eprintln!("✖ {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elige_el_latest_json_mas_nuevo_publicado() {
        let releases = serde_json::json!([
            { "draft": true, "assets": [{ "name": "latest.json", "browser_download_url": "https://x/borrador.json" }] },
            { "draft": false, "prerelease": true, "assets": [{ "name": "app.dmg", "browser_download_url": "https://x/app.dmg" }] },
            { "draft": false, "prerelease": true, "assets": [{ "name": "latest.json", "browser_download_url": "https://x/beta.json" }] },
            { "draft": false, "assets": [{ "name": "latest.json", "browser_download_url": "https://x/estable.json" }] },
        ]);
        assert_eq!(pick_latest_json(&releases).as_deref(), Some("https://x/beta.json"), "ignora borradores y versiones sin latest.json");
        assert_eq!(pick_latest_json(&serde_json::json!([])), None);
    }

    #[test]
    fn errores_en_espanol() {
        assert!(explain("Could not fetch a valid release JSON from the remote").contains("Todavía no hay"));
        assert!(explain("signature verification failed").contains("firma"));
    }
}
