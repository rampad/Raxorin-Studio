import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import "@xterm/xterm/css/xterm.css";
import { Codicon } from "../components/Icon";
import { useTheme } from "../theme";
import {
  applyTheme,
  attach,
  closeSession,
  createSession,
  getActive,
  getSessions,
  setActive,
  setFontSize,
  subscribe,
} from "./sessions";
import { t } from "../i18n/index.ts";

interface Props {
  /** Carpeta donde arrancan las terminales nuevas (el proyecto abierto). */
  cwd: string | null;
  /** La pestaña Terminal está a la vista. */
  visible: boolean;
  fontSize: number;
}

/** Terminal integrado: varias terminales con el shell del sistema (zsh, bash, PowerShell). */
export default function TerminalPanel({ cwd, visible, fontSize }: Props) {
  const sessions = useSyncExternalStore(subscribe, getSessions);
  const active = useSyncExternalStore(subscribe, getActive);
  const slot = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();

  // La primera vez que se muestra, abrir una terminal.
  useEffect(() => {
    if (visible && getSessions().length === 0) createSession(cwd, fontSize);
  }, [visible, cwd, fontSize]);

  // Mostrar la sesión activa en el panel (las demás siguen vivas, ocultas).
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el || !visible || !active) return;
    for (const s of getSessions()) s.host.style.display = s === active ? "" : "none";
    attach(active, el);
    active.term.focus();
  }, [active, visible, sessions.length]);

  // Ajustar columnas y filas al tamaño del panel.
  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const s = getActive();
      if (visible && s?.started && el.clientWidth > 0) s.fit.fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  useEffect(() => {
    // Esperar a que se apliquen las variables CSS del tema nuevo.
    requestAnimationFrame(applyTheme);
  }, [theme]);

  useEffect(() => setFontSize(fontSize), [fontSize]);

  return (
    <div className="terminal-panel">
      <div className="terminal-bar">
        {sessions.map((s, i) => (
          <button
            key={s.key}
            className={"terminal-tab" + (s === active ? " active" : "") + (s.exited ? " exited" : "")}
            onClick={() => setActive(s.key)}
            title={s.cwd ?? undefined}
          >
            <Codicon name="terminal" /> {i + 1}: {s.title}
            <span
              className="terminal-close"
              role="button"
              title={t("Cerrar esta terminal")}
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.key);
              }}
            >
              <Codicon name="close" />
            </span>
          </button>
        ))}
        <button className="icon-btn" title={t("Nueva terminal")} onClick={() => createSession(cwd, fontSize)}>
          <Codicon name="add" />
        </button>
        <span className="spacer" />
        <button className="icon-btn" title={t("Limpiar")} onClick={() => active?.term.clear()} disabled={!active}>
          <Codicon name="clear-all" />
        </button>
      </div>
      <div className="terminal-slot" ref={slot}>
        {sessions.length === 0 && (
          <div className="muted pad">
            <button className="btn" onClick={() => createSession(cwd, fontSize)}>
              <Codicon name="add" /> {" "}{t("Nueva terminal")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
