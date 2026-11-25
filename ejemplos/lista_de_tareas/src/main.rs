//! Lista de tareas: agregar, marcar como hechas y borrar.
//!
//! Aprenderás: listas en Slint (`for` + `VecModel`), structs compartidos entre Slint y Rust,
//! y `Rc` para que varios callbacks usen el mismo modelo.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::rc::Rc;

use slint::{Model, ModelRc, VecModel};

slint::include_modules!();

fn resumen(tareas: &VecModel<Tarea>) -> String {
    let hechas = tareas.iter().filter(|t| t.hecha).count();
    format!("{hechas} de {} hechas", tareas.row_count())
}

fn main() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;

    // El modelo: cuando cambia, la lista de la ventana se actualiza sola.
    let tareas = Rc::new(VecModel::from(vec![
        Tarea { texto: "Abrir Raxorin Studio".into(), hecha: true },
        Tarea { texto: "Probar este ejemplo".into(), hecha: false },
        Tarea { texto: "Crear mi propia aplicación".into(), hecha: false },
    ]));
    ui.set_tareas(ModelRc::from(tareas.clone()));
    ui.set_resumen(resumen(&tareas).into());

    // Cada callback recibe su copia del Rc (el mismo modelo) y un enlace débil a la ventana.
    let actualizar = {
        let ui = ui.as_weak();
        let tareas = tareas.clone();
        move || {
            if let Some(ui) = ui.upgrade() {
                ui.set_resumen(resumen(&tareas).into());
            }
        }
    };

    ui.on_agregar({
        let (tareas, actualizar) = (tareas.clone(), actualizar.clone());
        move |texto| {
            let texto = texto.trim();
            if !texto.is_empty() {
                tareas.push(Tarea { texto: texto.into(), hecha: false });
                actualizar();
            }
        }
    });

    ui.on_marcar({
        let (tareas, actualizar) = (tareas.clone(), actualizar.clone());
        move |i, hecha| {
            if let Some(mut t) = tareas.row_data(i as usize) {
                t.hecha = hecha;
                tareas.set_row_data(i as usize, t);
                actualizar();
            }
        }
    });

    ui.on_borrar({
        let (tareas, actualizar) = (tareas.clone(), actualizar.clone());
        move |i| {
            tareas.remove(i as usize);
            actualizar();
        }
    });

    ui.on_borrar_hechas({
        let tareas = tareas.clone();
        move || {
            let pendientes: Vec<Tarea> = tareas.iter().filter(|t| !t.hecha).collect();
            tareas.set_vec(pendientes);
            actualizar();
        }
    });

    ui.run()
}
