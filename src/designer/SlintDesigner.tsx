// Diseñador visual de archivos .slint (al estilo del diseñador de WPF).
//
// El archivo vive en un modelo de Monaco: el diseñador lo lee (parse), aplica
// cambios al modelo y lo reescribe (generate). Así la vista de código, guardar,
// deshacer y rust-analyzer siguen funcionando igual que con cualquier archivo.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { Codicon } from "../components/Icon";
import {
  allIds, clone, formatLength, generate, getAt, getProp, parse, parseLength, setProp, SlintParseError,
  type Doc, type Element, type Path, type Raw,
} from "./slintDoc";
import { WIDGETS, widgetDef, type Bindable, type EventDef, type EventParam } from "./widgets";
import WidgetPreview from "./WidgetPreview";
import PropertyPanel from "./PropertyPanel";

export interface DesignerHost {
  /** Crea `ui.on_<callback>(…)` en main.rs y lo abre. */
  createHandler: (slintPath: string, callback: string, params: EventParam[], label: string) => void;
  /** Abre main.rs en el manejador existente. */
  gotoHandler: (slintPath: string, callback: string) => void;
  openRustFile: (slintPath: string) => void;
}

interface Props extends DesignerHost {
  path: string;
  onShowCode: () => void;
}

type Rect = { x: number; y: number; w: number; h: number };
type DragKind = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
interface Drag { path: Path; kind: DragKind; startX: number; startY: number; start: Rect; rect: Rect; moved: boolean }

const DRAG_TYPE = "application/x-oxide-widget";
const GRID = 8;
const samePath = (a: Path | null, b: Path | null) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const RESERVED = new Set(["root", "parent", "self", "true", "false"]);

function rectOf(el: Element): Rect {
  const def = widgetDef(el.type);
  return {
    x: parseLength(getProp(el, "x")) ?? 0,
    y: parseLength(getProp(el, "y")) ?? 0,
    w: parseLength(getProp(el, "width")) ?? def?.size[0] ?? 100,
    h: parseLength(getProp(el, "height")) ?? def?.size[1] ?? 30,
  };
}

function windowSize(doc: Doc) {
  return {
    w: parseLength(getProp(doc.root, "width")) ?? 400,
    h: parseLength(getProp(doc.root, "height")) ?? 300,
  };
}

/** Declaraciones de la raíz: `in-out property … <=> id.prop;` y `callback …;` */
const isDecl = (it: Doc["root"]["items"][number]): it is Raw =>
  it.kind === "raw" && /^(in-out|in|out|private)?\s*(property|callback)\b/.test(it.text);

function insertDecl(root: Element, text: string) {
  let at = -1;
  root.items.forEach((it, i) => {
    if (isDecl(it)) at = i;
  });
  if (at < 0) root.items.forEach((it, i) => {
    if (it.kind === "prop") at = i;
  });
  root.items.splice(at + 1, 0, { kind: "raw", text });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default function SlintDesigner(p: Props) {
  const uri = useMemo(() => monaco.Uri.file(p.path), [p.path]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<{ message: string; line: number } | null>(null);
  const [sel, setSel] = useState<Path | null>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [dropHint, setDropHint] = useState(false);
  const applying = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const slintDir = p.path.replace(/[\\/][^\\/]*$/, "");

  // ---------- Leer el archivo y seguir sus cambios ----------
  const reparse = useCallback(() => {
    const model = monaco.editor.getModel(uri);
    if (!model) return;
    try {
      setDoc(parse(model.getValue()));
      setError(null);
    } catch (e) {
      if (e instanceof SlintParseError) {
        setError({ message: e.message, line: model.getPositionAt(e.offset).lineNumber });
      } else setError({ message: String(e), line: 1 });
    }
  }, [uri]);

  useEffect(() => {
    reparse();
    const model = monaco.editor.getModel(uri);
    const sub = model?.onDidChangeContent(() => {
      if (!applying.current) reparse();
    });
    return () => sub?.dispose();
  }, [uri, reparse]);

  // Si un deshacer o una edición dejó la selección apuntando a nada, volver a la ventana.
  useEffect(() => {
    if (doc && sel && sel.length && !getAt(doc.root, sel)) setSel([]);
  }, [doc, sel]);

  /** Aplica un cambio al documento y lo escribe en el modelo (con deshacer). */
  const commit = useCallback(
    (mutate: (d: Doc) => void) => {
      const model = monaco.editor.getModel(uri);
      if (!doc || !model) return;
      const next = clone(doc);
      mutate(next);
      const text = generate(next);
      if (text === model.getValue()) return;
      applying.current = true;
      model.pushStackElement();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      model.pushStackElement();
      applying.current = false;
      setDoc(parse(text));
    },
    [doc, uri],
  );

  const selected = doc && sel ? getAt(doc.root, sel) : null;
  const isRoot = !!sel && sel.length === 0;

  // ---------- Operaciones ----------

  const uniqueId = (d: Doc, base: string) => {
    const used = allIds(d.root);
    let n = 1;
    while (used.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  };

  /** Contenedores (ventana y paneles) con su posición absoluta, del más externo al más interno. */
  const containers = useCallback((d: Doc) => {
    const out: { path: Path; abs: Rect }[] = [{ path: [], abs: { x: 0, y: 0, ...(() => { const s = windowSize(d); return { w: s.w, h: s.h }; })() } }];
    const walk = (el: Element, path: Path, ox: number, oy: number) => {
      el.items.forEach((it, i) => {
        if (it.kind !== "element") return;
        const r = rectOf(it);
        const abs = { x: ox + r.x, y: oy + r.y, w: r.w, h: r.h };
        if (widgetDef(it.type)?.container) {
          out.push({ path: [...path, i], abs });
          walk(it, [...path, i], abs.x, abs.y);
        }
      });
    };
    walk(d.root, [], 0, 0);
    return out;
  }, []);

  const addWidget = (type: string, at?: { x: number; y: number }) => {
    const def = widgetDef(type);
    if (!doc || !def) return;
    let newPath: Path = [];
    commit((d) => {
      // Elegir el contenedor más interno bajo el punto.
      const point = at ?? { x: 24, y: 24 };
      const target = [...containers(d)].reverse().find((c) =>
        point.x >= c.abs.x && point.y >= c.abs.y && point.x <= c.abs.x + c.abs.w && point.y <= c.abs.y + c.abs.h,
      ) ?? { path: [], abs: { x: 0, y: 0, w: 0, h: 0 } };
      const parent = getAt(d.root, target.path)!;
      const sx = snap ? Math.round((point.x - target.abs.x) / GRID) * GRID : point.x - target.abs.x;
      const sy = snap ? Math.round((point.y - target.abs.y) / GRID) * GRID : point.y - target.abs.y;
      // Sin punto (clic en la caja de herramientas): escalonar para que no se encimen.
      const offset = at ? 0 : parent.items.filter((x) => x.kind === "element").length * 16;
      const el: Element = {
        kind: "element",
        type,
        id: uniqueId(d, def.idBase),
        items: [
          { kind: "prop", name: "x", value: formatLength(Math.max(0, sx + offset)) },
          { kind: "prop", name: "y", value: formatLength(Math.max(0, sy + offset)) },
          { kind: "prop", name: "width", value: formatLength(def.size[0]) },
          { kind: "prop", name: "height", value: formatLength(def.size[1]) },
          ...Object.entries(def.defaults).map(([name, value]) => ({ kind: "prop" as const, name, value })),
        ],
      };
      parent.items.push(el);
      newPath = [...target.path, parent.items.length - 1];
    });
    setSel(newPath);
    rootRef.current?.focus();
  };

  const removeSelected = () => {
    if (!sel || sel.length === 0 || !selected) return;
    const id = selected.id;
    commit((d) => {
      const parent = getAt(d.root, sel.slice(0, -1))!;
      parent.items.splice(sel[sel.length - 1], 1);
      // Quitar las propiedades expuestas a Rust que apuntaban a este control.
      if (id) {
        const re = new RegExp(`<=>\\s*${escapeRe(id)}\\.`);
        d.root.items = d.root.items.filter((it) => !(it.kind === "raw" && re.test(it.text)));
      }
    });
    setSel([]);
  };

  const duplicateSelected = () => {
    if (!sel || sel.length === 0 || !selected) return;
    let newPath: Path = [];
    commit((d) => {
      const parent = getAt(d.root, sel.slice(0, -1))!;
      const copy = clone(getAt(d.root, sel)!);
      const def = widgetDef(copy.type);
      copy.id = uniqueId(d, def?.idBase ?? copy.type.toLowerCase());
      copy.items = copy.items.filter((it) => it.kind !== "handler"); // los eventos no se copian
      const r = rectOf(copy);
      setProp(copy, "x", formatLength(r.x + 16));
      setProp(copy, "y", formatLength(r.y + 16));
      parent.items.splice(sel[sel.length - 1] + 1, 0, copy);
      newPath = [...sel.slice(0, -1), sel[sel.length - 1] + 1];
    });
    setSel(newPath);
  };

  const nudge = (dx: number, dy: number) => {
    if (!sel || sel.length === 0 || !selected) return;
    const r = rectOf(selected);
    commit((d) => {
      const el = getAt(d.root, sel)!;
      setProp(el, "x", formatLength(r.x + dx));
      setProp(el, "y", formatLength(r.y + dy));
    });
  };

  const setSelectedProp = (name: string, value: string | undefined) => {
    if (!sel) return;
    commit((d) => setProp(getAt(d.root, sel)!, name, value));
  };

  const rename = (newId: string): string | null => {
    if (!sel || !selected) return null;
    const id = newId.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return "Usa letras, números y _ (sin espacios).";
    if (RESERVED.has(id)) return "Ese nombre está reservado.";
    if (id !== selected.id && doc && allIds(doc.root).has(id)) return "Ya hay un control con ese nombre.";
    const old = selected.id;
    commit((d) => {
      getAt(d.root, sel)!.id = id;
      if (!old) return;
      // Actualizar las referencias `viejo.prop` en todo el documento.
      const re = new RegExp(`\\b${escapeRe(old)}\\.`, "g");
      const fix = (el: Element) => {
        for (const it of el.items) {
          if (it.kind === "prop") it.value = it.value.replace(re, `${id}.`);
          else if (it.kind === "raw") it.text = it.text.replace(re, `${id}.`);
          else if (it.kind === "handler") it.body = it.body.replace(re, `${id}.`);
          else fix(it);
        }
      };
      fix(d.root);
    });
    return null;
  };

  // ---------- Eventos (callbacks hacia Rust) ----------

  const eventCallback = (ev: EventDef): string | null => {
    const h = selected?.items.find((i) => i.kind === "handler" && i.name === ev.name);
    if (!h || h.kind !== "handler") return null;
    return h.body.match(/root\.([A-Za-z_][\w-]*)\s*\(/)?.[1]?.replace(/-/g, "_") ?? null;
  };

  const onEvent = (ev: EventDef) => {
    if (!sel || !selected?.id || !doc) return;
    const existing = eventCallback(ev);
    if (existing) return p.gotoHandler(p.path, existing);
    // Nombre único: boton1_clicked, boton1_clicked2…
    const declared = new Set(
      doc.root.items.flatMap((it) => (it.kind === "raw" ? [...it.text.matchAll(/callback\s+([\w-]+)/g)].map((m) => m[1]) : [])),
    );
    let cb = `${selected.id}_${ev.name}`;
    for (let n = 2; declared.has(cb); n++) cb = `${selected.id}_${ev.name}${n}`;
    const names = ev.params.map((x) => x.name).join(", ");
    commit((d) => {
      insertDecl(d.root, `callback ${cb}(${ev.params.map((x) => x.slint).join(", ")});`);
      const el = getAt(d.root, sel)!;
      el.items.push({
        kind: "handler",
        name: ev.name,
        params: ev.params.length ? `(${names})` : "",
        body: `root.${cb}(${names});`,
      });
    });
    p.createHandler(p.path, cb, ev.params, `${ev.label} — ${selected.id}`);
  };

  const exposeRe = (b: Bindable) =>
    selected?.id ? new RegExp(`property\\s*<[^>]+>\\s*([\\w-]+)\\s*<=>\\s*${escapeRe(selected.id)}\\.${escapeRe(b.prop)}\\s*;`) : null;

  const exposedName = (b: Bindable): string | null => {
    const re = exposeRe(b);
    if (!re || !doc) return null;
    for (const it of doc.root.items) {
      const m = it.kind === "raw" ? it.text.match(re) : null;
      if (m) return m[1].replace(/-/g, "_");
    }
    return null;
  };

  const toggleExpose = (b: Bindable) => {
    const re = exposeRe(b);
    if (!re || !selected?.id) return;
    const name = `${selected.id}_${b.prop.replace(/-/g, "_")}`;
    commit((d) => {
      const idx = d.root.items.findIndex((it) => it.kind === "raw" && re.test(it.text));
      if (idx >= 0) d.root.items.splice(idx, 1);
      else insertDecl(d.root, `in-out property <${b.slint}> ${name} <=> ${selected.id}.${b.prop};`);
    });
  };

  // ---------- Arrastrar y redimensionar ----------

  const startDrag = (e: React.PointerEvent, path: Path, kind: DragKind) => {
    if (e.button !== 0 || !doc) return;
    e.stopPropagation();
    e.preventDefault();
    rootRef.current?.focus();
    setSel(path);
    if (path.length === 0 && kind === "move") return;
    const el = path.length ? getAt(doc.root, path)! : null;
    const start = el ? rectOf(el) : { x: 0, y: 0, ...windowSize(doc) };
    setDrag({ path, kind, startX: e.clientX, startY: e.clientY, start, rect: start, moved: false });
    surfaceRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / zoom;
    const dy = (e.clientY - drag.startY) / zoom;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    const s = drag.start;
    const r = { ...s };
    const k = drag.kind;
    if (k === "move") { r.x = s.x + dx; r.y = s.y + dy; }
    if (k.includes("e")) r.w = s.w + dx;
    if (k.includes("s")) r.h = s.h + dy;
    if (k.includes("w")) { r.x = s.x + dx; r.w = s.w - dx; }
    if (k.includes("n")) { r.y = s.y + dy; r.h = s.h - dy; }
    const q = (v: number) => (snap && !e.altKey ? Math.round(v / GRID) * GRID : Math.round(v));
    const out = { x: q(r.x), y: q(r.y), w: Math.max(8, q(r.w)), h: Math.max(4, q(r.h)) };
    if (k === "move") { out.w = s.w; out.h = s.h; }
    setDrag({ ...drag, rect: out, moved: true });
  };

  const onPointerUp = () => {
    if (!drag) return;
    const { path, rect, moved, start } = drag;
    setDrag(null);
    if (!moved) return;
    commit((d) => {
      if (path.length === 0) {
        setProp(d.root, "width", formatLength(rect.w));
        setProp(d.root, "height", formatLength(rect.h));
        return;
      }
      const el = getAt(d.root, path)!;
      if (rect.x !== start.x || drag.kind === "move") setProp(el, "x", formatLength(rect.x));
      if (rect.y !== start.y || drag.kind === "move") setProp(el, "y", formatLength(rect.y));
      if (rect.w !== start.w) setProp(el, "width", formatLength(rect.w));
      if (rect.h !== start.h) setProp(el, "height", formatLength(rect.h));
    });
  };

  // ---------- Teclado ----------

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    const mod = e.metaKey || e.ctrlKey;
    // TextModel.undo/redo existen (usan el servicio de deshacer de Monaco) pero no están en los tipos públicos.
    const model = monaco.editor.getModel(uri) as (monaco.editor.ITextModel & { undo(): void; redo(): void }) | null;
    const step = e.shiftKey ? GRID : 1;
    let handled = true;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) model?.undo();
    else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) model?.redo();
    else if (mod && e.key.toLowerCase() === "d") duplicateSelected();
    else if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    else if (e.key === "ArrowLeft") nudge(-step, 0);
    else if (e.key === "ArrowRight") nudge(step, 0);
    else if (e.key === "ArrowUp") nudge(0, -step);
    else if (e.key === "ArrowDown") nudge(0, step);
    else if (e.key === "Escape") setSel(sel && sel.length ? sel.slice(0, -1) : []);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---------- Render ----------

  if (error) {
    return (
      <div className="designer-error">
        <Codicon name="warning" />
        <h3>El diseñador no puede mostrar este archivo</h3>
        <p>{error.message} <span className="muted">(línea {error.line})</span></p>
        <p className="muted small">Corrige el código y vuelve a la vista de diseño, o sigue editando como código.</p>
        <button className="btn primary" onClick={p.onShowCode}><Codicon name="code" /> Ver código</button>
      </div>
    );
  }
  if (!doc) return <div className="empty-editor"><Codicon name="loading" spin /></div>;

  const win = windowSize(doc);
  const winRect = drag && drag.path.length === 0 ? { w: drag.rect.w, h: drag.rect.h } : win;
  const title = getProp(doc.root, "title");
  const titleText = title ? title.replace(/^"|"$/g, "") : doc.name;

  const handles = (path: Path) =>
    (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as DragKind[]).map((k) => (
      <span key={k} className={`d-handle h-${k}`} onPointerDown={(e) => startDrag(e, path, k)} />
    ));

  const renderNode = (el: Element, path: Path): React.ReactNode => {
    const def = widgetDef(el.type);
    const isDragging = drag && samePath(drag.path, path);
    const r = isDragging ? drag.rect : rectOf(el);
    const isSel = samePath(sel, path);
    const hidden = getProp(el, "visible")?.trim() === "false";
    return (
      <div
        key={path.join("/")}
        className={"d-node" + (isSel ? " selected" : "") + (hidden ? " hidden" : "") + (def ? "" : " unknown")}
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        onPointerDown={(e) => startDrag(e, path, "move")}
        title={`${el.id ?? "(sin nombre)"} · ${el.type}`}
      >
        <WidgetPreview el={el} />
        {def?.container &&
          el.items.map((it, i) => (it.kind === "element" ? renderNode(it, [...path, i]) : null))}
        {isSel && handles(path)}
        {isSel && isDragging && <span className="d-size">{r.x}, {r.y} · {r.w}×{r.h}</span>}
      </div>
    );
  };

  const outline = (el: Element, path: Path, depth: number): React.ReactNode[] =>
    el.items.flatMap((it, i) => {
      if (it.kind !== "element") return [];
      const pth = [...path, i];
      const def = widgetDef(it.type);
      return [
        <div
          key={pth.join("/")}
          className={"outline-row" + (samePath(sel, pth) ? " selected" : "")}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => setSel(pth)}
        >
          <Codicon name={def?.icon ?? "symbol-misc"} />
          <span>{it.id ?? <em className="muted">{it.type}</em>}</span>
          {it.id && <span className="muted small">{it.type}</span>}
        </div>,
        ...outline(it, pth, depth + 1),
      ];
    });

  return (
    <div className="designer" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown}>
      {/* ----- Caja de herramientas + esquema ----- */}
      <div className="toolbox">
        <div className="panel-title"><span>CAJA DE HERRAMIENTAS</span></div>
        <div className="toolbox-list">
          {WIDGETS.map((w) => (
            <div
              key={w.type}
              className="tool-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, w.type);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => addWidget(w.type)}
              title="Arrastra al lienzo (o haz clic para agregar)"
            >
              <Codicon name={w.icon} />
              <span>{w.label}</span>
            </div>
          ))}
        </div>
        <div className="panel-title"><span>ESQUEMA</span></div>
        <div className="outline">
          <div className={"outline-row" + (isRoot ? " selected" : "")} style={{ paddingLeft: 10 }} onClick={() => setSel([])}>
            <Codicon name="window" />
            <span>{doc.name}</span>
            <span className="muted small">Window</span>
          </div>
          {outline(doc.root, [], 1)}
        </div>
      </div>

      {/* ----- Lienzo ----- */}
      <div className="canvas-wrap">
        <div className="canvas-bar">
          <span className="muted small">
            <Codicon name="info" /> Arrastra controles a la ventana · Supr borra · ⌘/Ctrl+D duplica · flechas mueven (Shift = {GRID}px)
          </span>
          <span className="spacer" />
          <label className="check-line small">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Ajustar a la cuadrícula
          </label>
          <select className="zoom" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          </select>
          <button className="btn small" onClick={() => p.openRustFile(p.path)} title="Abrir el código Rust (main.rs)">
            <Codicon name="file-code" /> main.rs
          </button>
        </div>
        <div
          className="canvas"
          ref={surfaceRef}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerDown={() => setSel(null)}
        >
          <div className="d-window" style={{ transform: `scale(${zoom})` }}>
            <div className="d-titlebar" onPointerDown={(e) => startDrag(e, [], "move")}>
              <span className="d-dots"><i /><i /><i /></span>
              <span>{titleText}</span>
            </div>
            <div
              className={"d-content" + (isRoot ? " selected" : "") + (dropHint ? " drop" : "")}
              style={{
                width: winRect.w,
                height: winRect.h,
                background: getProp(doc.root, "background")?.trim().match(/^#[0-9a-f]{3,8}$/i)?.[0] ?? undefined,
              }}
              onPointerDown={(e) => startDrag(e, [], "move")}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                setDropHint(true);
              }}
              onDragLeave={() => setDropHint(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDropHint(false);
                const type = e.dataTransfer.getData(DRAG_TYPE);
                const box = e.currentTarget.getBoundingClientRect();
                if (type) addWidget(type, { x: (e.clientX - box.left) / zoom, y: (e.clientY - box.top) / zoom });
              }}
            >
              {doc.root.items.map((it, i) => (it.kind === "element" ? renderNode(it, [i]) : null))}
              <span className="d-handle h-se window" onPointerDown={(e) => startDrag(e, [], "se")} title="Cambiar tamaño de la ventana" />
              {drag && drag.path.length === 0 && <span className="d-size">{winRect.w}×{winRect.h}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* ----- Propiedades ----- */}
      <div className="props-col">
        {selected ? (
          <PropertyPanel
            key={sel!.join("/")}
            el={selected}
            def={widgetDef(selected.type)}
            isRoot={isRoot}
            slintDir={slintDir}
            setProp={setSelectedProp}
            rename={rename}
            eventCallback={eventCallback}
            onEvent={onEvent}
            exposedName={exposedName}
            toggleExpose={toggleExpose}
            onDelete={removeSelected}
          />
        ) : (
          <div className="empty-state"><Codicon name="symbol-property" /><p>Selecciona un control</p></div>
        )}
      </div>
    </div>
  );
}

