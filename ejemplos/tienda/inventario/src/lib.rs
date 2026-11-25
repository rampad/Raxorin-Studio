//! Inventario: la biblioteca de la solución "Tienda". La usa el proyecto `caja`.
//!
//! Así se separa el código reutilizable (aquí) del programa que lo usa (caja).
//! `caja` la tiene como referencia en su Cargo.toml: `inventario = { path = "../inventario" }`
//! (en Raxorin Studio: clic derecho sobre un proyecto → Agregar referencia a proyecto…).

use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct Producto {
    pub nombre: String,
    /// Precio en centavos: con enteros no hay errores de redondeo.
    pub precio: u64,
    pub stock: u32,
}

#[derive(Debug, PartialEq)]
pub enum ErrorVenta {
    NoExiste(String),
    SinStock { producto: String, quedan: u32 },
}

impl fmt::Display for ErrorVenta {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ErrorVenta::NoExiste(p) => write!(f, "no tenemos «{p}»"),
            ErrorVenta::SinStock { producto, quedan } => write!(f, "solo quedan {quedan} de «{producto}»"),
        }
    }
}

#[derive(Default)]
pub struct Inventario {
    productos: BTreeMap<String, Producto>,
}

impl Inventario {
    pub fn agregar(&mut self, nombre: &str, precio: u64, stock: u32) {
        self.productos.insert(nombre.to_lowercase(), Producto { nombre: nombre.into(), precio, stock });
    }

    pub fn productos(&self) -> impl Iterator<Item = &Producto> {
        self.productos.values()
    }

    /// Descuenta del stock y devuelve el importe, o un error si no se puede vender.
    pub fn vender(&mut self, nombre: &str, cantidad: u32) -> Result<u64, ErrorVenta> {
        let p = self.productos.get_mut(&nombre.to_lowercase()).ok_or_else(|| ErrorVenta::NoExiste(nombre.into()))?;
        if p.stock < cantidad {
            return Err(ErrorVenta::SinStock { producto: p.nombre.clone(), quedan: p.stock });
        }
        p.stock -= cantidad;
        Ok(p.precio * cantidad as u64)
    }
}

/// 1250 → "$12.50"
pub fn dinero(centavos: u64) -> String {
    format!("${}.{:02}", centavos / 100, centavos % 100)
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn vende_y_descuenta() {
        let mut inv = Inventario::default();
        inv.agregar("Pan", 150, 10);
        assert_eq!(inv.vender("pan", 4), Ok(600));
        assert_eq!(inv.vender("Pan", 7), Err(ErrorVenta::SinStock { producto: "Pan".into(), quedan: 6 }));
        assert_eq!(inv.vender("Leche", 1), Err(ErrorVenta::NoExiste("Leche".into())));
        assert_eq!(dinero(1250), "$12.50");
    }
}
