// Evita una consola extra en Windows en modo release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `raxorin-studio --mcp`: servidor MCP por stdio, sin abrir la ventana (ver src/mcp.rs).
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--mcp") {
        std::process::exit(raxorin_studio_lib::mcp::run_stdio(&args));
    }
    raxorin_studio_lib::run()
}
