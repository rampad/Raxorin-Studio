// Compila el catálogo generado: si una propiedad o un evento del diseñador no existe en Slint, falla.
fn main() {
    slint_build::compile("ui/catalogo.slint").expect("El catálogo del diseñador tiene propiedades o eventos que Slint no reconoce");
}
