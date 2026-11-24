# 🦀 Rust Studio

IDE para crear programas en Rust de forma fácil, inspirada en Visual Studio.

**Stack:** Tauri 2 (backend Rust) · React + TypeScript · Monaco Editor · cargo

## Ejecutar en desarrollo

```bash
npm install
npm run tauri dev
```

## Generar instalador

```bash
npm run tauri build
```

## Atajos

| Tecla | Acción |
|---|---|
| F5 | Ejecutar |
| Shift+F5 | Detener |
| Ctrl/⌘+Shift+B | Compilar |
| Ctrl/⌘+S | Guardar |

## Estructura

```
src/                    Frontend (React)
  App.tsx               Estado principal, atajos, integración con Monaco
  api.ts                Llamadas al backend (invoke)
  components/           Toolbar, Explorer, EditorArea, BottomPanel, NewProjectDialog
src-tauri/src/          Backend (Rust)
  fs_cmds.rs            Archivos y creación de proyectos (cargo new)
  runner.rs             Compilar / ejecutar / detener, errores de cargo en JSON, stdin
```

## Hoja de ruta

- [x] **Fase 1**: proyectos de consola, editor, compilar/ejecutar, lista de errores, stdin
- [ ] **Fase 2**: rust-analyzer (autocompletado, ir a definición), cargo fmt/clippy, gestor de crates
- [ ] **Fase 3**: diseñador visual drag & drop con Slint
- [ ] **Fase 4**: depurador (DAP + CodeLLDB), temas, instaladores
