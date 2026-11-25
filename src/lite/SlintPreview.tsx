// Vista previa REAL de una ventana de Slint en el navegador: el intérprete oficial de Slint
// compilado a WebAssembly (el mismo que usa SlintPad), servido junto a la app en /slint/.
// Se vuelve a compilar al editar (con una pausa), y los errores de Slint se muestran con su línea.
import { useEffect, useRef, useState } from "react";
import { Codicon } from "../components/Icon";
import { t } from "../i18n/index.ts";
import { fileBytes } from "./zip";

type SlintModule = {
  default: (opts?: unknown) => Promise<unknown>;
  compile_from_string: (
    source: string,
    baseUrl: string,
    importCb?: ((url: string) => Promise<string | null>) | null,
    loader?: ((url: string) => Promise<Uint8Array>) | null,
  ) => Promise<{ component?: { create: (canvasId: string) => Promise<{ show: () => Promise<unknown>; hide: () => void }> }; diagnostics: SlintDiag[]; error_string: string }>;
  run_event_loop: () => void;
};
type SlintDiag = { message?: string; level?: number | string; lineNumber?: number; columnNumber?: number; fileName?: string };

let loading: Promise<SlintModule> | null = null;
/** Carga el intérprete una vez (7,5 MB de WebAssembly, con caché del navegador). */
function loadSlint(): Promise<SlintModule> {
  loading ??= (async () => {
    const url = `${import.meta.env.BASE_URL}slint/slint_wasm_interpreter.js`;
    // Un import() que Vite no reescribe: el archivo es estático (public-lite/slint), no código fuente.
    const load = new Function("u", "return import(u)") as (u: string) => Promise<SlintModule>;
    const mod = await load(new URL(url, location.href).href);
    await mod.default();
    // El bucle de eventos (winit en la web) crea y dibuja las ventanas: se arranca una vez, antes de
    // crear ninguna. En la web sale con una excepción a propósito y sigue funcionando.
    try {
      mod.run_event_loop();
    } catch {
      /* esperado */
    }
    return mod;
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

const ROOT = "file:///project/";

interface Props {
  /** Archivos del proyecto (rutas relativas). */
  files: Record<string, string>;
  /** El .slint a mostrar (ruta relativa). */
  path: string;
  onGoto?: (path: string, line: number) => void;
}

export default function SlintPreview({ files, path, onGoto }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [diags, setDiags] = useState<{ level: "error" | "warning"; message: string; file: string; line: number }[]>([]);
  const [loadError, setLoadError] = useState("");
  const filesRef = useRef(files);
  filesRef.current = files;
  const source = files[path] ?? "";

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      let slint: SlintModule;
      try {
        slint = await loadSlint();
      } catch (e) {
        if (alive) {
          setLoadError(String(e));
          setState("error");
        }
        return;
      }
      const rel = (url: string) => decodeURIComponent(url.replace(ROOT, "")).replace(/^\/+/, "");
      const result = await slint.compile_from_string(
        source,
        ROOT + path,
        async (url) => filesRef.current[rel(url)] ?? null,
        async (url) => {
          const content = filesRef.current[rel(url)];
          if (content === undefined) throw new Error(`No se encontró ${rel(url)}`);
          return fileBytes(content);
        },
      );
      if (!alive) return;
      setDiags(
        (result.diagnostics ?? []).map((d) => ({
          level: d.level === 0 || d.level === "Error" || d.level === "error" ? "error" : "warning",
          message: d.message ?? String(d),
          file: d.fileName ? rel(d.fileName) : path,
          line: d.lineNumber ?? 0,
        })),
      );
      if (!result.component) {
        setState("error");
        return;
      }
      // Un lienzo nuevo en cada compilación (Slint se queda con el anterior).
      const el = host.current;
      if (!el) return;
      el.replaceChildren();
      const canvas = document.createElement("canvas");
      canvas.id = `slint-${Math.random().toString(36).slice(2)}`;
      canvas.tabIndex = 0;
      el.appendChild(canvas);
      try {
        const instance = await result.component.create(canvas.id);
        await instance.show();
        if (alive) setState("ok");
      } catch (e) {
        if (alive) {
          setDiags((d) => [...d, { level: "error", message: String(e), file: path, line: 0 }]);
          setState("error");
        }
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [source, path]);

  return (
    <div className="lite-preview">
      <div className="lite-preview-head">
        <Codicon name="play" /> {t("Vista previa real")}
        <span className="muted small">{t("Slint en WebAssembly: la ventana funciona (botones, campos), pero sin la lógica de Rust.")}</span>
        <a className="lite-slint-credit small" href="https://slint.dev" target="_blank" rel="noopener">{t("Hecho con Slint")}</a>
      </div>
      <div className="lite-preview-stage">
        {state === "loading" && !loadError && (
          <div className="muted small lite-preview-msg"><Codicon name="loading" spin /> {t("Cargando Slint…")}</div>
        )}
        {loadError && <div className="err small lite-preview-msg">{t("No se pudo cargar el intérprete de Slint: {0}", loadError)}</div>}
        <div ref={host} className="lite-preview-canvas" />
      </div>
      {diags.length > 0 && (
        <div className="lite-preview-diags">
          {diags.map((d, i) => (
            <button key={i} className={`lite-diag ${d.level}`} onClick={() => onGoto?.(d.file, d.line)}>
              <Codicon name={d.level === "error" ? "error" : "warning"} />
              <span>{d.message}</span>
              <span className="muted">{d.file}:{d.line}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
