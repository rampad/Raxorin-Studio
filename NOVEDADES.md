## Windows en procesadores ARM
- **Nuevo instalador para Windows ARM64**: Surface, equipos Snapdragon y máquinas virtuales en un Mac con Apple Silicon (`_arm64-setup.exe`).
- **Herramientas necesarias** detecta para qué arquitectura compila Rust y comprueba el enlazador de C++ correcto. En Windows ARM faltaban las herramientas de C++ para ARM64 y aparecía `linker 'link.exe' not found`; ahora lo detecta y **Reparar** las agrega.
- **Reparar** usa el Instalador de Visual Studio que ya está en la máquina, que es más fiable para completar una instalación existente.
- **Depurar en Windows ARM**: el programa se compila en x64 al depurar, porque el depurador (CodeLLDB) solo existe para x64. Ejecutar y Publicar siguen siendo nativos ARM64.

## Instalar
- macOS: `.dmg` (Apple Silicon o Intel)
- Windows: `-setup.exe` o `.msi` (x64), `_arm64-setup.exe` (ARM64)
- Linux: `.AppImage` (se actualiza sola), `.deb` o `.rpm`
