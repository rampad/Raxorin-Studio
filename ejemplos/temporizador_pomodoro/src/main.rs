//! Temporizador Pomodoro: 25 minutos de concentración y 5 de descanso.
//!
//! Aprenderás: `slint::Timer` para hacer algo cada segundo, y guardar estado con `Cell`.
//! Para probarlo rápido, baja `CONCENTRACION` a 10 segundos.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

slint::include_modules!();

const CONCENTRACION: u32 = 25 * 60;
const DESCANSO: u32 = 5 * 60;

fn formato(segundos: u32) -> String {
    format!("{:02}:{:02}", segundos / 60, segundos % 60)
}

fn main() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;
    let restante = Rc::new(Cell::new(CONCENTRACION));
    let descansando = Rc::new(Cell::new(false));
    let reloj = Rc::new(slint::Timer::default());

    let mostrar = {
        let (ui, restante, descansando) = (ui.as_weak(), restante.clone(), descansando.clone());
        move || {
            let Some(ui) = ui.upgrade() else { return };
            let total = if descansando.get() { DESCANSO } else { CONCENTRACION };
            ui.set_tiempo(formato(restante.get()).into());
            ui.set_fase(if descansando.get() { "Descanso ☕" } else { "Concentración" }.into());
            ui.set_progreso(1.0 - restante.get() as f32 / total as f32);
        }
    };

    ui.on_iniciar_pausar({
        let (ui_weak, reloj, mostrar) = (ui.as_weak(), reloj.clone(), mostrar.clone());
        let (restante, descansando) = (restante.clone(), descansando.clone());
        move || {
            if reloj.running() {
                reloj.stop();
            } else {
                let (restante, descansando, mostrar) = (restante.clone(), descansando.clone(), mostrar.clone());
                // Cada segundo: descontar y, al llegar a cero, cambiar de fase.
                reloj.start(slint::TimerMode::Repeated, Duration::from_secs(1), move || {
                    if restante.get() > 1 {
                        restante.set(restante.get() - 1);
                    } else {
                        descansando.set(!descansando.get());
                        restante.set(if descansando.get() { DESCANSO } else { CONCENTRACION });
                    }
                    mostrar();
                });
            }
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_corriendo(reloj.running());
            }
        }
    });

    ui.on_reiniciar({
        let (ui_weak, reloj) = (ui.as_weak(), reloj.clone());
        move || {
            reloj.stop();
            restante.set(CONCENTRACION);
            descansando.set(false);
            mostrar();
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_corriendo(false);
            }
        }
    });

    ui.run()
}
