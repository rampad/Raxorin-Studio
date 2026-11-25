//! Contador de palabras: lee un texto y muestra las palabras que más se repiten.
//!
//! Aprenderás: `HashMap`, iteradores, ordenar, `Option` y argumentos del programa.
//!
//! Sin argumentos usa el texto de ejemplo de abajo. Para contar un archivo, desde la
//! terminal: `cargo run -- mi_texto.txt`. Las pruebas de abajo se ejecutan con Pruebas.

use std::collections::HashMap;

const EJEMPLO: &str = "En un lugar de la Mancha, de cuyo nombre no quiero acordarme, \
no ha mucho tiempo que vivía un hidalgo de los de lanza en astillero, adarga antigua, \
rocín flaco y galgo corredor. Una olla de algo más vaca que carnero, salpicón las más \
noches, duelos y quebrantos los sábados, lentejas los viernes, algún palomino de \
añadidura los domingos, consumían las tres partes de su hacienda.";

/// Cuenta cuántas veces aparece cada palabra (sin distinguir mayúsculas).
fn contar(texto: &str) -> HashMap<String, usize> {
    let mut cuentas = HashMap::new();
    for palabra in texto.split(|c: char| !c.is_alphanumeric()).filter(|p| !p.is_empty()) {
        *cuentas.entry(palabra.to_lowercase()).or_insert(0) += 1;
    }
    cuentas
}

/// Las `n` palabras más frecuentes, de mayor a menor (en empate, por orden alfabético).
fn mas_frecuentes(cuentas: &HashMap<String, usize>, n: usize) -> Vec<(&str, usize)> {
    let mut lista: Vec<(&str, usize)> = cuentas.iter().map(|(p, c)| (p.as_str(), *c)).collect();
    lista.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    lista.truncate(n);
    lista
}

fn main() {
    let texto = match std::env::args().nth(1) {
        Some(ruta) => match std::fs::read_to_string(&ruta) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("No se pudo leer {ruta}: {e}");
                std::process::exit(1);
            }
        },
        None => EJEMPLO.to_string(),
    };

    let cuentas = contar(&texto);
    let total: usize = cuentas.values().sum();
    println!("{total} palabras, {} distintas.\n", cuentas.len());
    println!("Las más frecuentes:");
    for (palabra, veces) in mas_frecuentes(&cuentas, 10) {
        println!("  {palabra:<12} {veces:>3}  {}", "█".repeat(veces));
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn cuenta_sin_distinguir_mayusculas() {
        let c = contar("Hola hola, HOLA mundo");
        assert_eq!(c["hola"], 3);
        assert_eq!(c["mundo"], 1);
    }

    #[test]
    fn ordena_por_frecuencia() {
        let c = contar("b a b c b a");
        assert_eq!(mas_frecuentes(&c, 2), vec![("b", 3), ("a", 2)]);
    }
}
