import { useEffect, useRef, useState } from "react";
import { Codicon } from "../components/Icon";
import type { DebugController } from "./controller";

export interface ConsoleEntry {
  kind: "input" | "result" | "error";
  text: string;
}

/** Consola de depuración: evalúa expresiones mientras el programa está detenido. */
export default function DebugConsole({ ctl, entries, setEntries, stopped }: {
  ctl: DebugController;
  entries: ConsoleEntry[];
  setEntries: (fn: (e: ConsoleEntry[]) => ConsoleEntry[]) => void;
  stopped: boolean;
}) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const out = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [entries]);

  const run = async () => {
    const expr = input.trim();
    if (!expr) return;
    setInput("");
    setHIndex(-1);
    setHistory((h) => [expr, ...h.filter((x) => x !== expr)].slice(0, 50));
    setEntries((e) => [...e, { kind: "input", text: expr }]);
    const r = await ctl.repl(expr);
    setEntries((e) => [...e, { kind: r.ok ? "result" : "error", text: r.text }]);
  };

  return (
    <div className="debug-console">
      <div className="console-out" ref={out}>
        {entries.length === 0 && (
          <div className="muted small pad">
            Escribe una expresión de Rust y presiona Enter, por ejemplo <code>i * 2</code>, <code>nombre.len()</code> o{" "}
            <code>i = 10</code> para cambiar un valor. Los comandos de LLDB empiezan con <code>`</code> (por ejemplo{" "}
            <code>`frame variable</code>).
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className={"console-line " + e.kind}>
            {e.kind === "input" ? <Codicon name="chevron-right" /> : e.kind === "error" ? <Codicon name="error" /> : <span className="console-gap" />}
            <span>{e.text}</span>
          </div>
        ))}
      </div>
      <form
        className={"stdin" + (stopped ? " live" : "")}
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <span className="stdin-label"><Codicon name="debug-console" /> Evaluar</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={stopped ? "Expresión (↑ ↓ historial)" : "Disponible cuando el programa está detenido"}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const i = Math.min(hIndex + 1, history.length - 1);
              setHIndex(i);
              setInput(history[i]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const i = hIndex - 1;
              setHIndex(Math.max(i, -1));
              setInput(i >= 0 ? history[i] : "");
            }
          }}
        />
        {entries.length > 0 && (
          <button type="button" className="icon-btn" title="Limpiar" onClick={() => setEntries(() => [])}>
            <Codicon name="clear-all" />
          </button>
        )}
      </form>
    </div>
  );
}
