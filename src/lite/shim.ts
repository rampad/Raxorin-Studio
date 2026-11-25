// En el navegador no hay backend de Tauri: este reemplazo atiende las pocas llamadas que hacen los
// componentes del IDE que Lite reutiliza (leer y escribir archivos del proyecto, imágenes, abrir
// enlaces) y responde a las demás con un mensaje claro.
import { t } from "../i18n/index.ts";
import { readFile, relPath, writeFile } from "./store";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp" };

function rel(path: unknown): string {
  const r = typeof path === "string" ? relPath(path) : null;
  if (r === null) throw new Error(t("Ruta fuera del proyecto: {0}", String(path)));
  return r;
}

async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case "read_file": {
      const content = readFile(rel(args.path));
      if (content === undefined) throw new Error(t("No existe {0}", String(args.path)));
      return content;
    }
    case "write_file":
      writeFile(rel(args.path), String(args.contents ?? ""));
      return null;
    case "write_file_base64": {
      const r = rel(args.path);
      const ext = r.split(".").pop()?.toLowerCase() ?? "";
      writeFile(r, `data:${MIME[ext] ?? "application/octet-stream"};base64,${args.base64}`);
      return null;
    }
    case "read_image_data_url": {
      const content = readFile(rel(args.path));
      if (!content?.startsWith("data:")) throw new Error(t("No existe {0}", String(args.path)));
      return content;
    }
    case "plugin:opener|open_url":
      window.open(String(args.url), "_blank", "noopener");
      return null;
    case "plugin:event|listen":
      return Math.floor(Math.random() * 1e9);
    case "plugin:event|unlisten":
    case "plugin:event|emit":
      return null;
    default:
      throw new Error(t("Esto necesita la app de escritorio de Raxorin Studio."));
  }
}

let nextCallback = 1;
const callbacks = new Map<number, (v: unknown) => void>();

export function installShim() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: (v: unknown) => void) => {
      const id = nextCallback++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  };
}
