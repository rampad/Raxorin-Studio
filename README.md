<p align="center">
  <img src="src/assets/brand/raxorin-mark.svg" width="120" alt="Raxorin Studio" />
</p>

# Raxorin Studio

IDE para crear programas en Rust de forma fácil, inspirada en Visual Studio.

**Stack:** Tauri 2 (backend Rust) · React + TypeScript · Monaco Editor · cargo · rust-analyzer (LSP) · lldb-dap (DAP)

## Ejecutar en desarrollo

```bash
npm install
npm run tauri dev
```

## Pruebas

```bash
npm test                                 # parser/generador del diseñador (.slint)
cd src-tauri && cargo test               # backend
```

## Instalar

Descarga el instalador de la página de [Releases](https://github.com/rampad/Raxorin-Studio/releases):

| Sistema | Archivo |
|---|---|
| macOS (Apple Silicon / Intel) | `.dmg` |
| Windows | `.msi` o `-setup.exe` |
| Linux | `.deb`, `.rpm` o `.AppImage` |

Requisito: tener Rust instalado ([rustup.rs](https://rustup.rs)). Raxorin Studio ofrece
instalar rust-analyzer, clippy y rustfmt si faltan.

Los archivos de solución `.rxsln` quedan asociados a Raxorin Studio: doble clic para abrirlos.

> macOS: como la app aún no está firmada con un certificado de Apple, la primera vez
> ábrela con clic derecho → **Abrir** (o en *Configuración → Privacidad y seguridad → Abrir de todos modos*).

## Generar instaladores

**En tu máquina** (genera el instalador de tu sistema operativo):

```bash
npm run tauri build
# macOS:   src-tauri/target/release/bundle/dmg/*.dmg
# Windows: src-tauri/target/release/bundle/msi/*.msi
```

**Para todos los sistemas a la vez** (GitHub Actions, `.github/workflows/instaladores.yml`):

```bash
# 1. Sube la versión en package.json y src-tauri/tauri.conf.json (p. ej. 0.2.0)
git tag v0.2.0
git push origin v0.2.0
```

Se crea un borrador de Release con los instaladores de macOS, Windows y Linux;
revísalo y publícalo desde GitHub. También se puede lanzar a mano desde la pestaña *Actions*.

## Atajos

| Tecla | Acción |
|---|---|
| F5 | Depurar (o continuar si está detenido) |
| Ctrl/⌘+F5 | Ejecutar sin depurar |
| Shift+F5 | Detener |
| Ctrl/⌘+Shift+F5 | Reiniciar la depuración |
| F9 | Poner/quitar punto de interrupción |
| F10 / F11 / Shift+F11 | Paso por procedimientos / por instrucciones / salir |
| F6 | Pausar |
| Ctrl/⌘+Shift+B | Compilar |
| Ctrl/⌘+S | Guardar |
| F12 / Ctrl/⌘+clic | Ir a definición |
| Shift+F12 | Buscar referencias |
| F2 | Renombrar |
| Ctrl/⌘+. | Acciones rápidas (importar, corregir) |
| Shift+Alt+F | Formatear (rustfmt) |

## Estructura

```
src/                    Frontend (React)
  App.tsx               Estado principal, atajos, integración con Monaco
  api.ts                Llamadas al backend (invoke)
  lsp/client.ts         Cliente LSP: JSON-RPC, sincronización de documentos, diagnósticos
  lsp/providers.ts      Autocompletado, hover, definición, renombrar, etc. → Monaco
  designer/             Diseñador visual de Slint: parser/generador .slint, lienzo, propiedades
  debug/                Depurador: cliente DAP, puntos de interrupción, sesión, paneles
  components/           Toolbar, Explorer, EditorArea, BottomPanel, diálogos
src-tauri/src/          Backend (Rust)
  fs_cmds.rs            Archivos y creación de proyectos (cargo new)
  runner.rs             Compilar / ejecutar / detener, errores de cargo en JSON, stdin
  lsp.rs                Transporte stdio con rust-analyzer
  toolchain.rs          Detectar e instalar rust-analyzer, clippy, rustfmt
  crates.rs             Gestor de paquetes (API de crates.io + cargo add/remove/metadata)
  dap.rs                Transporte con lldb-dap y entrada del programa depurado (FIFO)
```

## Hoja de ruta

- [x] **Fase 1**: proyectos de consola, editor, compilar/ejecutar, lista de errores, stdin
- [x] **Fase 2**: rust-analyzer (autocompletado, ir a definición), cargo fmt/clippy, gestor de crates
- [x] **Fase 3**: diseñador visual drag & drop con Slint (`.slint` ↔ diseñador, eventos → `main.rs`)
- [x] **Fase 4**: depurador (lldb-dap): puntos de interrupción, paso a paso, variables, pila, inspección, pánicos
- [x] Soluciones `.rxsln` (varios proyectos en cualquier carpeta)
- [x] Instaladores para macOS, Windows y Linux, con asociación de archivos `.rxsln`
- [ ] Próximo: temas, paneles redimensionables, firma de código, depuración en Windows

## Créditos

- Íconos de la interfaz: [Codicons](https://github.com/microsoft/vscode-codicons) de Microsoft — licencia CC BY 4.0.
- Íconos de archivos y carpetas: [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) — licencia MIT (ver `src/assets/file-icons/LICENSE-material-icon-theme`).
