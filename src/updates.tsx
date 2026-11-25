// Actualizaciones de Raxorin Studio: buscar (al iniciar y cada 6 horas, o a mano),
// avisar con las novedades, descargar con progreso, instalar y reiniciar.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type UpdateInfo } from "./api";
import { Codicon } from "./components/Icon";
import { getSettings } from "./settings";
import { t, tErr, lang } from "./i18n/index.ts";

export type UpdateStatus = "idle" | "checking" | "available" | "uptodate" | "downloading" | "installed" | "error";

const SKIP_KEY = "raxorinstudio.skipVersion";
const EVERY = 6 * 60 * 60 * 1000;

export function useUpdates(log: (t: string, k?: "info" | "error" | "success" | "muted" | "warning") => void) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });
  /** El diálogo está abierto (se abre solo si hay versión nueva, o al buscar a mano). */
  const [open, setOpen] = useState(false);
  const busy = useRef(false);

  const check = useCallback(
    async (manual: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setStatus("checking");
      setError("");
      if (manual) setOpen(true);
      try {
        const found = await api.updateCheck(getSettings().updateChannel);
        setInfo(found);
        if (!found) {
          setStatus("uptodate");
        } else {
          setStatus("available");
          let skipped: string | null = null;
          try {
            skipped = localStorage.getItem(SKIP_KEY);
          } catch {
            /* sin almacenamiento */
          }
          // En la búsqueda automática no se insiste con una versión que el usuario omitió.
          if (manual || skipped !== found.version) setOpen(true);
          log(t("Hay una versión nueva de Raxorin Studio: {0} (tienes la {1}).", found.version, found.current), "info");
        }
      } catch (e) {
        setStatus("error");
        setError(tErr(e));
        if (manual) log(`Actualizaciones: ${e}`, "warning");
      } finally {
        busy.current = false;
      }
    },
    [log],
  );

  // Búsqueda automática: a los 8 s de abrir y luego cada 6 horas.
  useEffect(() => {
    const run = () => getSettings().autoUpdate && void check(false);
    const first = setTimeout(run, 8000);
    const every = setInterval(run, EVERY);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [check]);

  useEffect(() => {
    const un = listen<{ downloaded: number; total: number | null; done: boolean }>("update-progress", (e) => {
      if (!e.payload.done) setProgress({ downloaded: e.payload.downloaded, total: e.payload.total });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const install = useCallback(async () => {
    setStatus("downloading");
    setProgress({ downloaded: 0, total: null });
    try {
      await api.updateInstall();
      setStatus("installed");
      log(t("Raxorin Studio {0} instalado: reinicia para usarlo.", info?.version), "success");
    } catch (e) {
      setStatus("error");
      setError(tErr(e));
    }
  }, [info, log]);

  const skip = useCallback(() => {
    if (info) {
      try {
        localStorage.setItem(SKIP_KEY, info.version);
      } catch {
        /* sin almacenamiento */
      }
    }
    setOpen(false);
  }, [info]);

  return { status, info, error, progress, open, setOpen, check, install, skip, restart: () => api.updateRestart() };
}

export type Updates = ReturnType<typeof useUpdates>;

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/**
 * NOVEDADES.md trae primero el español y, después de `<!-- English -->`, el inglés: se muestra la
 * parte del idioma de la interfaz (las versiones antiguas solo tienen español).
 */
export function notesFor(text: string): string {
  const [es, en] = text.split(/<!--\s*English\s*-->/i);
  return (lang === "en" && en?.trim() ? en : es).replace(/^\s*---\s*$/gm, "").trim();
}

/** Notas de la versión: texto de GitHub (Markdown simple) como líneas legibles. */
function Notes({ text }: { text: string }) {
  const lines = notesFor(text).replace(/\r/g, "").split("\n").filter((l) => l.trim());
  return (
    <div className="update-notes">
      {lines.map((l, i) => {
        const h = l.match(/^#+\s*(.*)/);
        if (h) return <strong key={i}>{h[1]}</strong>;
        const li = l.match(/^\s*[-*]\s+(.*)/);
        return li ? <div key={i} className="update-li">• {li[1].replace(/\*\*/g, "")}</div> : <div key={i}>{l.replace(/\*\*/g, "")}</div>;
      })}
    </div>
  );
}

export function UpdateDialog({ u }: { u: Updates }) {
  if (!u.open) return null;
  const busy = u.status === "downloading" || u.status === "checking";
  const pct = u.progress.total ? Math.min(100, Math.round((u.progress.downloaded / u.progress.total) * 100)) : null;
  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && u.setOpen(false)}>
      <div className="modal update-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Codicon name="cloud-download" /> {" "}{t("Actualizaciones")}
        </h2>

        {u.status === "checking" && (
          <p><Codicon name="loading" spin /> {" "}{t("Buscando versiones nuevas…")}</p>
        )}
        {u.status === "uptodate" && (
          <p><Codicon name="pass" className="ok" /> {" "}{t("Tienes la última versión de Raxorin Studio.")}</p>
        )}
        {u.status === "error" && <pre className="hint err git-dialog-err">{u.error}</pre>}

        {u.info && (u.status === "available" || u.status === "downloading" || u.status === "installed") && (
          <>
            <p>
              
              {t("Hay una versión nueva:")}{" "}<strong>{u.info.version}</strong>{" "}
              <span className="muted">{t("(tienes la")}{" "}{u.info.current}{u.info.date ? t(" · publicada el {0}", u.info.date) : ""})</span>
            </p>
            {u.info.notes && <Notes text={u.info.notes} />}
          </>
        )}

        {u.status === "downloading" && (
          <div className="update-progress">
            <div className="update-bar"><div style={{ width: `${pct ?? 30}%` }} className={pct === null ? "indeterminate" : ""} /></div>
            <span className="muted small">
              
              {t("Descargando…")}{" "}{mb(u.progress.downloaded)}{u.progress.total ? ` de ${mb(u.progress.total)}` : ""}{t(". Se verifica la firma antes de instalar.")}
            </span>
          </div>
        )}
        {u.status === "installed" && (
          <p><Codicon name="pass" className="ok" /> {" "}{t("Listo. Reinicia Raxorin Studio para usar la versión nueva (guarda tu trabajo antes).")}</p>
        )}

        <div className="actions">
          {u.status === "available" && (
            <button className="btn" onClick={u.skip} title={t("No volver a avisar de esta versión")}>
              
              {t("Omitir esta versión")}
            </button>
          )}
          <span className="spacer" />
          {u.status === "available" && (
            <>
              <button className="btn" onClick={() => u.setOpen(false)}>{t("Más tarde")}</button>
              <button className="btn primary" onClick={u.install}>
                <Codicon name="cloud-download" /> {" "}{t("Actualizar ahora")}
              </button>
            </>
          )}
          {u.status === "installed" && (
            <>
              <button className="btn" onClick={() => u.setOpen(false)}>{t("Después")}</button>
              <button className="btn primary" onClick={u.restart}>
                <Codicon name="debug-restart" /> {" "}{t("Reiniciar ahora")}
              </button>
            </>
          )}
          {(u.status === "uptodate" || u.status === "error" || u.status === "checking") && (
            <button className="btn primary" onClick={() => u.setOpen(false)} disabled={u.status === "checking"}>
              
              {t("Cerrar")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
