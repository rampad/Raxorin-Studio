import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { Codicon } from "../components/Icon";
import { convertFrame, parseFigmaExport, type FigmaExport, type ImportResult } from "./figmaImport";

export type FigmaMode = "replace" | "add";

interface Props {
  /** Nombres que ya existen en el diseño (para no repetirlos). */
  usedIds: Set<string>;
  onImport: (result: ImportResult, mode: FigmaMode) => Promise<void>;
  onClose: () => void;
}

const TYPE_NAMES: Record<string, string> = {
  VerticalBox: "columnas", HorizontalBox: "filas", Rectangle: "paneles", Text: "textos", Image: "imágenes",
  Button: "botones", LineEdit: "cuadros de texto", TextEdit: "áreas de texto", CheckBox: "casillas", Switch: "interruptores",
  Slider: "deslizadores", ComboBox: "listas", ProgressIndicator: "barras de progreso", Spinner: "indicadores de carga",
};

/** Importar una pantalla exportada con el plugin "Raxorin Studio Export" de Figma. */
export default function FigmaImportDialog({ usedIds, onImport, onClose }: Props) {
  const [data, setData] = useState<FigmaExport | null>(null);
  const [source, setSource] = useState("");
  const [paste, setPaste] = useState("");
  const [frame, setFrame] = useState(0);
  const [mode, setMode] = useState<FigmaMode>("replace");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = (text: string, from: string) => {
    try {
      const d = parseFigmaExport(text);
      setData(d);
      setSource(from);
      setFrame(0);
      setErr("");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const pick = async () => {
    const file = await open({ title: "Archivo exportado desde Figma", filters: [{ name: "Exportación de Figma", extensions: ["json"] }] });
    if (typeof file !== "string") return;
    try {
      load(await api.readFile(file), file.split(/[\\/]/).pop() ?? file);
    } catch (e) {
      setErr(String(e));
    }
  };

  const preview: ImportResult | null = useMemo(() => {
    if (!data) return null;
    try {
      return convertFrame(data, frame, usedIds);
    } catch (e) {
      setErr(String(e));
      return null;
    }
  }, [data, frame, usedIds]);

  const summary = preview
    ? Object.entries(preview.stats)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${n} ${TYPE_NAMES[t] ?? t}`)
        .join(" · ")
    : "";

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal figma-import" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Codicon name="symbol-color" /> Importar de Figma
        </h2>

        {!data ? (
          <>
            <p className="muted small">
              En Figma, selecciona una pantalla y usa el plugin <strong>Raxorin Studio Export</strong>: descarga un archivo
              <code>.raxorin.json</code> (o lo copia). Ábrelo aquí.
            </p>
            <button className="btn primary" onClick={pick}>
              <Codicon name="folder-opened" /> Elegir archivo…
            </button>
            <label>
              …o pega lo que copiaste en el plugin
              <textarea className="mono figma-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"format": "raxorin-figma", …}' rows={4} spellCheck={false} />
            </label>
            {paste.trim() && (
              <button className="btn" onClick={() => load(paste, "Texto pegado")}>
                <Codicon name="check" /> Usar lo pegado
              </button>
            )}
            <details className="muted small">
              <summary>¿Cómo instalo el plugin en Figma?</summary>
              En Figma Desktop: <strong>Plugins → Desarrollo → Importar plugin desde manifiesto…</strong> y elige el
              <code>manifest.json</code> del proyecto <strong>Raxorin-Figma</strong>. Para mejores resultados usa Auto Layout y
              nombra los componentes <code>Button</code>, <code>Input</code>, <code>Checkbox</code>…
            </details>
          </>
        ) : (
          <>
            <div className="figma-source">
              <Codicon name="file" /> <strong>{data.file || source}</strong>
              <span className="muted small">{data.page && ` · ${data.page}`} · {source}</span>
              <button className="link-btn" onClick={() => setData(null)}>Cambiar</button>
            </div>
            {data.frames.length > 1 && (
              <label>
                Pantalla
                <select value={frame} onChange={(e) => setFrame(Number(e.target.value))}>
                  {data.frames.map((f, i) => (
                    <option key={f.id} value={i}>
                      {f.name} ({Math.round(f.box.w)}×{Math.round(f.box.h)})
                    </option>
                  ))}
                </select>
              </label>
            )}
            {preview && (
              <div className="cross-status ok">
                <span>
                  <Codicon name="pass" /> {preview.title} · {preview.width}×{preview.height}
                </span>
                <span className="muted small">{summary || "Pantalla vacía"}</span>
                {preview.tokens && <span className="muted small">+ {data.variables.length} colores del sistema de diseño (global <code>Tema</code>)</span>}
              </div>
            )}
            <div className="segmented">
              <button type="button" className={mode === "replace" ? "active" : ""} onClick={() => setMode("replace")}>
                <Codicon name="replace-all" /> Reemplazar el diseño
              </button>
              <button type="button" className={mode === "add" ? "active" : ""} onClick={() => setMode("add")}>
                <Codicon name="add" /> Agregar como panel
              </button>
            </div>
            <p className="muted small">
              {mode === "replace"
                ? "Se quitan los controles actuales de la ventana (y sus propiedades expuestas a Rust); la ventana toma el tamaño, título y fondo de la pantalla de Figma. Los callbacks de main.rs se conservan."
                : "La pantalla se agrega como un panel nuevo sobre lo que ya hay; luego puedes moverla o borrar lo anterior."}
              {preview?.assets.length ? ` Las imágenes se guardan en la carpeta figma/ junto al .slint.` : ""}
            </p>
            {preview && preview.warnings.length > 0 && (
              <ul className="figma-warnings muted small">
                {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
          </>
        )}

        {err && <pre className="hint err git-dialog-err">{err}</pre>}

        <div className="actions">
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button
            className="btn primary"
            disabled={!preview || busy}
            onClick={async () => {
              if (!preview) return;
              setBusy(true);
              setErr("");
              try {
                await onImport(preview, mode);
                onClose();
              } catch (e) {
                setErr(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <><Codicon name="loading" spin /> Importando…</> : <><Codicon name="cloud-download" /> Importar</>}
          </button>
        </div>
      </div>
    </div>
  );
}
