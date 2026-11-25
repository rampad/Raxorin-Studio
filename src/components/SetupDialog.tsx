import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type SetupTool } from "../api";
import { Codicon } from "./Icon";
import { t, tb } from "../i18n/index.ts";

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
          <Codicon name="tools" /> {" "}{t("Herramientas necesarias")}
        </h2>
        <p className="muted small">
          {firstRun
            ? t("Para compilar y ejecutar programas en Rust faltan algunas herramientas. Raxorin Studio puede instalarlas por ti.")
            : t("Lo que Raxorin Studio usa en tu computadora. Puedes instalar lo que falte desde aquí.")}
        </p>

        {!tools ? (
          <p><Codicon name="loading" spin /> {" "}{t("Revisando…")}</p>
        ) : (
          <div className="setup-list">
            {tools.map((it) => {
              const state = it.unavailable ? "na" : it.installed ? "ok" : it.required ? "missing" : "optional";
              const manualIsUrl = it.manual?.startsWith("http");
              return (
                <div key={it.id} className={"setup-row " + state}>
                  <Codicon
                    name={state === "ok" ? "pass-filled" : state === "na" ? "circle-slash" : state === "missing" ? "error" : "circle-large-outline"}
                    className="setup-icon"
                  />
                  <div className="setup-text">
                    <div className="setup-name">
                      {tb(it.name)}
                      {it.required && !it.installed && <span className="setup-tag">{t("Imprescindible")}</span>}
                      {!it.required && !it.installed && !it.unavailable && <span className="setup-tag opt">{t("Opcional")}</span>}
                    </div>
                    <div className="muted small">{it.unavailable ? tb(it.unavailable) : it.installed ? it.version ? tb(it.version) : t("Instalado") : tb(it.description)}</div>
                    {it.problem && (
                      <div className="setup-problem small">
                        <Codicon name="warning" /> {tb(it.problem)}
                      </div>
                    )}
                    {!it.installed && !it.unavailable && !it.canInstall && it.manual && (
                      <div className="setup-manual small">
                        {manualIsUrl ? (
                          <button className="link-btn" onClick={() => openUrl(it.manual!.split(" ")[0])}>
                            <Codicon name="link-external" /> {" "}{t("Instrucciones")}
                          </button>
                        ) : (
                          <>
                            <code>{it.manual}</code>
                            <button className="icon-btn" title={t("Copiar")} onClick={() => copy(it.manual!)}>
                              <Codicon name={copied === it.manual ? "check" : "copy"} />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {!it.installed && !it.unavailable && it.canInstall && (
                    <button
                      className={"btn small" + (it.required ? " primary" : "")}
                      disabled={busy || !!installing}
                      onClick={() => {
                        queue.current = [it.id];
                        void next();
                      }}
                      title={it.needsAdmin ? t("El sistema pedirá permiso de administrador") : undefined}
                    >
                      {installing === it.id ? (
                        <><Codicon name="loading" spin /> {" "}{t("Instalando…")}</>
                      ) : it.problem ? (
                        <><Codicon name="tools" /> {" "}{t("Reparar")}</>
                      ) : (
                        <><Codicon name="cloud-download" /> {" "}{t("Instalar")}</>
                      )}
                      {it.needsAdmin && installing !== it.id && <Codicon name="shield" />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {installing && (
          <p className="muted small">
            <Codicon name="info" /> {" "}{t("Mira el progreso en el panel")}{" "}<strong>{t("Salida")}</strong>{t(". Si el sistema pide permiso o una contraseña, acéptalo en su ventana.")}
          </p>
        )}

        <div className="actions">
          <button className="btn" onClick={() => void refresh()} disabled={!!installing}>
            <Codicon name="refresh" /> {" "}{t("Revisar de nuevo")}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={!!installing}>
            {requiredMissing.length ? t("Más tarde") : t("Cerrar")}
          </button>
          {installable.length > 0 && (
            <button className="btn primary" onClick={installAll} disabled={busy || !!installing}>
              <Codicon name="cloud-download" /> {" "}{t("Instalar todo lo que falta (")}{installable.length})
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
