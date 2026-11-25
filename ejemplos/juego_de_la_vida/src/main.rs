//! El juego de la vida de Conway, animado en la consola.
//!
//! Aprenderás: `struct`, `impl`, vectores de dos dimensiones y bucles.
//! Reglas: una célula viva con 2 o 3 vecinas sigue viva; una muerta con 3 vecinas nace.

use std::{thread, time::Duration};

const ANCHO: usize = 40;
const ALTO: usize = 20;

struct Mundo {
    celdas: Vec<Vec<bool>>,
}

impl Mundo {
    /// Un mundo con un "planeador" y un "oscilador".
    fn nuevo() -> Self {
        let mut celdas = vec![vec![false; ANCHO]; ALTO];
        for (f, c) in [(1, 2), (2, 3), (3, 1), (3, 2), (3, 3)] {
            celdas[f][c] = true; // planeador
        }
        for c in 20..23 {
            celdas[10][c] = true; // oscilador
        }
        Mundo { celdas }
    }

    /// Cuántas de las 8 vecinas están vivas (el mundo da la vuelta por los bordes).
    fn vecinas(&self, f: usize, c: usize) -> usize {
        let mut n = 0;
        for df in [ALTO - 1, 0, 1] {
            for dc in [ANCHO - 1, 0, 1] {
                if (df, dc) != (0, 0) && self.celdas[(f + df) % ALTO][(c + dc) % ANCHO] {
                    n += 1;
                }
            }
        }
        n
    }

    fn siguiente(&self) -> Mundo {
        let mut celdas = vec![vec![false; ANCHO]; ALTO];
        for (f, fila) in celdas.iter_mut().enumerate() {
            for (c, celda) in fila.iter_mut().enumerate() {
                *celda = matches!((self.celdas[f][c], self.vecinas(f, c)), (true, 2) | (_, 3));
            }
        }
        Mundo { celdas }
    }

    fn dibujar(&self, generacion: u32) {
        // \x1b[H mueve el cursor arriba a la izquierda (redibuja sin parpadeo).
        let mut s = String::from("\x1b[H");
        for fila in &self.celdas {
            for &viva in fila {
                s.push_str(if viva { "██" } else { "  " });
            }
            s.push('\n');
        }
        println!("{s}Generación {generacion}  (Shift+F5 para detener)");
    }
}

fn main() {
    print!("\x1b[2J"); // limpiar la pantalla
    let mut mundo = Mundo::nuevo();
    for generacion in 0..200 {
        mundo.dibujar(generacion);
        mundo = mundo.siguiente();
        thread::sleep(Duration::from_millis(120));
    }
}
