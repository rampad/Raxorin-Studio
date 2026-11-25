// El proyecto abierto en Raxorin Studio Lite: sus archivos en memoria, guardados en IndexedDB
// (con una pausa) y vistos por el editor con rutas absolutas "/<proyecto>/<ruta>".
import { saveProject, type LiteProject } from "./vfs";

let project: LiteProject | null = null;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;

export const getProject = () => project;
export const getVersion = () => version;
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

export function setProject(p: LiteProject | null) {
  flush();
  project = p;
  notify();
}

/** Guarda ya lo pendiente (al cambiar de proyecto o cerrar la pestaña). */
export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (project) void saveProject(project);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (project) void saveProject(project);
  }, 600);
}

export const absPath = (rel: string) => `/${project?.name ?? "proyecto"}/${rel}`;
export function relPath(abs: string): string | null {
  const prefix = `/${project?.name ?? "proyecto"}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
}

export function readFile(rel: string): string | undefined {
  return project?.files[rel];
}

export function writeFile(rel: string, content: string) {
  if (!project || project.files[rel] === content) return;
  project = { ...project, files: { ...project.files, [rel]: content } };
  scheduleSave();
  notify();
}

export function setStdin(stdin: string) {
  if (!project || project.stdin === stdin) return;
  project = { ...project, stdin };
  scheduleSave();
  notify();
}

export function deleteFile(rel: string) {
  if (!project || !(rel in project.files)) return;
  const files = { ...project.files };
  delete files[rel];
  project = { ...project, files };
  scheduleSave();
  notify();
}

if (typeof window !== "undefined") window.addEventListener("beforeunload", flush);
