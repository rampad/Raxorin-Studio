// Diseñador visual de archivos .slint (al estilo del diseñador de WPF).
//
// El archivo vive en un modelo de Monaco: el diseñador lo lee (parse), aplica
// cambios al modelo y lo reescribe (generate). Así la vista de código, guardar,
// deshacer y rust-analyzer siguen funcionando igual que con cualquier archivo.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { Codicon } from "../components/Icon";
import Splitter from "../components/Splitter";
import { PANELS, usePanelSize } from "../layout";
import {
  allIds, clone, formatLength, formatString, generate, getAt, getProp, parse, parseLength, parseNumber, parseString,
  setProp, SlintParseError,
  type Doc, type Element, type Path, type Raw,
} from "./slintDoc";
import {
  GRID_CHILD, LAYOUT_CHILD, WIDGETS, widgetDef, type Bindable, type EventDef, type EventParam, type LayoutKind, type WidgetDef,
} from "./widgets";
import * as Ops from "./designOps";
import type { CSSProperties } from "react";
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
interface Drag {
  path: Path; kind: DragKind; startX: number; startY: number; start: Rect; rect: Rect; moved: boolean;
  /** El control está dentro de un layout: no se mueve libremente, se reubica al soltar. */
  inLayout: boolean;
  /** Tamaño dibujado (para darle tamaño si sale de un layout) y dónde se lo agarró. */
  size: { w: number; h: number };
  grab: { x: number; y: number };
  target: Ops.DropTarget | null;
}
/** Marca de dónde caerá un control (línea entre hijos o recuadro), en coordenadas de pantalla. */
interface Indicator { left: number; top: number; width: number; height: number; box: boolean }

const DRAG_TYPE = "application/x-raxorin-widget";
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
  const toolboxSize = usePanelSize(PANELS.toolbox);
  const propsSize = usePanelSize(PANELS.properties);
  const uri = useMemo(() => monaco.Uri.file(p.path), [p.path]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<{ message: string; line: number } | null>(null);
  const [sel, setSel] = useState<Path | null>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [toolDrop, setToolDrop] = useState<{ target: Ops.DropTarget; indicator: Indicator | null } | null>(null);
  const [dragIndicator, setDragIndicator] = useState<Indicator | null>(null);
  // Pestaña visible de cada TabWidget (clave: ruta). Solo en el diseñador.
  const [activeTabs, setActiveTabs] = useState<Record<string, number>>({});
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

  // Si se selecciona algo dentro de una pestaña (p. ej. desde el esquema), mostrar esa pestaña.
  useEffect(() => {
    if (!doc || !sel) return;
    const changes: Record<string, number> = {};
    for (let i = 0; i < sel.length; i++) {
      const tw = getAt(doc.root, sel.slice(0, i));
      if (tw?.type !== "TabWidget") continue;
      const ord = Ops.elementChildren(tw).findIndex((k) => k.item === sel[i]);
      const key = sel.slice(0, i).join("/");
      if (ord >= 0 && activeTabs[key] !== ord) changes[key] = ord;
    }
    if (Object.keys(changes).length) setActiveTabs((a) => ({ ...a, ...changes }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, doc]);

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

  /** Tipo de layout del padre del control en `path` (undefined = posiciones fijas). */
  const parentLayout = (d: Doc, path: Path): LayoutKind | undefined => {
    if (!path.length) return undefined;
    const parent = getAt(d.root, path.slice(0, -1));
    return parent ? widgetDef(parent.type)?.layout : undefined;
  };

  /** Pestaña visible de un TabWidget: índice en sus pestañas. */
  const activeTabIndex = (tw: Element, key: string) => {
    const n = Ops.elementChildren(tw).length;
    const i = activeTabs[key] ?? Math.round(parseNumber(getProp(tw, "current-index")) ?? 0);
    return Math.min(Math.max(0, i), Math.max(0, n - 1));
  };

  /** Dónde agregar con un clic en la caja de herramientas: dentro del contenedor seleccionado o junto al control. */
  const defaultTarget = (d: Doc): Ops.DropTarget => {
    let path: Path = sel ?? [];
    let el = getAt(d.root, path);
    let after: number | null = null;
    if (el && path.length && !widgetDef(el.type)?.container) {
      after = Ops.elementChildren(getAt(d.root, path.slice(0, -1))!).findIndex((k) => k.item === path[path.length - 1]);
      path = path.slice(0, -1);
      el = getAt(d.root, path);
    }
    if (!el) return { kind: "abs", path: [], x: 24, y: 24 };
    const def = widgetDef(el.type);
    const kids = Ops.elementChildren(el);
    if (def?.layout === "tabs") {
      if (!kids.length) return { kind: "abs", path: [], x: 24, y: 24 };
      const tab = kids[activeTabIndex(el, path.join("/"))];
      return { kind: "abs", path: [...path, tab.item], x: 16 + Ops.elementChildren(tab.el).length * 16, y: 16 + Ops.elementChildren(tab.el).length * 16 };
    }
    if (def?.layout === "grid") {
      const cells = Ops.gridCells(kids.map((k) => k.el));
      const last = cells[cells.length - 1];
      return { kind: "grid", path, row: last?.row ?? 0, col: 0 };
    }
    if (def?.layout) return { kind: "flow", path, index: after !== null ? after + 1 : kids.length };
    const n = kids.length * 16;
    return { kind: "abs", path, x: 24 + n, y: 24 + n };
  };

  const addWidget = (type: string, target?: Ops.DropTarget) => {
    const def = widgetDef(type);
    if (!doc || !def) return;
    let newPath: Path = [];
    commit((d) => {
      let t = target ?? defaultTarget(d);
      if (t.kind === "abs" && snap) t = { ...t, x: Math.round(t.x / GRID) * GRID, y: Math.round(t.y / GRID) * GRID };
      const el = Ops.fromTemplate({ type });
      el.id = uniqueId(d, def.idBase);
      newPath = Ops.addElement(d.root, el, t, { w: def.size[0], h: def.size[1] });
    });
    setSel(newPath);
    rootRef.current?.focus();
  };

  /** Agrega una pestaña al TabWidget seleccionado (o al que contiene la pestaña seleccionada). */
  const addTab = () => {
    if (!doc || !sel) return;
    const isTw = (p: Path) => getAt(doc.root, p)?.type === "TabWidget";
    const twPath = isTw(sel) ? sel : sel.length && isTw(sel.slice(0, -1)) ? sel.slice(0, -1) : null;
    if (!twPath) return;
    let newPath: Path = [];
    commit((d) => {
      const tw = getAt(d.root, twPath)!;
      const n = Ops.elementChildren(tw).length + 1;
      const tab = Ops.fromTemplate({ type: "Tab", props: { title: formatString(`Pestaña ${n}`) } });
      tw.items.push(tab);
      newPath = Ops.findPath(d.root, tab)!;
    });
    setActiveTabs((a) => ({ ...a, [twPath.join("/")]: Ops.elementChildren(getAt(doc.root, twPath)!).length }));
    setSel(newPath);
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
      if (getProp(copy, "x") !== undefined || getProp(copy, "y") !== undefined) {
        const r = rectOf(copy);
        setProp(copy, "x", formatLength(r.x + 16));
        setProp(copy, "y", formatLength(r.y + 16));
      }
      // En una cuadrícula, la copia va a la siguiente celda libre.
      if (widgetDef(parent.type)?.layout === "grid") {
        Ops.materializeGrid(parent);
        const cell = Ops.freeCell(parent, parseNumber(getProp(copy, "row")) ?? 0, parseNumber(getProp(copy, "col")) ?? 0);
        setProp(copy, "row", String(cell.row));
        setProp(copy, "col", String(cell.col));
      }
      parent.items.splice(sel[sel.length - 1] + 1, 0, copy);
      newPath = [...sel.slice(0, -1), sel[sel.length - 1] + 1];
    });
    setSel(newPath);
  };

  const nudge = (dx: number, dy: number) => {
    if (!sel || sel.length === 0 || !selected || !doc) return;
    const kind = parentLayout(doc, sel);
    if (kind === "tabs") return;
    if (kind === "grid") {
      // En la cuadrícula, las flechas cambian de celda.
      commit((d) => {
        const parent = getAt(d.root, sel.slice(0, -1))!;
        Ops.materializeGrid(parent);
        const el = getAt(d.root, sel)!;
        setProp(el, "col", String(Math.max(0, (parseNumber(getProp(el, "col")) ?? 0) + Math.sign(dx))));
        setProp(el, "row", String(Math.max(0, (parseNumber(getProp(el, "row")) ?? 0) + Math.sign(dy))));
      });
      return;
    }
    if (kind) {
      // En una fila o columna, las flechas cambian el orden.
      let np: Path | null = null;
      commit((d) => {
        np = Ops.reorder(d.root, sel, Math.sign(dx + dy));
      });
      if (np) setSel(np);
      return;
    }
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

  /**
   * Busca el contenedor bajo el puntero (el más interno) y calcula dónde caería el control:
   * posición en un contenedor fijo, lugar entre los hijos de un layout o celda de una cuadrícula.
   */
  const findTarget = (cx: number, cy: number, exclude?: Path): { target: Ops.DropTarget; indicator: Indicator | null } | null => {
    for (const node of document.elementsFromPoint(cx, cy) as HTMLElement[]) {
      const raw = node.dataset?.drop;
      if (raw === undefined) continue;
      const path = raw ? raw.split("/").map(Number) : [];
      if (exclude?.length && path.length >= exclude.length && exclude.every((v, i) => path[i] === v)) continue;
      const kind = node.dataset.kind as "abs" | LayoutKind;
      const box = node.getBoundingClientRect();
      if (kind === "abs") return { target: { kind: "abs", path, x: (cx - box.left) / zoom, y: (cy - box.top) / zoom }, indicator: null };
      const kids = [...node.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.path !== undefined);
      const rects = kids.map((k) => k.getBoundingClientRect());
      if (kind === "grid") {
        const cells = kids.map((k) => ({ row: Number(k.dataset.row), col: Number(k.dataset.col) }));
        const cols = Math.max(1, ...cells.map((c) => c.col + 1));
        const rows = Math.max(1, ...cells.map((c) => c.row + 1));
        const right = rects.length ? Math.max(...rects.map((r) => r.right)) : box.left;
        const bottom = rects.length ? Math.max(...rects.map((r) => r.bottom)) : box.top;
        // A la derecha o debajo de todo: columna o fila nueva.
        const col = cx > right ? cols : Math.min(cols - 1, Math.floor(((cx - box.left) / Math.max(1, right - box.left)) * cols));
        const row = cy > bottom ? rows : Math.min(rows - 1, Math.floor(((cy - box.top) / Math.max(1, bottom - box.top)) * rows));
        const cw = (right - box.left) / cols || 60;
        const rh = (bottom - box.top) / rows || 30;
        return {
          target: { kind: "grid", path, row: Math.max(0, row), col: Math.max(0, col) },
          indicator: { left: box.left + Math.max(0, col) * cw, top: box.top + Math.max(0, row) * rh, width: Math.max(cw, 24), height: Math.max(rh, 20), box: true },
        };
      }
      const horizontal = kind === "horizontal" || kind === "group";
      let index = 0;
      rects.forEach((r) => {
        if (horizontal ? cx > r.left + r.width / 2 : cy > r.top + r.height / 2) index++;
      });
      const pad = 3;
      let indicator: Indicator;
      if (!rects.length) indicator = { left: box.left + pad, top: box.top + pad, width: box.width - 2 * pad, height: box.height - 2 * pad, box: true };
      else if (horizontal) {
        const x = index < rects.length ? rects[index].left - pad : rects[rects.length - 1].right + pad - 2;
        const ref = rects[Math.min(index, rects.length - 1)];
        indicator = { left: x, top: ref.top, width: 2, height: ref.height, box: false };
      } else {
        const y = index < rects.length ? rects[index].top - pad : rects[rects.length - 1].bottom + pad - 2;
        const ref = rects[Math.min(index, rects.length - 1)];
        indicator = { left: ref.left, top: y, width: ref.width, height: 2, box: false };
      }
      return { target: { kind: "flow", path, index }, indicator };
    }
    return null;
  };

  const startDrag = (e: React.PointerEvent, path: Path, kind: DragKind, nodeEl?: HTMLElement | null) => {
    if (e.button !== 0 || !doc) return;
    e.stopPropagation();
    e.preventDefault();
    rootRef.current?.focus();
    setSel(path);
    if (path.length === 0 && kind === "move") return;
    const layout = parentLayout(doc, path);
    if (layout === "tabs") return; // las pestañas no se mueven
    const el = path.length ? getAt(doc.root, path)! : null;
    const node = nodeEl ?? ((e.currentTarget as HTMLElement).closest("[data-path]") as HTMLElement | null);
    const box = node?.getBoundingClientRect();
    const drawn = box ? { w: Math.round(box.width / zoom), h: Math.round(box.height / zoom) } : { w: 100, h: 30 };
    const inLayout = !!layout;
    const start = inLayout ? { x: 0, y: 0, ...drawn } : el ? rectOf(el) : { x: 0, y: 0, ...windowSize(doc) };
    setDrag({
      path, kind, startX: e.clientX, startY: e.clientY, start, rect: start, moved: false, inLayout, size: drawn,
      grab: box ? { x: (e.clientX - box.left) / zoom, y: (e.clientY - box.top) / zoom } : { x: 0, y: 0 },
      target: null,
    });
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
    let target: Ops.DropTarget | null = null;
    if (k === "move") {
      const found = findTarget(e.clientX, e.clientY, drag.path);
      target = found?.target ?? null;
      const sameAbs = target?.kind === "abs" && samePath(target.path, drag.path.slice(0, -1)) && !drag.inLayout;
      // Recuadro fantasma cuando el control cambia a otro contenedor con posiciones fijas.
      setDragIndicator(
        sameAbs || !found ? null
          : found.indicator ?? {
              left: e.clientX - drag.grab.x * zoom, top: e.clientY - drag.grab.y * zoom,
              width: drag.size.w * zoom, height: drag.size.h * zoom, box: true,
            },
      );
    }
    setDrag({ ...drag, rect: out, moved: true, target });
  };

  const onPointerUp = () => {
    if (!drag) return;
    const { path, rect, moved, start, target } = drag;
    setDrag(null);
    setDragIndicator(null);
    if (!moved) return;
    const parentPath = path.slice(0, -1);
    if (drag.kind === "move" && path.length) {
      if (!target) return; // soltado fuera de la ventana: no cambia
      const sameAbs = target.kind === "abs" && samePath(target.path, parentPath) && !drag.inLayout;
      if (!sameAbs) {
        let t = target;
        if (t.kind === "abs") {
          const x = t.x - drag.grab.x, y = t.y - drag.grab.y;
          t = { ...t, x: snap ? Math.round(x / GRID) * GRID : Math.round(x), y: snap ? Math.round(y / GRID) * GRID : Math.round(y) };
        }
        let np: Path | null = null;
        commit((d) => {
          np = Ops.moveElement(d.root, path, t, drag.size);
        });
        if (np) setSel(np);
        return;
      }
    }
    commit((d) => {
      if (path.length === 0) {
        setProp(d.root, "width", formatLength(rect.w));
        setProp(d.root, "height", formatLength(rect.h));
        return;
      }
      const el = getAt(d.root, path)!;
      if (drag.inLayout) {
        // Dentro de un layout solo se fija el tamaño.
        if (rect.w !== start.w) setProp(el, "width", formatLength(rect.w));
        if (rect.h !== start.h) setProp(el, "height", formatLength(rect.h));
        return;
      }
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

  /** Dentro de un layout no hay x/y: se muestran ancho/alto opcionales y cuánto crece. */
  const panelDef = (el: Element, path: Path): WidgetDef | undefined => {
    const def = widgetDef(el.type);
    const kind = parentLayout(doc, path);
    if (!def || !kind || kind === "tabs") return def;
    const own = def.props.filter((x) => !["x", "y", "width", "height"].includes(x.name));
    return { ...def, props: [...LAYOUT_CHILD, ...(kind === "grid" ? GRID_CHILD : []), ...own] };
  };
  /** Cambia cómo se acomoda el contenido del GroupBox seleccionado, conservando lo que se ve. */
  const changeGroupMode = (mode: Ops.GroupMode) => {
    if (!sel || !doc) return;
    // Posición dibujada de cada control, relativa al contenido del grupo.
    const innerInfo = Ops.groupInner(getAt(doc.root, sel)!);
    const innerPath = innerInfo ? [...sel, innerInfo.item] : sel;
    const innerNode = document.querySelector(`[data-path="${innerPath.join("/")}"]`) as HTMLElement | null;
    const base = innerNode?.getBoundingClientRect();
    const rects = new Map<string, Ops.Rect>();
    if (base) {
      Ops.elementChildren(getAt(doc.root, innerPath)!).forEach((k) => {
        const n = document.querySelector(`[data-path="${[...innerPath, k.item].join("/")}"]`) as HTMLElement | null;
        const r = n?.getBoundingClientRect();
        if (r) rects.set(String(k.item), {
          x: Math.round((r.left - base.left) / zoom), y: Math.round((r.top - base.top) / zoom),
          w: Math.round(r.width / zoom), h: Math.round(r.height / zoom),
        });
      });
    }
    commit((d) => {
      const group = getAt(d.root, sel)!;
      const src = getAt(d.root, innerPath)!;
      const byEl = new Map(Ops.elementChildren(src).map((k) => [k.el, rects.get(String(k.item)) ?? null]));
      Ops.setGroupMode(group, mode, (c) => byEl.get(c) ?? null);
    });
  };
  const groupMode = selected?.type === "GroupBox" ? Ops.groupInner(selected)?.mode ?? null : null;
  const groupExtra = selected?.type === "GroupBox" ? (
    <section>
      <h5>Contenido del grupo</h5>
      <div className="segmented small">
        {([["free", "Libre", "move"], ["vertical", "Columna", "split-vertical"], ["horizontal", "Fila", "split-horizontal"]] as const).map(([m, label, icon]) => (
          <button key={m} type="button" className={groupMode === m ? "active" : ""} onClick={() => changeGroupMode(m)}>
            <Codicon name={icon} /> {label}
          </button>
        ))}
      </div>
      <p className="muted small">
        {groupMode === "free"
          ? "Los controles se mueven libremente dentro del grupo."
          : groupMode
            ? "Los controles se acomodan solos. Cambia a “Libre” para moverlos a mano (se quedan donde están)."
            : "El contenido no es un panel ni un layout simple: edítalo en la vista de código o elige un modo."}
      </p>
    </section>
  ) : null;
  const selIsTabs = !!selected && (selected.type === "TabWidget" || selected.type === "Tab");
  const tabExtra = selIsTabs ? (
    <section>
      <h5>Pestañas</h5>
      <p className="muted small">
        {selected!.type === "Tab"
          ? "Esta es una pestaña: arrastra controles a su contenido. Cambia de pestaña con un clic en su título."
          : "Haz clic en el título de una pestaña para verla y editarla."}
      </p>
      <button className="btn small" onClick={addTab}>
        <Codicon name="add" /> Agregar pestaña
      </button>
    </section>
  ) : null;

  const win = windowSize(doc);
  const winRect = drag && drag.path.length === 0 ? { w: drag.rect.w, h: drag.rect.h } : win;
  const title = getProp(doc.root, "title");
  const titleText = title ? title.replace(/^"|"$/g, "") : doc.name;

  const handles = (path: Path, inLayout: boolean) =>
    ((inLayout ? ["e", "se", "s"] : ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) as DragKind[]).map((k) => (
      <span key={k} className={`d-handle h-${k}`} onPointerDown={(e) => startDrag(e, path, k)} />
    ));

  /** Estilo de un control dentro de un layout: imita cómo Slint reparte el espacio. */
  const flowStyle = (el: Element, def: WidgetDef | undefined, kind: LayoutKind, parent: Element, cell: Ops.Cell | undefined, override: Rect | null): CSSProperties => {
    const stretchH = parseNumber(getProp(el, "horizontal-stretch")) ?? def?.stretch?.[0] ?? 1;
    const stretchV = parseNumber(getProp(el, "vertical-stretch")) ?? def?.stretch?.[1] ?? 1;
    const w = override?.w ?? parseLength(getProp(el, "width"));
    const h = override?.h ?? parseLength(getProp(el, "height"));
    const pw = def?.size[0] ?? 100;
    const ph = def?.size[1] ?? 30;
    const stretchAlign = (getProp(parent, "alignment")?.trim() ?? "stretch") === "stretch";
    const base: CSSProperties = { position: "relative", minWidth: 0, minHeight: 0 };
    if (kind === "grid" && cell) {
      return {
        ...base,
        gridRow: `${cell.row + 1} / span ${cell.rowspan}`,
        gridColumn: `${cell.col + 1} / span ${cell.colspan}`,
        width: w ?? undefined,
        height: h ?? (stretchV > 0 ? undefined : ph),
        justifySelf: w !== null ? "start" : "stretch",
        alignSelf: h !== null || stretchV === 0 ? "start" : "stretch",
      };
    }
    if (kind === "vertical") {
      return {
        ...base,
        flex: h !== null ? `0 0 ${h}px` : stretchAlign && stretchV > 0 ? `${stretchV} 1 ${Math.min(ph, 60)}px` : `0 0 ${ph}px`,
        width: w ?? undefined,
        alignSelf: w !== null ? "flex-start" : "stretch",
      };
    }
    return {
      ...base,
      flex: w !== null ? `0 0 ${w}px` : stretchAlign && stretchH > 0 ? `${stretchH} 1 ${Math.min(pw, 120)}px` : `0 0 ${pw}px`,
      height: h ?? undefined,
      alignSelf: h !== null ? "flex-start" : "stretch",
    };
  };

  /** Contenido de un layout (VerticalBox, HorizontalBox, GridBox o el interior de un GroupBox). */
  const renderLayout = (el: Element, path: Path, kind: LayoutKind) => {
    const key = path.join("/");
    const isBox = el.type.endsWith("Box") && el.type !== "GroupBox";
    const padding = kind === "group" ? parseLength(getProp(el, "content-padding")) ?? 0 : parseLength(getProp(el, "padding")) ?? (isBox ? 8 : 0);
    const gap = kind === "group" ? 0 : parseLength(getProp(el, "spacing")) ?? (isBox ? 8 : 0);
    const align = getProp(el, "alignment")?.trim() ?? "stretch";
    const kids = Ops.elementChildren(el);
    const cells = kind === "grid" ? Ops.gridCells(kids.map((k) => k.el)) : undefined;
    const justify: Record<string, CSSProperties["justifyContent"]> = {
      stretch: "flex-start", start: "flex-start", center: "center", end: "flex-end",
      "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly",
    };
    let style: CSSProperties = { padding, gap };
    if (kind === "grid") {
      const cols = Math.max(1, ...(cells ?? []).map((c) => c.col + c.colspan));
      const rows = Math.max(1, ...(cells ?? []).map((c) => c.row + c.rowspan));
      const rowSizes = Array.from({ length: rows }, (_, r) =>
        kids.some((k, i) => cells![i].row === r && (parseNumber(getProp(k.el, "vertical-stretch")) ?? widgetDef(k.el.type)?.stretch?.[1] ?? 1) > 0)
          ? "minmax(0, 1fr)" : "auto");
      style = { ...style, display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: rowSizes.join(" "), alignContent: "start" };
    } else {
      style = { ...style, display: "flex", flexDirection: kind === "vertical" ? "column" : "row", justifyContent: justify[align] ?? "flex-start" };
    }
    return (
      <div className="d-layout" data-drop={key} data-kind={kind} style={style}>
        {kids.map((k, i) => renderNode(k.el, [...path, k.item], kind, el, cells?.[i]))}
        {!kids.length && (
          <div className="d-empty">
            <Codicon name="add" /> Suelta controles aquí
          </div>
        )}
      </div>
    );
  };

  const renderNode = (el: Element, path: Path, parentKind?: LayoutKind, parent?: Element, cell?: Ops.Cell): React.ReactNode => {
    const def = widgetDef(el.type);
    const key = path.join("/");
    const isDragging = !!drag && samePath(drag.path, path);
    const isSel = samePath(sel, path);
    const hidden = getProp(el, "visible")?.trim() === "false";
    const isTabPage = parentKind === "tabs";
    const inFlow = !!parentKind && !isTabPage;
    let style: CSSProperties;
    if (isTabPage) style = { position: "absolute", inset: 0 };
    else if (inFlow) style = flowStyle(el, def, parentKind!, parent!, cell, isDragging && drag!.kind !== "move" ? drag!.rect : null);
    else {
      const r = isDragging ? drag!.rect : rectOf(el);
      style = { left: r.x, top: r.y, width: r.w, height: r.h };
    }
    const absContainer = !!def?.container && !def.layout;
    // Panel interno (sin nombre) de un GroupBox: su fondo pertenece al grupo.
    const groupContent = parentKind === "group" && !el.id && !!def?.container;

    let body: React.ReactNode;
    if (def?.layout === "vertical" || def?.layout === "horizontal" || def?.layout === "grid") {
      body = (
        <>
          <div className="d-frame" />
          {renderLayout(el, path, def.layout)}
        </>
      );
    } else if (def?.layout === "group") {
      const title = parseString(getProp(el, "title")) ?? "";
      body = (
        <>
          <div className="d-frame" />
          <div className="d-group">
            {title && <div className="d-group-title">{title}</div>}
            {renderLayout(el, path, "group")}
          </div>
        </>
      );
    } else if (def?.layout === "tabs") {
      const tabs = Ops.elementChildren(el);
      const active = activeTabIndex(el, key);
      body = (
        <>
          <div className="d-frame" />
          <div className="d-tabs">
            <div className="d-tabs-head">
              {tabs.map((t, i) => (
                <button
                  key={t.item}
                  className={i === active ? "active" : ""}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setActiveTabs((a) => ({ ...a, [key]: i }));
                    setSel([...path, t.item]);
                    rootRef.current?.focus();
                  }}
                >
                  {parseString(getProp(t.el, "title")) ?? `Pestaña ${i + 1}`}
                </button>
              ))}
              {isSel && (
                <button className="add" title="Agregar pestaña" onPointerDown={(e) => { e.stopPropagation(); addTab(); }}>
                  <Codicon name="add" />
                </button>
              )}
            </div>
            <div className="d-tabs-content">
              {tabs[active] && renderNode(tabs[active].el, [...path, tabs[active].item], "tabs", el)}
            </div>
          </div>
        </>
      );
    } else {
      body = (
        <>
          <WidgetPreview el={el} />
          {absContainer && el.items.map((it, i) => (it.kind === "element" ? renderNode(it, [...path, i]) : null))}
        </>
      );
    }

    return (
      <div
        key={key}
        data-path={key}
        data-drop={absContainer ? key : undefined}
        data-kind={absContainer ? "abs" : undefined}
        data-row={cell?.row}
        data-col={cell?.col}
        className={
          "d-node" + (inFlow ? " in-layout" : "") + (isTabPage || groupContent ? " d-tab-page" : "") + (isSel ? " selected" : "") +
          (hidden ? " hidden" : "") + (def ? "" : " unknown") + (isDragging && drag!.kind === "move" && drag!.inLayout ? " drag-source" : "")
        }
        style={style}
        onPointerDown={(e) => {
          if (isTabPage) {
            // Clic en el fondo de una pestaña: seleccionarla.
            e.stopPropagation();
            setSel(path);
            rootRef.current?.focus();
          } else if (groupContent && !isSel) {
            // Clic en el fondo del grupo: seleccionar y mover el GroupBox.
            const groupNode = (e.currentTarget as HTMLElement).parentElement?.closest("[data-path]") as HTMLElement | null;
            startDrag(e, path.slice(0, -1), "move", groupNode);
          } else startDrag(e, path, "move");
        }}
        title={`${el.id ?? "(sin nombre)"} · ${el.type}`}
      >
        {body}
        {isSel && !isTabPage && !groupContent && handles(path, inFlow)}
        {isSel && isDragging && drag!.kind !== "move" && <span className="d-size">{inFlow ? "" : `${style.left}, ${style.top} · `}{drag!.rect.w}×{drag!.rect.h}</span>}
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
      <div className="toolbox" style={{ width: toolboxSize.size }}>
        <div className="panel-title"><span>CAJA DE HERRAMIENTAS</span></div>
        <div className="toolbox-list">
          {(["common", "containers"] as const).flatMap((cat) => [
            <div key={cat} className="toolbox-group">{cat === "common" ? "Controles" : "Contenedores y layouts"}</div>,
            ...WIDGETS.filter((w) => w.category === cat).map((w) => (
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
          )),
          ])}
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

      <Splitter spec={PANELS.toolbox} panel="before" size={toolboxSize.size} onResize={toolboxSize.set} onReset={toolboxSize.reset} />
      {/* ----- Lienzo ----- */}
      <div className="canvas-wrap">
        <div className="canvas-bar">
          <span className="muted small">
            <Codicon name="info" /> Arrastra controles a la ventana o a un layout · Supr borra · ⌘/Ctrl+D duplica · flechas mueven (en un layout: cambian el orden)
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
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            const found = findTarget(e.clientX, e.clientY);
            if (!found) return setToolDrop(null);
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setToolDrop(found);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setToolDrop(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData(DRAG_TYPE);
            const found = findTarget(e.clientX, e.clientY);
            setToolDrop(null);
            if (type && found) addWidget(type, found.target);
          }}
        >
          <div className="d-window" style={{ transform: `scale(${zoom})` }}>
            <div className="d-titlebar" onPointerDown={(e) => startDrag(e, [], "move")}>
              <span className="d-dots"><i /><i /><i /></span>
              <span>{titleText}</span>
            </div>
            <div
              data-drop=""
              data-kind="abs"
              className={"d-content" + (isRoot ? " selected" : "") + (toolDrop?.target.kind === "abs" && toolDrop.target.path.length === 0 ? " drop" : "")}
              style={{
                width: winRect.w,
                height: winRect.h,
                background: getProp(doc.root, "background")?.trim().match(/^#[0-9a-f]{3,8}$/i)?.[0] ?? undefined,
              }}
              onPointerDown={(e) => startDrag(e, [], "move")}
            >
              {doc.root.items.map((it, i) => (it.kind === "element" ? renderNode(it, [i]) : null))}
              <span className="d-handle h-se window" onPointerDown={(e) => startDrag(e, [], "se")} title="Cambiar tamaño de la ventana" />
              {drag && drag.path.length === 0 && <span className="d-size">{winRect.w}×{winRect.h}</span>}
            </div>
          </div>
          {(dragIndicator ?? toolDrop?.indicator) && (
            <div
              className={"d-indicator" + ((dragIndicator ?? toolDrop!.indicator)!.box ? " box" : "")}
              style={(() => {
                const i = (dragIndicator ?? toolDrop!.indicator)!;
                return { left: i.left, top: i.top, width: i.width, height: i.height };
              })()}
            />
          )}
        </div>
      </div>

      {/* ----- Propiedades ----- */}
      <Splitter spec={PANELS.properties} panel="after" size={propsSize.size} onResize={propsSize.set} onReset={propsSize.reset} />
      <div className="props-col" style={{ width: propsSize.size }}>
        {selected ? (
          <PropertyPanel
            key={sel!.join("/")}
            el={selected}
            def={panelDef(selected, sel!)}
            extra={tabExtra ?? groupExtra}
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

