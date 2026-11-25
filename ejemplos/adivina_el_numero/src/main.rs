//! Adivina el número: el programa piensa un número del 1 al 100 y tú lo adivinas.
//!
//! Aprenderás: leer lo que escribe el usuario, `loop`, `match` y convertir texto a número.

use std::cmp::Ordering;
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

/// Un número "al azar" del 1 al 100 a partir de la hora (sin paquetes externos).
/// Para algo serio usa el paquete `rand` (Proyecto → Administrar paquetes).
fn numero_al_azar() -> u32 {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos();
    nanos % 100 + 1
}

fn main() {
    println!("🎯 Adivina el número (del 1 al 100)");
    let secreto = numero_al_azar();
    let mut intentos = 0;

    loop {
        print!("Tu número: ");
        io::stdout().flush().unwrap();

        let mut linea = String::new();
        if io::stdin().read_line(&mut linea).unwrap() == 0 {
            break; // Se cerró la entrada.
        }

        // `parse` devuelve un Result: Ok(número) o Err si no es un número.
        let numero: u32 = match linea.trim().parse() {
            Ok(n) => n,
            Err(_) => {
                println!("Eso no es un número. Prueba otra vez.");
                continue;
            }
        };
        intentos += 1;

        match numero.cmp(&secreto) {
            Ordering::Less => println!("Más alto ⬆"),
            Ordering::Greater => println!("Más bajo ⬇"),
            Ordering::Equal => {
                println!("🎉 ¡Correcto! Lo adivinaste en {intentos} intentos.");
                break;
            }
        }
    }
}
