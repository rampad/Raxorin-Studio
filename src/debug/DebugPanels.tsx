import { useState } from "react";
import { Codicon } from "../components/Icon";
import { basename, relative } from "../util";
import { describeBreakpoint, type BreakpointInfo, type BreakpointStore } from "./breakpoints";
import type { DebugController, DebugSnapshot } from "./controller";
import type { Variable } from "./dap";

// ---------- Árbol de variables (se expande bajo demanda) ----------

function VarNode({ v, ctl, depth, stopCount }: { v: Variable; ctl: DebugController; depth: number; stopCount: number }) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<Variable[] | null>(null);
  const expandable = v.variablesReference > 0;
  const toggle = async () => {
    if (!expandable) return;
    if (!open && kids === null) setKids(await ctl.variables(v.variablesReference));
    setOpen((o) => !o);
  };
  return (
    <>
      <div className="var-row" style={{ paddingLeft: 6 + depth * 14 }} onClick={toggle} title={v.type}>
        <span className="twisty">{expandable && <Codicon name={open ? "chevron-down" : "chevron-right"} />}</span>
        <span className="var-name">{v.name}</span>
        <span className="var-sep">=</span>
        <span className={"var-value" + (/^".*"$/.test(v.value) ? " str" : /^-?\d/.test(v.value) ? " num" : "")}>{v.value}</span>
        {v.type && <span className="var-type">{shortType(v.type)}</span>}
      </div>
      {open && kids?.map((k) => <VarNode key={`${stopCount}-${k.name}`} v={k} ctl={ctl} depth={depth + 1} stopCount={stopCount} />)}
    </>
  );
}

/** "alloc::vec::Vec<i32, alloc::alloc::Global>" → "Vec<i32>" */
function shortType(t: string) {
  return t
    .replace(/,\s*alloc::alloc::Global/g, "")
    .replace(/\b(?:[a-z_][a-z0-9_]*::)+/g, "")
    .replace(/\bint\b/g, "i32");
}

// ---------- Panel principal (durante la depuración) ----------

export function DebugPanel({ ctl, snap, root }: { ctl: DebugController; snap: DebugSnapshot; root: string | null }) {
  const [newWatch, setNewWatch] = useState("");
  const stopped = snap.status === "stopped";

  return (
    <div className="debug-panel">
      <div className="debug-col">
        <div className="debug-col-title"><Codicon name="symbol-variable" /> Variables locales</div>
        <div className="debug-col-body">
          {!stopped ? (
            <div className="muted pad small">{snap.status === "running" ? "El programa se está ejecutando…" : "Detén el programa en un punto de interrupción para ver sus variables."}</div>
          ) : snap.locals.length === 0 ? (
            <div className="muted pad small">No hay variables en este punto.</div>
          ) : (
            snap.locals.map((v) => <VarNode key={`${snap.stopCount}-${snap.frameId}-${v.name}`} v={v} ctl={ctl} depth={0} stopCount={snap.stopCount} />)
          )}
        </div>
      </div>

      <div className="debug-col">
        <div className="debug-col-title"><Codicon name="eye" /> Inspección</div>
        <div className="debug-col-body">
          {snap.watches.map((w) => (
            <div key={w.expr} className="var-row watch">
              <span className="twisty" />
              <span className="var-name">{w.expr}</span>
              <span className="var-sep">=</span>
              {w.error ? <span className="var-value err">{w.error}</span> : <span className="var-value">{w.value ?? (stopped ? "…" : "")}</span>}
              <button className="icon-btn" title="Quitar" onClick={() => ctl.removeWatch(w.expr)}><Codicon name="close" /></button>
            </div>
          ))}
          <form
            className="watch-add"
            onSubmit={(e) => {
              e.preventDefault();
              ctl.addWatch(newWatch);
              setNewWatch("");
            }}
          >
            <Codicon name="add" />
            <input value={newWatch} onChange={(e) => setNewWatch(e.target.value)} placeholder="Agregar expresión (p. ej. numeros.len())" spellCheck={false} />
          </form>
        </div>
      </div>

      <div className="debug-col">
        <div className="debug-col-title"><Codicon name="debug-stackframe" /> Pila de llamadas</div>
        <div className="debug-col-body">
          {!stopped && <div className="muted pad small">—</div>}
          {stopped &&
            snap.frames.map((f) => {
              const user = !!f.source?.path && !!root && f.source.path.startsWith(root);
              return (
                <div
                  key={f.id}
                  className={"frame-row" + (f.id === snap.frameId ? " selected" : "") + (user ? "" : " external")}
                  onClick={() => ctl.selectFrame(f.id)}
                  title={f.source?.path}
                >
                  {f.id === snap.frameId ? <Codicon name="debug-stackframe-active" /> : <span className="frame-dot" />}
                  <span className="frame-name">{cleanFrameName(f.name)}</span>
                  {f.source?.name && <span className="frame-loc">{f.source.name}:{f.line}</span>}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

/** "dbg::sumar" → "sumar"; quita genéricos largos de la biblioteca estándar. */
function cleanFrameName(n: string) {
  const short = n.replace(/<[^<>]*(<[^<>]*>[^<>]*)*>/g, "<…>");
  return short.length > 80 ? short.slice(0, 77) + "…" : short;
}

// ---------- Lista de puntos de interrupción ----------

export function BreakpointsPanel({ store, root, onOpen, onAdd, onEdit }: {
  store: BreakpointStore;
  root: string | null;
  onOpen: (b: BreakpointInfo) => void;
  onAdd: () => void;
  onEdit: (b: BreakpointInfo) => void;
}) {
  const all = store.all();
  if (all.length === 0) {
    return (
      <div className="bp-empty">
        <p className="muted small">
          <Codicon name="info" /> Haz clic en el margen izquierdo del editor (junto al número de línea) o presiona <kbd>F9</kbd>.
          Con clic derecho en el margen eliges el tipo: condicional, por número de vuelta o mensaje sin detenerse.
        </p>
        <button className="btn small primary" onClick={onAdd}><Codicon name="add" /> Agregar punto de interrupción…</button>
      </div>
    );
  }
  return (
    <div className="bp-list">
      <div className="bp-actions">
        <button className="btn small primary" onClick={onAdd}><Codicon name="add" /> Agregar…</button>
        <button className="btn small" onClick={() => all.forEach((b) => store.setEnabled(b.path, b.line, true))}>Activar todos</button>
        <button className="btn small" onClick={() => all.forEach((b) => store.setEnabled(b.path, b.line, false))}>Desactivar todos</button>
        <button className="btn small" onClick={() => store.removeAll()}><Codicon name="trash" /> Quitar todos</button>
      </div>
      {all.map((b) => (
        <div key={`${b.path}:${b.line}`} className="bp-row" onClick={() => onOpen(b)} title={b.message ?? b.path}>
          <input
            type="checkbox"
            checked={b.enabled}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => store.setEnabled(b.path, b.line, e.target.checked)}
          />
          <span className={"bp-dot" + (b.logMessage ? " log" : b.condition || b.hitCondition ? " cond" : "") + (!b.enabled ? " disabled" : b.verified === false ? " unverified" : "")} />
          <span>{basename(b.path)}</span>
          <span className="muted">línea {b.line}</span>
          {b.condition && <code className="bp-extra">si {b.condition}</code>}
          {b.hitCondition && <code className="bp-extra">vuelta ≥ {b.hitCondition}</code>}
          {b.logMessage && <code className="bp-extra log"><Codicon name="output" /> {b.logMessage}</code>}
          <span className="muted small bp-path">{relative(root, b.path)}</span>
          {b.verified === false && <span className="small warn-text">no colocado</span>}
          <span className="spacer" />
          <button className="icon-btn" title={"Editar — " + describeBreakpoint(b).replace(/\*/g, "")} onClick={(e) => { e.stopPropagation(); onEdit(b); }}>
            <Codicon name="edit" />
          </button>
          <button className="icon-btn" title="Quitar" onClick={(e) => { e.stopPropagation(); store.remove(b.path, b.line); }}>
            <Codicon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
