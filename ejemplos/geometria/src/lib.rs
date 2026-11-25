//! Geometría: una biblioteca con figuras, un `trait` y pruebas.
//!
//! Aprenderás: `trait`, implementarlo para varios tipos, `Box<dyn Trait>`, documentación
//! y pruebas unitarias. Ejecuta las pruebas con el botón Pruebas (o Compilar → Ejecutar pruebas).
//! Una biblioteca no se "ejecuta": la usan otros proyectos (mira el ejemplo "Tienda").

use std::f64::consts::PI;

/// Lo que tienen en común todas las figuras.
pub trait Figura {
    fn nombre(&self) -> &str;
    fn area(&self) -> f64;
    fn perimetro(&self) -> f64;

    /// Método con una implementación por defecto: las figuras no necesitan escribirlo.
    fn describir(&self) -> String {
        format!("{}: área {:.2}, perímetro {:.2}", self.nombre(), self.area(), self.perimetro())
    }
}

pub struct Circulo {
    pub radio: f64,
}

pub struct Rectangulo {
    pub ancho: f64,
    pub alto: f64,
}

pub struct Triangulo {
    pub a: f64,
    pub b: f64,
    pub c: f64,
}

impl Figura for Circulo {
    fn nombre(&self) -> &str { "Círculo" }
    fn area(&self) -> f64 { PI * self.radio * self.radio }
    fn perimetro(&self) -> f64 { 2.0 * PI * self.radio }
}

impl Figura for Rectangulo {
    fn nombre(&self) -> &str { if self.ancho == self.alto { "Cuadrado" } else { "Rectángulo" } }
    fn area(&self) -> f64 { self.ancho * self.alto }
    fn perimetro(&self) -> f64 { 2.0 * (self.ancho + self.alto) }
}

impl Triangulo {
    /// Solo crea el triángulo si los lados pueden formar uno (devuelve `None` si no).
    pub fn nuevo(a: f64, b: f64, c: f64) -> Option<Self> {
        (a + b > c && a + c > b && b + c > a).then_some(Triangulo { a, b, c })
    }
}

impl Figura for Triangulo {
    fn nombre(&self) -> &str { "Triángulo" }
    /// Fórmula de Herón.
    fn area(&self) -> f64 {
        let s = self.perimetro() / 2.0;
        (s * (s - self.a) * (s - self.b) * (s - self.c)).sqrt()
    }
    fn perimetro(&self) -> f64 { self.a + self.b + self.c }
}

/// Suma el área de figuras de cualquier tipo.
pub fn area_total(figuras: &[Box<dyn Figura>]) -> f64 {
    figuras.iter().map(|f| f.area()).sum()
}

#[cfg(test)]
mod pruebas {
    use super::*;

    fn casi_igual(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn rectangulo_y_cuadrado() {
        let r = Rectangulo { ancho: 3.0, alto: 4.0 };
        assert_eq!(r.area(), 12.0);
        assert_eq!(r.perimetro(), 14.0);
        assert_eq!(Rectangulo { ancho: 2.0, alto: 2.0 }.nombre(), "Cuadrado");
    }

    #[test]
    fn circulo() {
        assert!(casi_igual(Circulo { radio: 1.0 }.area(), PI));
    }

    #[test]
    fn triangulo_valido_e_invalido() {
        let t = Triangulo::nuevo(3.0, 4.0, 5.0).expect("3-4-5 es un triángulo");
        assert!(casi_igual(t.area(), 6.0));
        assert!(Triangulo::nuevo(1.0, 2.0, 10.0).is_none());
    }

    #[test]
    fn suma_de_areas() {
        let figuras: Vec<Box<dyn Figura>> = vec![
            Box::new(Rectangulo { ancho: 2.0, alto: 3.0 }),
            Box::new(Triangulo::nuevo(3.0, 4.0, 5.0).unwrap()),
        ];
        assert!(casi_igual(area_total(&figuras), 12.0));
        assert_eq!(figuras[0].describir(), "Rectángulo: área 6.00, perímetro 10.00");
    }
}
