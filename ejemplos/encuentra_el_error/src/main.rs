//! Encuentra el error: este programa calcula mal el promedio de las notas.
//! Úsalo para aprender a depurar con Raxorin Studio.
//!
//! 1. Ejecuta con Ctrl/⌘+F5: el promedio sale 4.62, pero debería ser 5.75.
//! 2. Haz clic a la izquierda del número de la línea `suma += nota;` para poner un
//!    punto de interrupción (o pon el cursor ahí y pulsa F9).
//! 3. Pulsa F5 para depurar. Cuando se detenga, mira `suma`, `i` y `nota` en el panel Variables.
//! 4. Avanza con F10 y observa qué notas se suman. ¿Cuál falta?
//!
//! (Pista al final del archivo.)

fn promedio(notas: &[f64]) -> f64 {
    let mut suma = 0.0;
    for i in 1..notas.len() {
        let nota = notas[i];
        suma += nota;
    }
    suma / notas.len() as f64
}

fn main() {
    let notas = [4.5, 6.0, 7.0, 5.5];
    println!("Notas: {notas:?}");
    println!("Promedio: {:.2}", promedio(&notas));
}

// Pista: en Rust los índices empiezan en 0. ¿Desde dónde empieza el `for`?
// Solución más idiomática: `notas.iter().sum::<f64>() / notas.len() as f64`.
