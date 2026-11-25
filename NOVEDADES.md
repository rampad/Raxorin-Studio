## macOS
- **Se corrige «Raxorin Studio está dañado y no se puede abrir»** al descargar la app desde el navegador. La firma de la app no cubría todo el paquete y macOS la trataba como dañada. Ahora la primera vez macOS solo avisa que no puede verificarla: **Configuración del Sistema → Privacidad y seguridad → Abrir de todos modos**.
- Si abres la app directamente desde el instalador (.dmg), ofrece **moverse a Aplicaciones**. Desde el .dmg no aparece en Aplicaciones ni en Launchpad, y tampoco se puede actualizar ni desinstalar.
- La ventana del instalador indica con una flecha que hay que arrastrar la app a Aplicaciones.

## Diseñador
- Los controles **Imagen** muestran la imagen real, por ejemplo los logos e íconos importados de Figma, en lugar de un recuadro con la ruta. Si falta el archivo, lo avisa.

## Instalar
- macOS: `.dmg` (Apple Silicon o Intel). Arrastra la app a Aplicaciones.
- Windows: `_x64-setup.exe` o `.msi` (x64), `_arm64-setup.exe` (ARM64)
- Linux: `.AppImage` (se actualiza sola), `.deb` o `.rpm`
