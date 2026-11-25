//! Calculadora: una ventana con teclas y la lógica separada en un `struct`.
//!
//! Aprenderás: `enum`, `struct` con métodos, `match` y conectar una interfaz Slint con Rust.
//! La lógica (`Calculadora`) no sabe nada de la ventana: por eso se puede probar (Pruebas).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::cell::RefCell;
use std::rc::Rc;

slint::include_modules!();

#[derive(Clone, Copy)]
enum Operacion {
    Sumar,
    Restar,
    Multiplicar,
    Dividir,
}

#[derive(Default)]
struct Calculadora {
    /// Lo que se ve en la pantalla.
    pantalla: String,
    /// El número anterior y la operación pendiente (p. ej. "8 +").
    pendiente: Option<(f64, Operacion)>,
    /// La próxima cifra empieza un número nuevo.
    nuevo_numero: bool,
}

impl Calculadora {
    fn valor(&self) -> f64 {
        self.pantalla.parse().unwrap_or(0.0)
    }

    fn mostrar(&mut self, v: f64) {
        self.pantalla = if v.is_finite() { format!("{}", (v * 1e10).round() / 1e10) } else { "Error".into() };
    }

    fn calcular(&mut self) {
        if let Some((a, op)) = self.pendiente.take() {
            let b = self.valor();
            self.mostrar(match op {
                Operacion::Sumar => a + b,
                Operacion::Restar => a - b,
                Operacion::Multiplicar => a * b,
                Operacion::Dividir => a / b,
            });
        }
        self.nuevo_numero = true;
    }

    fn tecla(&mut self, t: &str) {
        let operacion = match t {
            "+" => Some(Operacion::Sumar),
            "−" => Some(Operacion::Restar),
            "×" => Some(Operacion::Multiplicar),
            "÷" => Some(Operacion::Dividir),
            _ => None,
        };
        match (t, operacion) {
            (_, Some(op)) => {
                self.calcular();
                self.pendiente = Some((self.valor(), op));
            }
            ("=", _) => self.calcular(),
            ("C", _) => *self = Calculadora::default(),
            ("±", _) => { let v = -self.valor(); self.mostrar(v) }
            ("%", _) => { let v = self.valor() / 100.0; self.mostrar(v) }
            (cifra, _) => {
                if self.nuevo_numero || self.pantalla == "0" || self.pantalla == "Error" {
                    self.pantalla.clear();
                    self.nuevo_numero = false;
                }
                if cifra == "." && self.pantalla.contains('.') {
                    return;
                }
                if cifra == "." && self.pantalla.is_empty() {
                    self.pantalla.push('0');
                }
                self.pantalla.push_str(cifra);
            }
        }
    }

    fn texto(&self) -> &str {
        if self.pantalla.is_empty() { "0" } else { &self.pantalla }
    }
}

fn main() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;
    // Rc<RefCell<…>>: el estado se comparte con el callback y se puede modificar desde él.
    let calc = Rc::new(RefCell::new(Calculadora::default()));

    ui.on_tecla({
        let ui = ui.as_weak();
        move |t| {
            let mut c = calc.borrow_mut();
            c.tecla(&t);
            if let Some(ui) = ui.upgrade() {
                ui.set_pantalla(c.texto().into());
            }
        }
    });

    ui.run()
}

#[cfg(test)]
mod pruebas {
    use super::*;

    fn teclear(teclas: &[&str]) -> String {
        let mut c = Calculadora::default();
        for t in teclas {
            c.tecla(t);
        }
        c.texto().to_string()
    }

    #[test]
    fn opera() {
        assert_eq!(teclear(&["1", "2", "+", "3", "="]), "15");
        assert_eq!(teclear(&["2", "+", "3", "×", "4", "="]), "20"); // de izquierda a derecha
        assert_eq!(teclear(&["0", ".", "1", "+", "0", ".", "2", "="]), "0.3");
        assert_eq!(teclear(&["1", "÷", "0", "="]), "Error");
    }
}
