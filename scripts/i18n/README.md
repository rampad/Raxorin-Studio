# Traducciones de Raxorin Studio

La interfaz está en español e inglés. **El texto en español es la clave**: `t("Guardar")` devuelve `"Save"` en
inglés. Así el código sigue siendo legible y lo que falte por traducir se ve en español.

| Archivo | Qué es |
|---|---|
| `src/i18n/index.ts` | `t()`, `tb()` (mensajes del backend), `tErr()` (errores), idioma activo y preferencia |
| `src/i18n/en.ts` | Traducciones de la interfaz |
| `src/i18n/backend-en.ts` | Traducciones de los mensajes de Rust (`src-tauri`), con `{0}`, `{1}`… para los valores variables |

## Al escribir código nuevo

- Textos de la interfaz: `t("Texto")`, y con valores `t("Abriendo {0}…", ruta)`. No armes frases sumando trozos:
  el orden de las palabras cambia entre idiomas.
- Errores de comandos del backend: `tErr(e)` en lugar de `String(e)`.
- Mensajes en Rust: se escriben en español y se traducen al mostrarlos; agrega su plantilla a `backend-en.ts`.
- Textos iniciales de controles del diseñador (que van al `.slint`): `lit("Texto")` en `src/designer/widgets.ts`.

## Herramientas

```sh
node scripts/i18n/extraer.mjs           # cuántos textos hay y cuántos faltan traducir
node scripts/i18n/extraer.mjs --faltan  # los que faltan (JSON)
node scripts/i18n/extraer.mjs --check   # falla si falta alguno (lo ejecuta npm test)
node scripts/i18n/envolver.mjs          # textos en español sin t() (con --escribir, los envuelve)
node scripts/i18n/pendientes.mjs        # textos con tildes que siguen sin t(), para revisar a mano
```

Los scripts de Node usan el español; con `RAXORIN_LANG=en` usan el inglés (por ejemplo, para generar la referencia de
controles de la documentación en inglés).

## Notas de versión

`NOVEDADES.md` lleva primero el español y, después de una línea `<!-- English -->`, el inglés. El aviso de
actualización muestra la parte del idioma de la interfaz.
