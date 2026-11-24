// Programa de prueba para tests/dap/sesion.py (depurador).
use std::io::BufRead;

fn main() {
    let nombre = String::from("Ana");
    let numeros = vec![1, 2, 3];
    let quizas: Option<i32> = Some(7);
    let mut total: i32 = numeros.iter().sum();
    total += 1; // PUNTO: la prueba se detiene aquí
    let mut linea = String::new();
    if std::env::var("CON_ENTRADA").is_ok() {
        std::io::stdin().lock().read_line(&mut linea).unwrap();
    }
    println!("{nombre} {total} {quizas:?} [{}]", linea.trim());
}
