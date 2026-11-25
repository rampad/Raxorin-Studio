fn main() {
    embed_samples();
    tauri_build::build()
}

/// Incluye en la app los ejemplos del hub (solo los archivos que lista ejemplos/index.json,
/// nunca las carpetas target/ de compilarlos): genera $OUT_DIR/ejemplos.rs con
/// `static EJEMPLOS: &[(&str, &[u8])] = &[("id/ruta", include_bytes!(…)), …];`
fn embed_samples() {
    use std::path::Path;
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ejemplos").canonicalize().expect("falta la carpeta ejemplos/");
    let index_path = base.join("index.json");
    println!("cargo:rerun-if-changed={}", index_path.display());
    let index: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&index_path).expect("falta ejemplos/index.json")).expect("ejemplos/index.json no es JSON");
    let mut code = String::from("static EJEMPLOS: &[(&str, &[u8])] = &[\n");
    let mut add = |rel: String| {
        let path = base.join(&rel);
        assert!(path.is_file(), "ejemplos/index.json menciona {rel}, que no existe");
        println!("cargo:rerun-if-changed={}", path.display());
        code.push_str(&format!("    ({rel:?}, include_bytes!({:?})),\n", path.display().to_string()));
    };
    add("index.json".into());
    for e in index["ejemplos"].as_array().expect("ejemplos/index.json: falta \"ejemplos\"") {
        let id = e["id"].as_str().unwrap();
        for f in e["archivos"].as_array().unwrap() {
            add(format!("{id}/{}", f.as_str().unwrap()));
        }
    }
    code.push_str("];\n");
    std::fs::write(Path::new(&std::env::var("OUT_DIR").unwrap()).join("ejemplos.rs"), code).unwrap();
}
