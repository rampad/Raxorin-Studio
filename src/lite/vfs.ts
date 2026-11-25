// Proyectos de Raxorin Studio Lite guardados en el navegador (IndexedDB).
// Las imágenes se guardan como data URL ("data:image/png;base64,…").

export interface LiteProject {
  id: string;
  name: string;
  /** Archivos por ruta relativa ("src/main.rs"). */
  files: Record<string, string>;
  updated: number;
  /** Ejemplo del que salió (si salió de uno). */
  sample?: string;
}

const DB = "raxorin-studio-lite";
const STORE = "projects";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const listProjects = () => tx<LiteProject[]>("readonly", (s) => s.getAll()).then((ps) => ps.sort((a, b) => b.updated - a.updated));
export const getProject = (id: string) => tx<LiteProject | undefined>("readonly", (s) => s.get(id));
export const saveProject = (p: LiteProject) => tx("readwrite", (s) => s.put({ ...p, updated: Date.now() }));
export const deleteProject = (id: string) => tx("readwrite", (s) => s.delete(id));

export const newProjectId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const isImage = (path: string) => /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(path);
