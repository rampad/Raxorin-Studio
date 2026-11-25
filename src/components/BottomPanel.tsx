import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Diagnostic, OutputChunk, Task } from "../api";
import { relative } from "../util";
import { Codicon } from "./Icon";
import { t } from "../i18n/index.ts";

export type BottomTab = "output" | "errors" | "terminal" | "debug" | "console" | "breakpoints";

interface Props {
  tab: BottomTab;
  setTab: (t: BottomTab) => void;
  output: OutputChunk[];
  diagnostics: Diagnostic[];
  running: Task | null;
  project: string | null;
  onClear: () => void;
  onStdin: (text: string) => void;
  onGoto: (d: Diagnostic) => void;
  /** El programa acepta entrada (ejecución normal o depuración con stdin). */
  acceptsInput: boolean;
  debugActive: boolean;
  debugContent: ReactNode;
  consoleContent: ReactNode;
  breakpointsContent: ReactNode;
  /** Siempre montado (oculto si no es la pestaña activa) para no perder las terminales. */
  terminalContent: ReactNode;
  breakpointCount: number;
  height?: number;
  onHide?: () => void;
}

export default function BottomPanel(p: Props) {
  const outRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const programRunning = p.acceptsInput;

  // Desplazar al final cuando llega salida nueva.
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.output, p.tab]);

  // Enfocar la entrada cuando arranca el programa.
  useEffect(() => {
    if (programRunning) inputRef.current?.focus();
  }, [programRunning]);

  const errors = p.diagnostics.filter((d) => d.level.startsWith("error")).length;
  const warnings = p.diagnostics.filter((d) => d.level === "warning").length;

  return (
    <div className="bottom-panel" style={{ height: p.height }}>
      <div className="panel-tabs">
        <button className={p.tab === "output" ? "active" : ""} onClick={() => p.setTab("output")}>
          <Codicon name="output" />
          
          {t("Salida")}
        </button>
        <button className={p.tab === "errors" ? "active" : ""} onClick={() => p.setTab("errors")}>
          <Codicon name="list-unordered" />
          
          {t("Lista de errores")}
          <span className="badge err"><Codicon name="error" /> {errors}</span>
          <span className="badge warn"><Codicon name="warning" /> {warnings}</span>
        </button>
        <button className={p.tab === "terminal" ? "active" : ""} onClick={() => p.setTab("terminal")}>
          <Codicon name="terminal" />
          
          {t("Terminal")}
        </button>
        {p.debugActive && (
          <button className={p.tab === "debug" ? "active" : ""} onClick={() => p.setTab("debug")}>
            <Codicon name="debug-alt" />
            
            {t("Depuración")}
          </button>
        )}
        {p.debugActive && (
          <button className={p.tab === "console" ? "active" : ""} onClick={() => p.setTab("console")}>
            <Codicon name="debug-console" />
            
            {t("Consola de depuración")}
          </button>
        )}
        <button className={p.tab === "breakpoints" ? "active" : ""} onClick={() => p.setTab("breakpoints")}>
          <Codicon name="circle-filled" className="bp-tab-icon" />
          
          {t("Puntos de interrupción")}
          {p.breakpointCount > 0 && <span className="count">{p.breakpointCount}</span>}
        </button>
        <div className="spacer" />
        {p.tab === "output" && (
          <button className="icon-btn" onClick={p.onClear} title={t("Limpiar salida")}><Codicon name="clear-all" /></button>
        )}
        {p.onHide && (
          <button className="icon-btn" onClick={p.onHide} title={t("Ocultar panel (Ctrl/⌘+J)")}><Codicon name="chevron-down" /></button>
        )}
      </div>

      <div className="terminal-wrap" style={{ display: p.tab === "terminal" ? "flex" : "none" }}>
        {p.terminalContent}
      </div>
      {p.tab === "terminal" ? null : p.tab === "debug" ? (
        p.debugContent
      ) : p.tab === "console" ? (
        p.consoleContent
      ) : p.tab === "breakpoints" ? (
        <div className="errors">{p.breakpointsContent}</div>
      ) : p.tab === "output" ? (
        <div className="output-wrap">
          <pre className="output" ref={outRef} onClick={() => programRunning && inputRef.current?.focus()}>
            {p.output.map((c, i) => (
              <span key={i} className={"out-" + c.kind}>{c.text}</span>
            ))}
          </pre>
          <form
            className={"stdin" + (programRunning ? " live" : "")}
            onSubmit={(e) => {
              e.preventDefault();
              if (!programRunning) return;
              p.onStdin(input);
              setInput("");
            }}
          >
            <span className="stdin-label"><Codicon name="chevron-right" /> {" "}{t("Entrada")}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!programRunning}
              placeholder={
                programRunning
                  ? t("Escribe y presiona Enter para enviarlo al programa")
                  : t("Disponible mientras el programa se ejecuta")
              }
            />
          </form>
        </div>
      ) : (
        <div className="errors">
          {p.diagnostics.length === 0 ? (
            <div className="muted pad"><Codicon name="pass" className="ok" /> {" "}{t("No hay errores ni advertencias.")}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }}></th>
                  <th style={{ width: 70 }}>{t("Código")}</th>
                  <th>{t("Descripción")}</th>
                  <th style={{ width: 200 }}>{t("Archivo")}</th>
                  <th style={{ width: 70 }}>{t("Línea")}</th>
                </tr>
              </thead>
              <tbody>
                {p.diagnostics.map((d, i) => (
                  <tr key={i} onClick={() => p.onGoto(d)} title={t("Clic para ir al error")}>
                    <td>{d.level.startsWith("error") ? <Codicon name="error" className="err" /> : <Codicon name="warning" className="warn" />}</td>
                    <td className="muted">{d.code ?? ""}</td>
                    <td>{d.message}</td>
                    <td className="muted">{d.file ? relative(p.project, d.file) : ""}</td>
                    <td className="muted">{d.line}:{d.column}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
