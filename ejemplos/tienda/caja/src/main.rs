//! Caja: el programa de la solución "Tienda". Usa la biblioteca `inventario`.
//!
//! Es el proyecto de inicio (en negrita en el Explorador): F5 / Ctrl+F5 ejecutan este.
//! Escribe por ejemplo `pan 3`, `lista` o `fin`.

use std::io::{self, Write};

use inventario::{Inventario, dinero};

fn main() {
    let mut inv = Inventario::default();
    inv.agregar("Pan", 150, 20);
    inv.agregar("Leche", 990, 6);
    inv.agregar("Café", 4500, 3);

    println!("🛒 Caja de la tienda. Escribe «producto cantidad», «lista» o «fin».");
    let mut total = 0;
    loop {
        print!("> ");
        io::stdout().flush().unwrap();
        let mut linea = String::new();
        if io::stdin().read_line(&mut linea).unwrap() == 0 {
            break;
        }
        let partes: Vec<&str> = linea.split_whitespace().collect();
        match partes.as_slice() {
            [] => continue,
            ["fin"] => break,
            ["lista"] => {
                for p in inv.productos() {
                    println!("  {:<8} {:>9}  ({} en stock)", p.nombre, dinero(p.precio), p.stock);
                }
            }
            [producto, cantidad] => match cantidad.parse() {
                Ok(n) => match inv.vender(producto, n) {
                    Ok(importe) => {
                        total += importe;
                        println!("  ✔ {n} × {producto} = {}   (total: {})", dinero(importe), dinero(total));
                    }
                    Err(e) => println!("  ✖ No se pudo: {e}"),
                },
                Err(_) => println!("  La cantidad debe ser un número."),
            },
            _ => println!("  Escribe «producto cantidad», por ejemplo: pan 2"),
        }
    }
    println!("Total a pagar: {}", dinero(total));
}
