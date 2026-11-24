// Mientras el programa está detenido, pasar el mouse sobre una variable muestra su valor.
import * as monaco from "monaco-editor";
import type { DebugController } from "./controller";

let registered = false;

export function registerDebugHover(getController: () => DebugController | null) {
  if (registered) return;
  registered = true;
  monaco.languages.registerHoverProvider("rust", {
    async provideHover(model, position) {
      const ctl = getController();
      if (!ctl || ctl.getSnapshot().status !== "stopped") return null;
      // Expresión bajo el cursor: identificadores unidos por puntos (p. ej. `punto.x`).
      const line = model.getLineContent(position.lineNumber);
      const re = /[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const start = m.index + 1;
        const end = start + m[0].length;
        if (position.column < start || position.column > end) continue;
        // Solo hasta el segmento donde está el cursor: en `a.b.c` sobre `b` → `a.b`.
        const upto = m[0].slice(0, position.column - start);
        const rest = m[0].slice(upto.length).match(/^\w*/)?.[0] ?? "";
        const expr = upto + rest;
        if (/^(let|mut|fn|if|else|for|in|while|loop|match|return|use|pub|struct|impl|self|Self|true|false)$/.test(expr)) return null;
        try {
          const r = await ctl.evaluate(expr, "hover");
          return {
            range: new monaco.Range(position.lineNumber, start, position.lineNumber, start + expr.length),
            contents: [{ value: "```rust\n" + `${expr} = ${r.result}` + "\n```" + (r.type ? `\n\n*${r.type}*` : "") }],
          };
        } catch {
          return null;
        }
      }
      return null;
    },
  });
}
