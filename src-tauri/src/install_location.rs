//! macOS: si la app se abrió desde el instalador (.dmg) en vez de desde Aplicaciones, ofrecer
//! moverla. Desde el .dmg no aparece en Aplicaciones ni en Launchpad, desaparece al expulsar el
//! disco y el actualizador no puede reemplazarla (el disco es de solo lectura).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::toolchain::new_command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// Hay que ofrecer moverla a Aplicaciones.
    pub needs_move: bool,
    /// "dmg" (se abrió desde el disco del instalador) o "translocated" (macOS la ejecuta desde una
    /// copia temporal porque está en Descargas u otra carpeta con cuarentena).
    pub reason: Option<String>,
    pub app_path: Option<String>,
}

/// La carpeta `.app` que contiene este ejecutable.
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

/// Por qué hay que moverla, según dónde está el `.app` (None: está bien donde está).
fn reason_for(app: &Path) -> Option<&'static str> {
    let s = app.to_string_lossy();
    if s.contains("/AppTranslocation/") {
        Some("translocated")
    } else if s.starts_with("/Volumes/") {
        Some("dmg")
    } else {
        None
    }
}

#[tauri::command]
pub fn app_location() -> Location {
    let app = std::env::current_exe().ok().and_then(|e| bundle_of(&e));
    let reason = if cfg!(target_os = "macos") { app.as_deref().and_then(reason_for) } else { None };
    Location { needs_move: reason.is_some(), reason: reason.map(String::from), app_path: app.map(|p| p.to_string_lossy().into_owned()) }
}

/// Copia `src` (un .app) dentro de `dir`. Si ya hay una versión ahí, la manda a la papelera.
/// Devuelve la ruta nueva.
fn copy_bundle(src: &Path, dir: &Path, remove_old: impl Fn(&Path) -> Result<(), String>) -> Result<PathBuf, String> {
    let name = src.file_name().ok_or("Ruta de la app no válida")?;
    let dest = dir.join(name);
    if dest.exists() {
        remove_old(&dest)?;
    }
    // ditto conserva todo lo de un .app (enlaces, permisos, firma y atributos).
    let out = new_command("ditto").arg(src).arg(&dest).output().map_err(|e| format!("No se pudo copiar: {e}"))?;
    if !out.status.success() {
        return Err(format!("No se pudo copiar la app a {}: {}", dir.display(), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(dest)
}

/// /Applications si se puede escribir ahí; si no (usuario sin permisos), ~/Applications.
fn applications_dir() -> Result<PathBuf, String> {
    let system = PathBuf::from("/Applications");
    let probe = system.join(".raxorin-escritura");
    if std::fs::write(&probe, b"").is_ok() {
        let _ = std::fs::remove_file(&probe);
        return Ok(system);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("No se encontró la carpeta del usuario")?;
    let user = home.join("Applications");
    std::fs::create_dir_all(&user).map_err(|e| format!("No se pudo crear {}: {e}", user.display()))?;
    Ok(user)
}

/// Copia la app a Aplicaciones, la vuelve a abrir desde allí y cierra esta. Si venía de un .dmg,
/// expulsa el disco cuando esta copia ya se cerró.
#[tauri::command]
pub fn move_to_applications(app: AppHandle) -> Result<String, String> {
    let src = std::env::current_exe().ok().and_then(|e| bundle_of(&e)).ok_or("No se encontró la app")?;
    let to_trash = |old: &Path| {
        trash::delete(old).map_err(|e| format!("No se pudo mover a la papelera la versión anterior ({}): {e}", old.display()))
    };
    let dest = copy_bundle(&src, &applications_dir()?, to_trash)?;
    let quote = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"));
    let volume = src
        .to_string_lossy()
        .strip_prefix("/Volumes/")
        .and_then(|rest| rest.split('/').next())
        .map(|v| PathBuf::from("/Volumes").join(v));
    // Un shell aparte espera a que esta app termine, expulsa el disco y abre la copia nueva.
    let mut script = format!("while kill -0 {} 2>/dev/null; do sleep 0.2; done; ", std::process::id());
    if let Some(v) = &volume {
        script.push_str(&format!("hdiutil detach {} -quiet || true; ", quote(v)));
    }
    script.push_str(&format!("open {}", quote(&dest)));
    new_command("/bin/sh").args(["-c", &script]).spawn().map_err(|e| format!("No se pudo volver a abrir la app: {e}"))?;
    app.exit(0);
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detecta_dmg_y_translocacion() {
        let exe = Path::new("/Volumes/Raxorin Studio/Raxorin Studio.app/Contents/MacOS/raxorin-studio");
        let app = bundle_of(exe).unwrap();
        assert_eq!(app, Path::new("/Volumes/Raxorin Studio/Raxorin Studio.app"));
        assert_eq!(reason_for(&app), Some("dmg"));
        let t = Path::new("/private/var/folders/x/AppTranslocation/ABC/d/Raxorin Studio.app");
        assert_eq!(reason_for(t), Some("translocated"));
        assert_eq!(reason_for(Path::new("/Applications/Raxorin Studio.app")), None);
        assert_eq!(reason_for(Path::new("/Users/ana/Applications/Raxorin Studio.app")), None);
        assert_eq!(bundle_of(Path::new("/usr/bin/raxorin")), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn copia_el_bundle_y_reemplaza_la_version_anterior() {
        let base = std::env::temp_dir().join(format!("raxorin-mover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("origen/Prueba.app/Contents/MacOS");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("prueba"), b"v2").unwrap();
        let dir = base.join("Aplicaciones");
        std::fs::create_dir_all(dir.join("Prueba.app/Contents/MacOS")).unwrap();
        std::fs::write(dir.join("Prueba.app/Contents/MacOS/prueba"), b"v1").unwrap();
        // En la prueba se borra directo (sin llenar la Papelera del usuario).
        let dest = copy_bundle(&base.join("origen/Prueba.app"), &dir, |old| std::fs::remove_dir_all(old).map_err(|e| e.to_string())).unwrap();
        assert_eq!(std::fs::read(dest.join("Contents/MacOS/prueba")).unwrap(), b"v2");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
