## Diseñador visual: más controles, opciones y eventos
- **Controles nuevos**:
  - **Botón estándar** (OK, Cancel, Apply…).
  - **Lista** (StandardListView), con su evento *al cambiar la selección*.
  - **Área clicable** (TouchArea): convierte cualquier zona en un botón, con *clic*, *doble clic* y el cursor que elijas.
  - **Temporizador** (Timer): ejecuta un evento cada cierto tiempo. Aparece en la nueva bandeja **Componentes**, debajo del lienzo.
- **Opciones nuevas**:
  - **Texto:** fuente, cursiva, espaciado entre letras, "…" cuando no cabe y contorno.
  - **Panel:** sombra y recortar el contenido.
  - **Botón:** ícono.
  - **Imagen:** colorear (para íconos) y escalado pixelado.
  - **Deslizador:** vertical.
  - **Número:** tamaño del paso.
  - **Ventana:** ícono, siempre encima, sin marco y fuente por defecto.
  - **Todos los controles:** opacidad. **Dentro de los layouts:** tamaños mínimos y máximos.
- **Eventos nuevos**: deslizador *al soltar*, área con desplazamiento *al desplazarse*, más los de la lista, el área clicable y el temporizador.
- Todas las propiedades y eventos del diseñador se comprueban con el compilador de Slint.
- Nuevo ejemplo **Galería de controles** (*Archivo → Ejemplos…*).

## Documentación
- Nueva sección **Ventanas con Slint** en [raxorin.dev](https://raxorin.dev/slint/introduccion/): conectar con Rust, listas y modelos, animaciones y estados, estilos y temas, y la referencia de todos los controles.

## Instalar
- macOS: `.dmg` (Apple Silicon o Intel). Arrastra la app a Aplicaciones.
- Windows: `_x64-setup.exe` o `.msi` (x64), `_arm64-setup.exe` (ARM64)
- Linux: `.AppImage` (se actualiza sola), `.deb` o `.rpm`
