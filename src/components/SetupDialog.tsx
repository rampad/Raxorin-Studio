import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type SetupTool } from "../api";
import { Codicon } from "./Icon";

interface Props {
  /** Instala una herramienta (tarea "setup:<id>"); la salida va al panel. */
  onInstall: (id: string) => Promise<boolean>;
  /** Hay otra tarea corriendo (compilación, instalación…). */
  busy: boolean;
  onChanged: () => void;
  onClose: () => void;
  /** Se abrió solo porque falta algo imprescindible. */
  firstRun: boolean;
}

/** Asistente: qué herramientas hay, cuáles faltan, e instalarlas desde la app. */
export default function SetupDialog({ onInstall, busy, onChanged, onClose, firstRun }: Props) {
  const [tools, setTools] = useState<SetupTool[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const queue = useRef<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  const lastCheck = useRef(0);
  const installingRef = useRef<string | null>(null);
  installingRef.current = installing;

  const refresh = useCallback(async () => {
    lastCheck.current = Date.now();
    const t = await api.setupStatus().catch(() => null);
    setTools(t);
    return t;
  }, []);

  useEffect(() => {
    void refresh();
    // Al volver a la ventana (p. ej. tras el instalador de Apple), revisar de nuevo. Como mucho
    // cada 10 s y nunca durante una instalación: una ventana del sistema que se abre y se cierra
    // no debe provocar revisiones en cadena.
    const onFocus = () => {
      if (!installingRef.current && Date.now() - lastCheck.current > 10_000) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const next = useCallback(async () => {
    const id = queue.current.shift();
    if (!id) {
      setInstalling(null);
      return;
    }
    setInstalling(id);
    const started = await onInstall(id);
    if (!started) {
      queue.current = [];
      setInstalling(null);
    }
  }, [onInstall]);

  // Cuando termina una instalación: revisar y seguir con la siguiente.
  useEffect(() => {
    const un = listen<{ task: string }>("task-finished", async (e) => {
      if (!e.payload.task.startsWith("setup:")) return;
      await refresh();
      onChanged();
      void next();
    });
    return () => {
      un.then((f) => f());
    };
  }, [refresh, onChanged, next]);

  const missing = (tools ?? []).filter((t) => !t.installed && !t.unavailable);
  const installable = missing.filter((t) => t.canInstall);
  const requiredMissing = missing.filter((t) => t.required);

  const installAll = () => {
    // En macOS el instalador de Apple cubre C/C++, Git y el depurador: se abre una sola vez.
    const ids: string[] = [];
    let apple = false;
    // Primero el compilador de C/C++: en Windows, rustup-init sin Build Tools ofrecería instalar
    // Visual Studio completo por su cuenta.
    const order = ["cpp", "rust", "git", "debugger", "gh"];
    const sorted = [...installable].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    for (const t of sorted) {
      const viaApple = navigator.platform.includes("Mac") && ["cpp", "git", "debugger"].includes(t.id);
      if (viaApple && apple) continue;
      apple ||= viaApple;
      ids.push(t.id);
    }
    queue.current = ids;
    void next();
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* sin portapapeles */
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !installing && onClose()}>
      <div className="modal setup-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Codicon name="tools" /> Herramientas necesarias
        </h2>
        <p className="muted small">
          {firstRun
            ? "Para compilar y ejecutar programas en Rust faltan algunas herramientas. Raxorin Studio puede instalarlas por ti."
            : "Lo que Raxorin Studio usa en tu computadora. Puedes instalar lo que falte desde aquí."}
        </p>

        {!tools ? (
          <p><Codicon name="loading" spin /> Revisando…</p>
        ) : (
          <div className="setup-list">
            {tools.map((t) => {
              const state = t.unavailable ? "na" : t.installed ? "ok" : t.required ? "missing" : "optional";
              const manualIsUrl = t.manual?.startsWith("http");
              return (
                <div key={t.id} className={"setup-row " + state}>
                  <Codicon
                    name={state === "ok" ? "pass-filled" : state === "na" ? "circle-slash" : state === "missing" ? "error" : "circle-large-outline"}
                    className="setup-icon"
                  />
                  <div className="setup-text">
                    <div className="setup-name">
                      {t.name}
                      {t.required && !t.installed && <span className="setup-tag">Imprescindible</span>}
                      {!t.required && !t.installed && !t.unavailable && <span className="setup-tag opt">Opcional</span>}
                    </div>
                    <div className="muted small">{t.unavailable ?? (t.installed ? t.version ?? "Instalado" : t.description)}</div>
                    {t.problem && (
                      <div className="setup-problem small">
                        <Codicon name="warning" /> {t.problem}
                      </div>
                    )}
                    {!t.installed && !t.unavailable && !t.canInstall && t.manual && (
                      <div className="setup-manual small">
                        {manualIsUrl ? (
                          <button className="link-btn" onClick={() => openUrl(t.manual!.split(" ")[0])}>
                            <Codicon name="link-external" /> Instrucciones
                          </button>
                        ) : (
                          <>
                            <code>{t.manual}</code>
                            <button className="icon-btn" title="Copiar" onClick={() => copy(t.manual!)}>
                              <Codicon name={copied === t.manual ? "check" : "copy"} />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {!t.installed && !t.unavailable && t.canInstall && (
                    <button
                      className={"btn small" + (t.required ? " primary" : "")}
                      disabled={busy || !!installing}
                      onClick={() => {
                        queue.current = [t.id];
                        void next();
                      }}
                      title={t.needsAdmin ? "El sistema pedirá permiso de administrador" : undefined}
                    >
                      {installing === t.id ? (
                        <><Codicon name="loading" spin /> Instalando…</>
                      ) : t.problem ? (
                        <><Codicon name="tools" /> Reparar</>
                      ) : (
                        <><Codicon name="cloud-download" /> Instalar</>
                      )}
                      {t.needsAdmin && installing !== t.id && <Codicon name="shield" />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {installing && (
          <p className="muted small">
            <Codicon name="info" /> Mira el progreso en el panel <strong>Salida</strong>. Si el sistema pide permiso o una
            contraseña, acéptalo en su ventana.
          </p>
        )}

        <div className="actions">
          <button className="btn" onClick={() => void refresh()} disabled={!!installing}>
            <Codicon name="refresh" /> Revisar de nuevo
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={!!installing}>
            {requiredMissing.length ? "Más tarde" : "Cerrar"}
          </button>
          {installable.length > 0 && (
            <button className="btn primary" onClick={installAll} disabled={busy || !!installing}>
              <Codicon name="cloud-download" /> Instalar todo lo que falta ({installable.length})
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
