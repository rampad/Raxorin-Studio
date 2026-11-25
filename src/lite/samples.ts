// El hub de ejemplos en el navegador: el mismo catálogo que la app (ejemplos/index.json en GitHub).
import { lang } from "../i18n/index.ts";
import { isImage } from "./vfs";

const RAW = "https://raw.githubusercontent.com/rampad/Raxorin-Studio/main/ejemplos";

export interface LiteSample {
  id: string;
  name: string;
  description: string;
  category: string;
  level: string;
  icon: string;
  kind: string;
  open: string;
  teaches: string[];
  files: string[];
}

interface Raw {
  id: string; nombre: string; descripcion: string; categoria: string; nivel: string; icono: string; tipo: string;
  abrir: string; aprenderas: string[]; archivos: string[];
  en?: { nombre?: string; descripcion?: string; categoria?: string; nivel?: string; aprenderas?: string[] };
}

export async function loadSamples(): Promise<LiteSample[]> {
  const res = await fetch(`${RAW}/index.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const data = (await res.json()) as { ejemplos: Raw[] };
  return data.ejemplos.map((s) => {
    const en = lang === "en" ? s.en ?? {} : {};
    return {
      id: s.id, icon: s.icono, kind: s.tipo, open: s.abrir, files: s.archivos,
      name: en.nombre ?? s.nombre, description: en.descripcion ?? s.descripcion, category: en.categoria ?? s.categoria,
      level: en.nivel ?? s.nivel, teaches: en.aprenderas ?? s.aprenderas,
    };
  });
}

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Descarga los archivos de un ejemplo (texto, o data URL para las imágenes). */
export async function downloadSample(s: LiteSample): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await Promise.all(
    s.files.map(async (path) => {
      const res = await fetch(`${RAW}/${s.id}/${path.split("/").map(encodeURIComponent).join("/")}`);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      files[path] = isImage(path) ? await dataUrl(await res.blob()) : await res.text();
    }),
  );
  return files;
}
