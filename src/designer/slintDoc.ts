// Modelo editable de un archivo .slint para el diseñador visual.
//
// Se entiende un subconjunto: el componente exportado (normalmente `inherits Window`),
// sus elementos hijos (`id := Tipo { ... }`), propiedades (`nombre: valor;`) y
// manejadores (`clicked => { ... }`). Todo lo demás (declaraciones, animaciones,
// estados, comentarios…) se guarda como texto "raw" y se reescribe tal cual.

export interface Prop { kind: "prop"; name: string; value: string }
export interface Handler { kind: "handler"; name: string; params: string; body: string }
export interface Raw { kind: "raw"; text: string }
export interface Element {
  kind: "element";
  type: string;
  id: string | null;
  items: Item[];
}
export type Item = Prop | Handler | Raw | Element;

export interface Doc {
  /** Texto antes del componente (imports, otros componentes), sin el import de std-widgets. */
  before: string;
  /** Widgets importados de "std-widgets.slint". */
  stdImports: string[];
  name: string;
  root: Element;
  /** Texto después del componente. */
  after: string;
}

export class SlintParseError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

// ---------- Escáner ----------

const isIdentChar = (c: string) => /[A-Za-z0-9_-]/.test(c);

/** Índice justo después del string que empieza en `i` (soporta `\{interpolación}`). */
function skipString(s: string, i: number): number {
  i++; // comilla inicial
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      if (s[i + 1] === "{") i = skipBalanced(s, i + 1, "{", "}");
      else i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  throw new SlintParseError("Texto entre comillas sin cerrar", i);
}

function skipComment(s: string, i: number): number {
  if (s.startsWith("//", i)) {
    const nl = s.indexOf("\n", i);
    return nl < 0 ? s.length : nl;
  }
  if (s.startsWith("/*", i)) {
    const end = s.indexOf("*/", i + 2);
    if (end < 0) throw new SlintParseError("Comentario /* sin cerrar", i);
    return end + 2;
  }
  return i;
}

/** Desde `i` (que apunta a `open`), devuelve el índice después del cierre correspondiente. */
function skipBalanced(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i = skipString(s, i); continue; }
    if (s.startsWith("//", i) || s.startsWith("/*", i)) { i = skipComment(s, i); continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new SlintParseError(`Falta cerrar “${open}”`, i);
}

/** Lee una expresión hasta `;` en profundidad 0. Devuelve [fin de la expresión, índice después del `;`]. */
function readUntilSemicolon(s: string, i: number, end: number): [number, number] {
  let depth = 0;
  while (i < end) {
    const c = s[i];
    if (c === '"') { i = skipString(s, i); continue; }
    if (s.startsWith("//", i) || s.startsWith("/*", i)) { i = skipComment(s, i); continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return [i, i + 1];
    if (depth < 0) break;
    i++;
  }
  throw new SlintParseError("Falta un “;”", i);
}

/** Lee una sentencia que no entendemos: hasta `;` o hasta el final de un bloque `{...}`. */
function readRawStatement(s: string, i: number, end: number): number {
  let depth = 0;
  while (i < end) {
    const c = s[i];
    if (c === '"') { i = skipString(s, i); continue; }
    if (s.startsWith("//", i) || s.startsWith("/*", i)) { i = skipComment(s, i); continue; }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "{" && depth === 0) {
      let j = skipBalanced(s, i, "{", "}");
      const after = j;
      while (j < end && /\s/.test(s[j])) j++;
      return s[j] === ";" ? j + 1 : after;
    } else if (c === ";" && depth === 0) return i + 1;
    i++;
  }
  return end;
}

const RAW_KEYWORDS = new Set([
  "in", "out", "in-out", "private", "property", "callback", "function", "pure", "public",
  "animate", "states", "transitions", "for", "if", "changed", "export", "import", "struct", "enum", "global",
]);

function parseBody(s: string, start: number, end: number): Item[] {
  const items: Item[] = [];
  let i = start;
  const ws = () => { while (i < end && /\s/.test(s[i])) i++; };

  while (true) {
    ws();
    if (i >= end) break;
    const stmt = i;

    if (s.startsWith("//", i) || s.startsWith("/*", i)) {
      i = skipComment(s, i);
      items.push({ kind: "raw", text: s.slice(stmt, i) });
      continue;
    }

    let word = "";
    while (i < end && isIdentChar(s[i])) word += s[i++];
    if (!word || RAW_KEYWORDS.has(word)) {
      i = readRawStatement(s, stmt, end);
      items.push({ kind: "raw", text: s.slice(stmt, i).trim() });
      continue;
    }
    ws();

    // id := Tipo { ... }
    if (s.startsWith(":=", i)) {
      i += 2;
      ws();
      let type = "";
      while (i < end && isIdentChar(s[i])) type += s[i++];
      ws();
      if (!type || s[i] !== "{") {
        i = readRawStatement(s, stmt, end);
        items.push({ kind: "raw", text: s.slice(stmt, i).trim() });
        continue;
      }
      const close = skipBalanced(s, i, "{", "}");
      items.push({ kind: "element", type, id: word, items: parseBody(s, i + 1, close - 1) });
      i = close;
      continue;
    }

    // Tipo { ... }
    if (s[i] === "{") {
      const close = skipBalanced(s, i, "{", "}");
      if (/^[A-Z]/.test(word)) {
        items.push({ kind: "element", type: word, id: null, items: parseBody(s, i + 1, close - 1) });
      } else {
        items.push({ kind: "raw", text: s.slice(stmt, close).trim() });
      }
      i = close;
      continue;
    }

    // evento(params) => { ... }   o   evento => { ... }
    let params = "";
    if (s[i] === "(") {
      const close = skipBalanced(s, i, "(", ")");
      params = s.slice(i, close);
      i = close;
      ws();
    }
    if (s.startsWith("=>", i)) {
      i += 2;
      ws();
      if (s[i] !== "{") throw new SlintParseError(`Se esperaba “{” después de “${word} =>”`, i);
      const close = skipBalanced(s, i, "{", "}");
      items.push({ kind: "handler", name: word, params, body: s.slice(i + 1, close - 1) });
      i = close;
      ws();
      if (s[i] === ";") i++;
      continue;
    }
    if (params) {
      i = readRawStatement(s, stmt, end);
      items.push({ kind: "raw", text: s.slice(stmt, i).trim() });
      continue;
    }

    // propiedad: valor;
    if (s[i] === ":" && s[i + 1] !== "=") {
      i++;
      ws();
      if (s[i] === "{") {
        const close = skipBalanced(s, i, "{", "}");
        items.push({ kind: "prop", name: word, value: s.slice(i, close) });
        i = close;
        ws();
        if (s[i] === ";") i++;
      } else {
        const [exprEnd, next] = readUntilSemicolon(s, i, end);
        items.push({ kind: "prop", name: word, value: s.slice(i, exprEnd).trim() });
        i = next;
      }
      continue;
    }

    // Cualquier otra cosa (p. ej. `prop <=> otro.prop;`)
    i = readRawStatement(s, stmt, end);
    items.push({ kind: "raw", text: s.slice(stmt, i).trim() });
  }
  return items;
}

const STD_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*"std-widgets\.slint"\s*;[ \t]*\n?/;

export function parse(text: string): Doc {
  // El componente principal: el que hereda de Window, o el último exportado.
  const re = /export\s+component\s+([A-Za-z_][\w-]*)\s+inherits\s+([A-Za-z_][\w-]*)\s*\{/g;
  let match: RegExpExecArray | null;
  let chosen: RegExpExecArray | null = null;
  while ((match = re.exec(text))) {
    if (!chosen || match[2] === "Window") chosen = match;
    if (match[2] === "Window") break;
  }
  if (!chosen) {
    throw new SlintParseError("No se encontró “export component … inherits Window { … }”.", 0);
  }
  const open = chosen.index + chosen[0].length - 1;
  const close = skipBalanced(text, open, "{", "}");

  let before = text.slice(0, chosen.index);
  let stdImports: string[] = [];
  const imp = STD_IMPORT_RE.exec(before);
  if (imp) {
    stdImports = imp[1].split(",").map((x) => x.trim()).filter(Boolean);
    before = before.slice(0, imp.index) + before.slice(imp.index + imp[0].length);
  }

  return {
    before: before.replace(/^\s+/, ""),
    stdImports,
    name: chosen[1],
    root: { kind: "element", type: chosen[2], id: "root", items: parseBody(text, open + 1, close - 1) },
    after: text.slice(close),
  };
}

// ---------- Generador ----------

const IND = "    ";

function dedent(text: string): string[] {
  const lines = text.replace(/\s+$/, "").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  const rest = lines.slice(1).filter((l) => l.trim());
  const min = rest.length ? Math.min(...rest.map((l) => l.match(/^\s*/)![0].length)) : 0;
  return lines.map((l, i) => (i === 0 ? l.trim() : l.slice(min)));
}

function emitItems(items: Item[], depth: number, out: string[]) {
  const ind = IND.repeat(depth);
  let prev: Item["kind"] | null = null;
  for (const item of items) {
    // Líneas en blanco: antes de cada elemento hijo y entre propiedades y declaraciones.
    const groupChange =
      (item.kind === "raw" && prev === "prop") || (item.kind === "prop" && prev === "raw");
    if (prev !== null && (item.kind === "element" || groupChange)) out.push("");
    switch (item.kind) {
      case "prop":
        if (item.value.startsWith("{") && item.value.includes("\n")) {
          const lines = dedent(item.value);
          out.push(`${ind}${item.name}: ${lines[0]}`);
          for (const l of lines.slice(1)) out.push(l ? ind + l : "");
        } else {
          out.push(`${ind}${item.name}: ${item.value}${item.value.endsWith("}") && item.value.startsWith("{") ? "" : ";"}`);
        }
        break;
      case "handler": {
        out.push(`${ind}${item.name}${item.params} => {`);
        for (const l of dedent(item.body)) out.push(l ? ind + IND + l : "");
        out.push(`${ind}}`);
        break;
      }
      case "raw": {
        const lines = dedent(item.text);
        lines.forEach((l, i) => out.push(i === 0 ? ind + l : l ? ind + l : ""));
        break;
      }
      case "element":
        out.push(`${ind}${item.id ? item.id + " := " : ""}${item.type} {`);
        emitItems(item.items, depth + 1, out);
        out.push(`${ind}}`);
        break;
    }
    prev = item.kind;
  }
}

/** Widgets de la biblioteca estándar que necesitan import. */
export const STD_WIDGETS = new Set([
  "Button", "CheckBox", "ComboBox", "LineEdit", "TextEdit", "Slider", "SpinBox", "Switch",
  "ProgressIndicator", "Spinner", "GroupBox", "ListView", "StandardButton", "StandardListView",
  "StandardTableView", "TabWidget", "ScrollView", "VerticalBox", "HorizontalBox", "GridBox",
  "AboutSlint", "DatePickerPopup", "TimePickerPopup", "Palette", "StyleMetrics",
]);

export function usedTypes(el: Element, acc = new Set<string>()): Set<string> {
  for (const it of el.items) {
    if (it.kind === "element") {
      acc.add(it.type);
      usedTypes(it, acc);
    }
  }
  return acc;
}

export function generate(doc: Doc): string {
  const imports = new Set(doc.stdImports);
  for (const t of usedTypes(doc.root)) if (STD_WIDGETS.has(t)) imports.add(t);
  const out: string[] = [];
  if (imports.size) out.push(`import { ${[...imports].sort().join(", ")} } from "std-widgets.slint";`, "");
  const before = doc.before.replace(/\s+$/, "");
  if (before) out.push(before, "");
  out.push(`export component ${doc.name} inherits ${doc.root.type} {`);
  emitItems(doc.root.items, 1, out);
  out.push("}");
  const after = doc.after.slice(1).replace(/^\s*\n/, "");
  return out.join("\n") + "\n" + (after.trim() ? "\n" + after.replace(/\s+$/, "") + "\n" : "");
}

// ---------- Ayudantes para el diseñador ----------

/** Ruta de un elemento: índices de `items` desde la raíz ("" = la ventana). */
export type Path = number[];

export function getAt(root: Element, path: Path): Element | null {
  let el: Element = root;
  for (const idx of path) {
    const next = el.items[idx];
    if (!next || next.kind !== "element") return null;
    el = next;
  }
  return el;
}

export function getProp(el: Element, name: string): string | undefined {
  const p = el.items.find((i): i is Prop => i.kind === "prop" && i.name === name);
  return p?.value;
}

/** Cambia (o agrega) una propiedad; `undefined` la quita. */
export function setProp(el: Element, name: string, value: string | undefined) {
  const idx = el.items.findIndex((i) => i.kind === "prop" && i.name === name);
  if (value === undefined) {
    if (idx >= 0) el.items.splice(idx, 1);
    return;
  }
  if (idx >= 0) {
    (el.items[idx] as Prop).value = value;
    return;
  }
  // Insertar después de la última propiedad (antes de manejadores e hijos).
  let at = 0;
  el.items.forEach((it, i) => {
    if (it.kind === "prop") at = i + 1;
  });
  el.items.splice(at, 0, { kind: "prop", name, value });
}

export const clone = <T,>(x: T): T => structuredClone(x);

/** Todos los ids usados en el documento. */
export function allIds(el: Element, acc = new Set<string>()): Set<string> {
  for (const it of el.items) {
    if (it.kind === "element") {
      if (it.id) acc.add(it.id);
      allIds(it, acc);
    }
  }
  return acc;
}

// ---------- Valores ----------

export const parseLength = (v: string | undefined): number | null => {
  const m = v?.trim().match(/^(-?\d+(?:\.\d+)?)\s*(px|phx)?$/);
  return m ? parseFloat(m[1]) : null;
};
export const formatLength = (n: number) => `${Math.round(n)}px`;

export const parseNumber = (v: string | undefined): number | null => {
  const m = v?.trim().match(/^-?\d+(?:\.\d+)?$/);
  return m ? parseFloat(m[0]) : null;
};

export function parseString(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  // Sin interpolación: `\{` precedido de un número par de barras.
  if (!/^"(?:[^"\\]|\\.)*"$/.test(t) || /(^|[^\\])(\\\\)*\\\{/.test(t)) return null;
  return t.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}
export const formatString = (s: string) =>
  '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';

export const parseBool = (v: string | undefined): boolean | null =>
  v?.trim() === "true" ? true : v?.trim() === "false" ? false : null;

export const parseColor = (v: string | undefined): string | null => {
  const m = v?.trim().match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3}|[0-9a-fA-F]{8})$/);
  return m ? m[0] : null;
};

export function parseStringArray(v: string | undefined): string[] | null {
  const t = v?.trim();
  if (!t || !t.startsWith("[") || !t.endsWith("]")) return null;
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  const out: string[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*")\s*(,|$)/y;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < inner.length && (re.lastIndex = pos, (m = re.exec(inner)))) {
    const s = parseString(m[1]);
    if (s === null) return null;
    out.push(s);
    pos = re.lastIndex;
  }
  return pos >= inner.length ? out : null;
}
export const formatStringArray = (xs: string[]) => `[${xs.map(formatString).join(", ")}]`;

export function parseImage(v: string | undefined): string | null {
  const m = v?.trim().match(/^@image-url\(\s*("(?:[^"\\]|\\.)*")\s*\)$/);
  return m ? parseString(m[1]) : null;
}
export const formatImage = (path: string) => `@image-url(${formatString(path)})`;
