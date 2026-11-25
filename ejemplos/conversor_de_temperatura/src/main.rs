//! Conversor de temperatura: dos campos que se actualizan entre sí.
//!
//! Aprenderás: propiedades y callbacks de Slint, y convertir texto a número.
//! La interfaz está en ui/app-window.slint (ábrela para verla en el diseñador).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

/// "21.5" → Some(21.5); acepta coma decimal ("21,5").
fn numero(texto: &str) -> Option<f64> {
    texto.trim().replace(',', ".").parse().ok()
}

/// Muestra el número sin decimales de más (100 en vez de 100.00).
fn mostrar(valor: f64) -> String {
    let s = format!("{valor:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn main() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;

    ui.on_celsius_cambiado({
        let ui = ui.as_weak();
        move |texto| {
            if let (Some(ui), Some(c)) = (ui.upgrade(), numero(&texto)) {
                ui.set_fahrenheit(mostrar(c * 9.0 / 5.0 + 32.0).into());
            }
        }
    });

    ui.on_fahrenheit_cambiado({
        let ui = ui.as_weak();
        move |texto| {
            if let (Some(ui), Some(f)) = (ui.upgrade(), numero(&texto)) {
                ui.set_celsius(mostrar((f - 32.0) * 5.0 / 9.0).into());
            }
        }
    });

    ui.run()
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn convierte_y_muestra() {
        assert_eq!(numero("21,5"), Some(21.5));
        assert_eq!(mostrar(100.0 * 9.0 / 5.0 + 32.0), "212");
        assert_eq!(mostrar(36.6), "36.6");
    }
}
