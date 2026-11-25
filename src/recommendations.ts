// Crates recomendados para principiantes, agrupados por tema, y sugerencias
// según lo que el proyecto ya tiene instalado.

import type { DepKind, Dependency } from "./api";
import { t } from "./i18n/index.ts";

export interface Recommendation {
  name: string;
  /** Para qué sirve, en una frase. */
  why: string;
  features?: string[];
  kind?: DepKind;
  /** Muy usado y fácil de empezar. */
  starter?: boolean;
}

export interface Category {
  id: string;
  title: string;
  icon: string; // codicon
  items: Recommendation[];
}

export const CATEGORIES: Category[] = [
  {
    id: "basics",
    title: t("Esenciales para empezar"),
    icon: "star-full",
    items: [
      { name: "rand", why: t("Números aleatorios: dados, sorteos, juegos."), starter: true },
      { name: "anyhow", why: t("Manejo de errores sencillo en aplicaciones (usa `?` en todas partes)."), starter: true },
      { name: "serde", why: t("Convertir tus structs a JSON, TOML, etc. y viceversa."), features: ["derive"], starter: true },
      { name: "serde_json", why: t("Leer y escribir JSON (junto con serde)."), starter: true },
      { name: "chrono", why: t("Fechas y horas: hoy, diferencias, formatos.") },
      { name: "regex", why: t("Expresiones regulares para buscar patrones en texto.") },
      { name: "itertools", why: t("Herramientas extra para iteradores (agrupar, combinar…).") },
      { name: "thiserror", why: t("Definir tus propios tipos de error en bibliotecas.") },
    ],
  },
  {
    id: "cli",
    title: t("Programas de consola"),
    icon: "terminal",
    items: [
      { name: "clap", why: t("Leer argumentos de la línea de comandos (`mi_app --ayuda`)."), features: ["derive"], starter: true },
      { name: "colored", why: t("Texto de colores en la terminal."), starter: true },
      { name: "dialoguer", why: t("Preguntas interactivas: menús, confirmaciones, contraseñas.") },
      { name: "indicatif", why: t("Barras de progreso y spinners.") },
      { name: "crossterm", why: t("Control total de la terminal: teclas, cursor, colores.") },
      { name: "ratatui", why: t("Interfaces completas en modo texto (paneles, tablas, gráficos).") },
    ],
  },
  {
    id: "gui",
    title: t("Ventanas e interfaces gráficas"),
    icon: "window",
    items: [
      { name: "slint", why: t("Interfaces declarativas tipo XAML/WPF (lo usará el diseñador de Raxorin Studio).") },
      { name: "eframe", why: t("egui: interfaces inmediatas, muy fáciles para herramientas y prototipos.") },
      { name: "rfd", why: t("Diálogos nativos para abrir/guardar archivos.") },
    ],
  },
  {
    id: "web",
    title: t("Internet y web"),
    icon: "globe",
    items: [
      { name: "reqwest", why: t("Hacer peticiones HTTP (descargar páginas, usar APIs)."), features: ["json", "blocking"] },
      { name: "tokio", why: t("Programación asíncrona: base de la mayoría del código de red."), features: ["full"] },
      { name: "axum", why: t("Crear tu propio servidor web o API.") },
      { name: "url", why: t("Analizar y construir URLs correctamente.") },
    ],
  },
  {
    id: "data",
    title: t("Datos y archivos"),
    icon: "database",
    items: [
      { name: "csv", why: t("Leer y escribir archivos CSV (hojas de cálculo).") },
      { name: "toml", why: t("Archivos de configuración .toml.") },
      { name: "rusqlite", why: t("Base de datos SQLite en un solo archivo."), features: ["bundled"] },
      { name: "walkdir", why: t("Recorrer carpetas y subcarpetas.") },
      { name: "directories", why: t("Rutas estándar del sistema (Documentos, configuración…).") },
    ],
  },
  {
    id: "games",
    title: t("Juegos y gráficos"),
    icon: "game",
    items: [
      { name: "macroquad", why: t("Juegos 2D simples con muy poco código."), starter: true },
      { name: "bevy", why: t("Motor de juegos completo (2D y 3D).") },
      { name: "image", why: t("Abrir, editar y guardar imágenes (PNG, JPG…).") },
    ],
  },
  {
    id: "speed",
    title: t("Rendimiento"),
    icon: "rocket",
    items: [
      { name: "rayon", why: t("Usar todos los núcleos del procesador cambiando `iter()` por `par_iter()`.") },
      { name: "dashmap", why: t("HashMap que se puede usar desde varios hilos.") },
    ],
  },
  {
    id: "tests",
    title: t("Pruebas (solo para tests)"),
    icon: "beaker",
    items: [
      { name: "pretty_assertions", why: t("Muestra diferencias claras cuando falla un assert_eq!."), kind: "dev", starter: true },
      { name: "proptest", why: t("Pruebas con muchos datos generados al azar."), kind: "dev" },
      { name: "insta", why: t("Pruebas de “instantánea”: compara la salida con una guardada."), kind: "dev" },
      { name: "criterion", why: t("Medir la velocidad de tu código (benchmarks)."), kind: "dev" },
    ],
  },
];

const norm = (n: string) => n.replace(/-/g, "_");

/** Sugerencias según lo instalado: “si usas X, seguramente te sirve Y”. */
export function contextual(deps: Dependency[], projectKind: "bin" | "lib"): (Recommendation & { because: string })[] {
  const has = (n: string) => deps.some((d) => norm(d.name) === norm(n));
  const out: (Recommendation & { because: string })[] = [];
  const add = (cond: boolean, r: Recommendation, because: string) => {
    if (cond && !has(r.name) && !out.some((o) => o.name === r.name)) out.push({ ...r, because });
  };
  add(has("serde"), { name: "serde_json", why: t("Guardar y leer tus structs como JSON.") }, "Usas serde");
  add(has("tokio"), { name: "reqwest", why: t("Cliente HTTP asíncrono para tokio."), features: ["json"] }, "Usas tokio");
  add(has("reqwest"), { name: "tokio", why: t("reqwest (asíncrono) necesita un runtime."), features: ["full"] }, "Usas reqwest");
  add(has("reqwest") || has("axum"), { name: "serde", why: t("Convertir las respuestas JSON en structs."), features: ["derive"] }, t("Trabajas con la web"));
  add(has("axum"), { name: "tokio", why: "axum funciona sobre tokio.", features: ["full"] }, "Usas axum");
  add(has("clap"), { name: "anyhow", why: t("Errores fáciles de mostrar en programas de consola.") }, "Usas clap");
  add(has("chrono") && has("serde"), { name: "chrono", why: t("Activa la feature `serde` de chrono para guardar fechas."), features: ["serde"] }, t("Usas chrono y serde"));
  add(has("csv"), { name: "serde", why: t("Leer cada fila del CSV directamente como struct."), features: ["derive"] }, "Usas csv");
  add(has("slint"), { name: "slint-build", why: t("Compila los archivos .slint en build.rs."), kind: "build" }, "Usas slint");
  add(has("ratatui"), { name: "crossterm", why: t("El backend de terminal más usado con ratatui.") }, "Usas ratatui");
  add(projectKind === "bin" && deps.length > 0, { name: "anyhow", why: t("Simplifica el manejo de errores en `main`.") }, t("Es una aplicación"));
  add(projectKind === "lib", { name: "thiserror", why: t("Errores propios y claros para quien use tu biblioteca.") }, t("Es una biblioteca"));
  add(!deps.some((d) => d.kind === "dev"), { name: "pretty_assertions", why: t("Fallos de tests más legibles."), kind: "dev" }, t("Aún no tienes dependencias de prueba"));
  return out;
}
