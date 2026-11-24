// Operaciones sobre el árbol de controles del diseñador: insertar y mover controles
// entre contenedores con posición fija y layouts automáticos (VerticalBox, GridBox…).
// Funciones puras sobre el documento (se prueban en tests/designer.test.ts).

import { formatLength, getAt, getProp, parseLength, parseNumber, setProp, type Element, type Path } from "./slintDoc.ts";
import { widgetDef, type ChildTemplate } from "./widgets.ts";

/** Dónde cae un control. */
export type DropTarget =
  /** Contenedor con posiciones fijas: coordenadas dentro del contenedor. */
  | { kind: "abs"; path: Path; x: number; y: number }
  /** Layout en fila o columna (y GroupBox): posición entre los hijos. */
  | { kind: "flow"; path: Path; index: number }
  /** Cuadrícula: celda. */
  | { kind: "grid"; path: Path; row: number; col: number };

const GEOMETRY = ["x", "y", "width", "height"];
const GRID_PROPS = ["row", "col", "rowspan", "colspan"];

/** Hijos que son controles, con su índice en `items`. */
export function elementChildren(el: Element): { el: Element; item: number }[] {
  const out: { el: Element; item: number }[] = [];
  el.items.forEach((it, i) => {
    if (it.kind === "element") out.push({ el: it, item: i });
  });
  return out;
}

/** Inserta `child` como el control número `ordinal` (al final si se pasa). */
export function insertAtOrdinal(parent: Element, child: Element, ordinal: number) {
  const kids = elementChildren(parent);
  if (ordinal >= kids.length) parent.items.push(child);
  else parent.items.splice(kids[Math.max(0, ordinal)].item, 0, child);
}

export function findPath(root: Element, target: Element): Path | null {
  if (root === target) return [];
  for (let i = 0; i < root.items.length; i++) {
    const it = root.items[i];
    if (it.kind !== "element") continue;
    const sub = findPath(it, target);
    if (sub) return [i, ...sub];
  }
  return null;
}

export interface Cell { row: number; col: number; rowspan: number; colspan: number }

const intProp = (el: Element, name: string) => {
  const n = parseNumber(getProp(el, name));
  return n === null ? null : Math.max(0, Math.round(n));
};

/**
 * Celdas de los hijos de una cuadrícula, como las asigna Slint: `row` reinicia la
 * columna a 0; sin `col`, el control va a la derecha del anterior.
 */
export function gridCells(children: Element[]): Cell[] {
  let row = 0;
  let nextCol = 0;
  return children.map((el) => {
    const r = intProp(el, "row");
    const c = intProp(el, "col");
    if (r !== null) {
      row = r;
      nextCol = 0;
    }
    const col = c ?? nextCol;
    const colspan = Math.max(1, intProp(el, "colspan") ?? 1);
    const rowspan = Math.max(1, intProp(el, "rowspan") ?? 1);
    nextCol = col + colspan;
    return { row, col, rowspan, colspan };
  });
}

/** Escribe `row`/`col` explícitos en todos los hijos (para poder insertar sin mover a los demás). */
export function materializeGrid(grid: Element) {
  const kids = elementChildren(grid).map((k) => k.el);
  gridCells(kids).forEach((c, i) => {
    setProp(kids[i], "row", String(c.row));
    setProp(kids[i], "col", String(c.col));
  });
}

/** Celda libre más parecida a la pedida: si está ocupada, a la derecha del último de esa fila. */
export function freeCell(grid: Element, row: number, col: number): { row: number; col: number } {
  const cells = gridCells(elementChildren(grid).map((k) => k.el));
  const taken = (r: number, c: number) =>
    cells.some((x) => r >= x.row && r < x.row + x.rowspan && c >= x.col && c < x.col + x.colspan);
  if (!taken(row, col)) return { row, col };
  let c = col;
  while (taken(row, c)) c++;
  return { row, col: c };
}

const hasGeometry = (el: Element) => getProp(el, "x") !== undefined || getProp(el, "y") !== undefined;

/** Coloca `el` en `dest` según el destino. `sameParentOld` = ordinal anterior si se mueve dentro del mismo padre. */
function place(dest: Element, el: Element, t: DropTarget, size: { w: number; h: number }, sameParentOld: number) {
  if (t.kind !== "grid") for (const p of GRID_PROPS) setProp(el, p, undefined);
  if (t.kind === "abs") {
    setProp(el, "x", formatLength(Math.max(0, t.x)));
    setProp(el, "y", formatLength(Math.max(0, t.y)));
    if (getProp(el, "width") === undefined) setProp(el, "width", formatLength(size.w));
    if (getProp(el, "height") === undefined) setProp(el, "height", formatLength(size.h));
    dest.items.push(el);
    return;
  }
  // En un layout no hay x/y; y si venía de una posición fija, que el layout decida el tamaño.
  if (hasGeometry(el)) for (const p of GEOMETRY) setProp(el, p, undefined);
  if (t.kind === "flow") {
    const index = sameParentOld >= 0 && sameParentOld < t.index ? t.index - 1 : t.index;
    insertAtOrdinal(dest, el, index);
    return;
  }
  materializeGrid(dest);
  const cell = freeCell(dest, t.row, t.col);
  setProp(el, "row", String(cell.row));
  setProp(el, "col", String(cell.col));
  dest.items.push(el);
}

/** Agrega un control nuevo y devuelve su ruta. */
export function addElement(root: Element, el: Element, t: DropTarget, size: { w: number; h: number }): Path {
  const dest = getAt(root, t.path);
  if (!dest) throw new Error("Destino inexistente");
  place(dest, el, t, size, -1);
  return findPath(root, el)!;
}

/** Mueve el control en `from` al destino y devuelve su nueva ruta (null si no se puede). */
export function moveElement(root: Element, from: Path, t: DropTarget, size: { w: number; h: number }): Path | null {
  if (!from.length) return null;
  // No se puede meter un control dentro de sí mismo.
  if (t.path.length >= from.length && from.every((v, i) => t.path[i] === v)) return null;
  const parent = getAt(root, from.slice(0, -1));
  const dest = getAt(root, t.path);
  const itemIdx = from[from.length - 1];
  const el = parent?.items[itemIdx];
  if (!parent || !dest || !el || el.kind !== "element") return null;
  const oldOrdinal = elementChildren(parent).findIndex((k) => k.item === itemIdx);
  parent.items.splice(itemIdx, 1);
  place(dest, el, t, size, dest === parent ? oldOrdinal : -1);
  return findPath(root, el);
}

/** Mueve un control dentro de su layout (para las flechas del teclado). */
export function reorder(root: Element, path: Path, delta: number): Path | null {
  const parent = getAt(root, path.slice(0, -1));
  if (!parent) return null;
  const kids = elementChildren(parent);
  const ord = kids.findIndex((k) => k.item === path[path.length - 1]);
  const to = ord + delta;
  if (ord < 0 || to < 0 || to >= kids.length) return null;
  const [el] = parent.items.splice(kids[ord].item, 1) as Element[];
  insertAtOrdinal(parent, el, to);
  return findPath(root, el);
}

/** Crea los hijos iniciales de un control (pestañas de un TabWidget, layout de un GroupBox). */
export function fromTemplate(t: ChildTemplate): Element {
  const def = widgetDef(t.type);
  const props = { ...(t.bare ? {} : def?.defaults ?? {}), ...(t.props ?? {}) };
  return {
    kind: "element",
    type: t.type,
    id: null,
    items: [
      ...Object.entries(props).map(([name, value]) => ({ kind: "prop" as const, name, value })),
      ...(t.children ?? def?.children ?? []).map(fromTemplate),
    ],
  };
}

// ---------- Contenido de un GroupBox ----------

export type GroupMode = "free" | "vertical" | "horizontal";
const MODE_TYPE: Record<GroupMode, string> = { free: "Rectangle", vertical: "VerticalBox", horizontal: "HorizontalBox" };

/** Contenedor interno de un GroupBox (su único hijo, si es un panel o un layout). */
export function groupInner(group: Element): { el: Element; item: number; mode: GroupMode } | null {
  const kids = elementChildren(group);
  if (kids.length !== 1) return null;
  const mode = (Object.keys(MODE_TYPE) as GroupMode[]).find((m) => MODE_TYPE[m] === kids[0].el.type);
  return mode ? { ...kids[0], mode } : null;
}

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Cambia cómo se acomoda el contenido de un GroupBox. Al pasar a "free", cada control
 * recibe la posición y tamaño que tenía en pantalla (`geometry`) o, si no se sabe, se apilan.
 */
export function setGroupMode(group: Element, mode: GroupMode, geometry?: (child: Element) => Rect | null) {
  const inner = groupInner(group);
  const source = inner ? inner.el : group;
  const children = elementChildren(source).map((k) => k.el);
  if (inner?.mode === mode) return;
  const next = fromTemplate({ type: MODE_TYPE[mode], bare: true });
  next.id = inner?.el.id ?? null;
  let y = 8;
  for (const c of children) {
    for (const p of [...GEOMETRY, ...GRID_PROPS]) if (mode !== "free" || !GEOMETRY.includes(p)) setProp(c, p, undefined);
    if (mode === "free") {
      const def = widgetDef(c.type);
      const known = geometry?.(c);
      const r = known ?? { x: 8, y, w: parseLength(getProp(c, "width")) ?? def?.size[0] ?? 100, h: parseLength(getProp(c, "height")) ?? def?.size[1] ?? 30 };
      setProp(c, "x", formatLength(r.x));
      setProp(c, "y", formatLength(r.y));
      setProp(c, "width", formatLength(r.w));
      setProp(c, "height", formatLength(r.h));
      y = Math.max(y, r.y + r.h + 8);
    }
    next.items.push(c);
  }
  if (inner) group.items.splice(inner.item, 1, next);
  else {
    group.items = group.items.filter((it) => it.kind !== "element");
    group.items.push(next);
  }
}
