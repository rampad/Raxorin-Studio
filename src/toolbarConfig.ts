// Configuración de la barra de herramientas: qué controles se muestran y en qué orden.

import { useSyncExternalStore } from "react";
import { t } from "./i18n/index.ts";

export type ToolId =
  | "new"
  | "open"
  | "openSolution"
  | "save"
  | "saveAll"
  | "format"
  | "packages"
  | "startup"
  | "config"
  | "publish"
  | "build"
  | "check"
  | "test"
  | "debug"
  | "run"
  | "stop"
  | "diag"
  | "theme"
  | "sidebar"
  | "bottom";

export interface ToolDef {
  icon: string;
  /** Texto del botón (si la barra muestra textos). */
  label?: string;
  /** Nombre en el diálogo de personalización. */
  name: string;
  desc: string;
}

export const TOOLS: Record<ToolId, ToolDef> = {
  new: { icon: "new-file", label: t("Nuevo"), name: t("Nuevo proyecto"), desc: t("Crear un proyecto o una solución") },
  open: { icon: "folder-opened", label: t("Abrir"), name: t("Abrir carpeta"), desc: t("Abrir una carpeta con proyectos de Rust") },
  openSolution: { icon: "layers", name: t("Abrir solución"), desc: t("Abrir un archivo .rxsln") },
  save: { icon: "save", name: t("Guardar"), desc: t("Guardar el archivo actual (Ctrl/⌘+S)") },
  saveAll: { icon: "save-all", name: t("Guardar todo"), desc: t("Guardar todos los archivos abiertos") },
  format: { icon: "wand", name: t("Formatear"), desc: t("Formatear el documento con rustfmt") },
  packages: { icon: "package", label: t("Paquetes"), name: t("Paquetes"), desc: t("Administrar los crates del proyecto") },
  startup: { icon: "rocket", name: t("Proyecto de inicio"), desc: t("Elegir qué proyecto se compila y ejecuta") },
  config: { icon: "settings", name: "Debug / Release", desc: t("Compilar rápido para probar o optimizado para entregar") },
  publish: { icon: "package", label: t("Publicar"), name: t("Publicar"), desc: t("Compilar en Release y dejar el ejecutable listo para compartir") },
  build: { icon: "tools", label: t("Compilar"), name: t("Compilar"), desc: t("cargo build (Ctrl/⌘+Shift+B)") },
  check: { icon: "check-all", label: t("Revisar"), name: t("Revisar"), desc: t("Revisar el código con Clippy") },
  test: { icon: "beaker", label: t("Probar"), name: t("Probar"), desc: t("Ejecutar las pruebas (cargo test)") },
  debug: { icon: "debug-start", label: t("Depurar"), name: t("Depurar"), desc: t("Iniciar la depuración (F5)") },
  run: { icon: "play-circle", label: t("Sin depurar"), name: t("Ejecutar sin depurar"), desc: t("Ejecutar el programa (Ctrl/⌘+F5)") },
  stop: { icon: "debug-stop", label: t("Detener"), name: t("Detener"), desc: t("Detener la compilación o el programa (Shift+F5)") },
  diag: { icon: "pulse", name: t("Diagnóstico"), desc: t("Gráficas de CPU y memoria del programa") },
  theme: { icon: "color-mode", name: t("Tema claro/oscuro"), desc: t("Cambiar entre el tema claro y el oscuro") },
  sidebar: { icon: "layout-sidebar-left", name: t("Explorador"), desc: t("Mostrar u ocultar el explorador (Ctrl/⌘+B)") },
  bottom: { icon: "layout-panel", name: t("Panel inferior"), desc: t("Mostrar u ocultar la salida y errores (Ctrl/⌘+J)") },
};

/** Un control o un separador ("|" seguido de un número). */
export interface ToolItem {
  id: ToolId | `|${number}`;
  on: boolean;
}

export interface ToolbarConfig {
  items: ToolItem[];
  /** Mostrar el texto junto al ícono en los botones que lo tienen. */
  labels: boolean;
}

export const isSep = (id: ToolItem["id"]): id is `|${number}` => id.startsWith("|");

const DEFAULT_ORDER: (ToolId | "|")[] = [
  "new", "open", "openSolution", "save", "format", "packages", "|",
  "startup", "config", "build", "check", "test", "debug", "run", "stop", "|",
  "diag",
];

export function defaultConfig(): ToolbarConfig {
  let n = 0;
  const items: ToolItem[] = DEFAULT_ORDER.map((id) => (id === "|" ? { id: `|${++n}` as const, on: true } : { id, on: true }));
  // Los controles opcionales quedan disponibles, pero ocultos.
  for (const id of Object.keys(TOOLS) as ToolId[]) if (!items.some((i) => i.id === id)) items.push({ id, on: false });
  return { items, labels: true };
}

const KEY = "raxorinstudio.toolbar";

/** Completa una configuración guardada con los controles nuevos y quita los que ya no existen. */
export function normalize(raw: unknown): ToolbarConfig {
  const def = defaultConfig();
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as ToolbarConfig).items)) return def;
  const r = raw as ToolbarConfig;
  const seen = new Set<string>();
  const items = r.items.filter(
    (i) => i && typeof i.id === "string" && (isSep(i.id) || i.id in TOOLS) && !seen.has(i.id) && seen.add(i.id),
  );
  for (const d of def.items) if (!isSep(d.id) && !seen.has(d.id)) items.push({ id: d.id, on: false });
  return { items: items.map((i) => ({ id: i.id, on: !!i.on })), labels: r.labels !== false };
}

function read(): ToolbarConfig {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return defaultConfig();
  }
}

let config = read();
const listeners = new Set<() => void>();

export function setToolbarConfig(c: ToolbarConfig) {
  config = normalize(c);
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    /* sin almacenamiento */
  }
  listeners.forEach((l) => l());
}

export const resetToolbarConfig = () => setToolbarConfig(defaultConfig());

export function useToolbarConfig() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => config,
  );
}

/** Siguiente id libre para un separador. */
export function newSepId(items: ToolItem[]): `|${number}` {
  let n = 1;
  while (items.some((i) => i.id === `|${n}`)) n++;
  return `|${n}`;
}
