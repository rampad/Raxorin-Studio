//! Galería de controles: los controles y eventos de Slint que ofrece el diseñador de Raxorin Studio.
//!
//! Aprenderás: Timer, StandardListView y su evento al cambiar la selección, TouchArea (zonas
//! clicables), Slider vertical con el evento al soltar, StandardButton, sombras, íconos coloreados.
//! Abre ui/app-window.slint en el diseñador: cada control tiene sus propiedades y eventos.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

const COLORES: [&str; 4] = ["Rojo", "Verde", "Azul", "Naranja"];

fn main() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;

    // Timer: cada segundo (interval: 1000ms) se actualiza el reloj.
    ui.on_temporizador1_triggered({
        let ui = ui.as_weak();
        move || {
            if let Some(ui) = ui.upgrade() {
                ui.set_hora_text(chrono::Local::now().format("%H:%M:%S").to_string().into());
            }
        }
    });

    // StandardListView: el índice del elemento elegido.
    ui.on_lista1_current_item_changed({
        let ui = ui.as_weak();
        move |indice| {
            if let Some(ui) = ui.upgrade() {
                let color = COLORES.get(indice as usize).unwrap_or(&"?");
                ui.set_estado_text(format!("Elegiste: {color} (elemento {indice})").into());
            }
        }
    });

    // TouchArea: cualquier zona puede ser clicable.
    ui.on_tarjeta_clicked({
        let ui = ui.as_weak();
        move || {
            if let Some(ui) = ui.upgrade() {
                ui.set_estado_text("¡Hiciste clic en la tarjeta!".into());
            }
        }
    });

    // Slider: «released» llega una vez, al soltar (changed llega mientras se arrastra).
    ui.on_volumen_released({
        let ui = ui.as_weak();
        move |valor| {
            if let Some(ui) = ui.upgrade() {
                ui.set_estado_text(format!("Volumen guardado: {}", valor.round()).into());
            }
        }
    });

    // StandardButton: botones con el texto estándar (OK, Cancel).
    ui.on_aceptar_clicked({
        let ui = ui.as_weak();
        move || {
            if let Some(ui) = ui.upgrade() {
                ui.set_estado_text("Aceptado.".into());
            }
        }
    });
    ui.on_cancelar_clicked({
        let ui = ui.as_weak();
        move || {
            if let Some(ui) = ui.upgrade() {
                ui.set_volumen_value(40.0);
                ui.set_estado_text("Cancelado: el volumen vuelve a 40.".into());
            }
        }
    });

    ui.run()
}
