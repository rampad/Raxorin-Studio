// Importar pantallas exportadas con el plugin "Raxorin Studio Export" de Figma.
// Convierte el formato "raxorin-figma" (ver FORMAT.md del plugin) en elementos de Slint:
// Auto Layout → VerticalBox/HorizontalBox, componentes conocidos → controles reales,
// el resto → Rectangle/Text/Image con posiciones fijas.

import { formatLength, formatString, type Element, type Item } from "./slintDoc.ts";

// ---------- Formato del plugin ----------

export interface FColor { r: number; g: number; b: number; a: number }
export type FPaint =
  | { type: "SOLID"; color: FColor; variable: string | null }
  | { type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL"; stops: { position: number; color: FColor }[]; transform: number[][] }
  | { type: "IMAGE"; scaleMode: string };

export interface FNode {
  id: string;
  name: string;
  type: string;
  box: { x: number; y: number; w: number; h: number };
  opacity: number;
  fills: FPaint[];
  strokes: FPaint[];
  strokeWeight: number;
  radii: [number, number, number, number] | null;
  effects: { type: string; color: FColor | null; offset: { x: number; y: number } | null; radius: number; spread: number }[];
  clips: boolean;
  layout: { mode: "VERTICAL" | "HORIZONTAL"; spacing: number; padding: [number, number, number, number]; primaryAlign: string; counterAlign: string; wrap: boolean } | null;
  sizing: { h: string; v: string; positioning: string };
  component: { name: string; set: string | null; variant: Record<string, string> | null } | null;
  text: {
    characters: string; fontSize: number; fontFamily: string | null; fontStyle: string | null; fontWeight: number | null;
    align: string; valign: string; autoResize: string; lineHeight: number | null; fills: FPaint[];
  } | null;
  image: string | null;
  children: FNode[];
}

export interface FigmaExport {
  format: "raxorin-figma";
  version: number;
  file: string;
  page: string;
  frames: FNode[];
  images: Record<string, { name: string; width: number; height: number; base64: string }>;
  variables: { id: string; name: string; collection: string; color: FColor }[];
  warnings: string[];
}

/** Lee y valida un archivo del plugin. Lanza un error explicativo si no es válido. */
export function parseFigmaExport(text: string): FigmaExport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("El archivo no es un JSON válido. Expórtalo de nuevo con el plugin de Figma.");
  }
  const d = data as Partial<FigmaExport>;
  if (d?.format !== "raxorin-figma") throw new Error("Este archivo no fue creado con el plugin “Raxorin Studio Export” de Figma.");
  if ((d.version ?? 0) > 1) throw new Error(`El archivo es de una versión más nueva del plugin (${d.version}). Actualiza Raxorin Studio.`);
  if (!Array.isArray(d.frames) || !d.frames.length) throw new Error("El archivo no tiene pantallas.");
  return { images: {}, variables: [], warnings: [], file: "", page: "", ...d } as FigmaExport;
}

// ---------- Conversión ----------

export interface ImportResult {
  /** Elementos de la pantalla (hijos de la ventana). */
  items: Element[];
  width: number;
  height: number;
  title: string;
  background: string | null;
  /** Imágenes a escribir junto al .slint (ruta relativa a la carpeta del .slint). */
  assets: { path: string; base64: string }[];
  /** Declaración `export global …` con los colores del sistema de diseño, o null. */
  tokens: string | null;
  /** Cuántos controles de cada tipo se crearon (para mostrar un resumen). */
  stats: Record<string, number>;
  warnings: string[];
}

const hex2 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");
export function colorToSlint(c: FColor, opacity = 1): string {
  const a = c.a * opacity;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.999 ? hex2(a) : ""}`;
}

/** Nombre válido para Slint a partir de un nombre de Figma ("Botón Entrar" → "boton_entrar"). */
export function slug(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(s) ? s : `e_${s || "elemento"}`;
}

/** Control de Slint que corresponde a un componente (por su nombre). */
const WIDGET_RULES: [RegExp, string][] = [
  [/\b(text ?area|area de texto)\b/, "TextEdit"],
  [/\b(button|btn|boton|cta)\b/, "Button"],
  [/\b(input|text ?field|textbox|line ?edit|campo|entrada)\b/, "LineEdit"],
  [/\b(check ?box|casilla)\b/, "CheckBox"],
  [/\b(switch|toggle|interruptor)\b/, "Switch"],
  [/\b(slider|deslizador)\b/, "Slider"],
  [/\b(dropdown|select|combo ?box|combo|lista desplegable)\b/, "ComboBox"],
  [/\b(progress|progreso|progress ?bar)\b/, "ProgressIndicator"],
  [/\b(spinner|loader|loading|cargando)\b/, "Spinner"],
];

export function widgetFor(n: FNode): string | null {
  if (n.type === "TEXT" || n.image) return null;
  const names = [n.component?.set, n.component?.name, n.name].filter(Boolean) as string[];
  for (const raw of names) {
    const name = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[_/-]+/g, " ");
    for (const [re, type] of WIDGET_RULES) if (re.test(name)) return type;
  }
  return null;
}

const firstText = (n: FNode): string | null => {
  if (n.text) return n.text.characters;
  for (const c of n.children) {
    const t = firstText(c);
    if (t) return t;
  }
  return null;
};

const variantText = (n: FNode) =>
  [n.component?.name ?? "", ...Object.entries(n.component?.variant ?? {}).map(([k, v]) => `${k}=${v}`), n.name].join(" ").toLowerCase();

interface Ctx {
  used: Set<string>;
  assets: { path: string; base64: string }[];
  exp: FigmaExport;
  assetDir: string;
  stats: Record<string, number>;
  warnings: string[];
}

function uniqueId(ctx: Ctx, name: string): string {
  const base = slug(name);
  let id = base;
  for (let i = 2; ctx.used.has(id); i++) id = `${base}_${i}`;
  ctx.used.add(id);
  return id;
}

type Parent = { kind: "abs"; x: number; y: number } | { kind: "flow"; mode: "VERTICAL" | "HORIZONTAL" };

const prop = (name: string, value: string): Item => ({ kind: "prop", name, value });

/** Posición y tamaño según el padre: coordenadas en un contenedor fijo, o cómo crece en un Auto Layout. */
function geometry(n: FNode, parent: Parent): Item[] {
  if (parent.kind === "abs") {
    return [
      prop("x", formatLength(n.box.x - parent.x)),
      prop("y", formatLength(n.box.y - parent.y)),
      prop("width", formatLength(n.box.w)),
      prop("height", formatLength(n.box.h)),
    ];
  }
  const out: Item[] = [];
  // Un texto de tamaño automático en Figma: que Slint calcule su tamaño a partir de la fuente.
  const auto = n.text?.autoResize;
  const h = auto === "WIDTH_AND_HEIGHT" && n.sizing.h === "FIXED" ? "HUG" : n.sizing.h;
  const v = (auto === "WIDTH_AND_HEIGHT" || auto === "HEIGHT") && n.sizing.v === "FIXED" ? "HUG" : n.sizing.v;
  n = { ...n, sizing: { ...n.sizing, h, v } };
  if (n.sizing.h === "FIXED") out.push(prop("width", formatLength(n.box.w)));
  else out.push(prop("horizontal-stretch", n.sizing.h === "FILL" ? "1" : "0"));
  if (n.sizing.v === "FIXED") out.push(prop("height", formatLength(n.box.h)));
  else out.push(prop("vertical-stretch", n.sizing.v === "FILL" ? "1" : "0"));
  return out;
}

/** Ángulo de un degradado lineal de Figma en grados de Slint (90deg = de izquierda a derecha). */
function gradientAngle(t: number[][] | undefined): number {
  if (!t) return 90;
  // La matriz lleva del espacio del nodo al del degradado; su inversa da la dirección.
  const [[a, b], [c, d]] = t;
  const det = a * d - b * c || 1;
  const dx = d / det;
  const dy = -c / det;
  return Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360);
}

function paintToSlint(p: FPaint | undefined, opacity = 1): string | null {
  if (!p) return null;
  if (p.type === "SOLID") return colorToSlint(p.color, opacity);
  if (p.type === "GRADIENT_LINEAR") {
    const stops = p.stops.map((s) => `${colorToSlint(s.color, opacity)} ${Math.round(s.position * 100)}%`).join(", ");
    return `@linear-gradient(${gradientAngle(p.transform)}deg, ${stops})`;
  }
  if (p.type === "GRADIENT_RADIAL") {
    const stops = p.stops.map((s) => `${colorToSlint(s.color, opacity)} ${Math.round(s.position * 100)}%`).join(", ");
    return `@radial-gradient(circle, ${stops})`;
  }
  return null;
}

/** Relleno de arriba (el último visible que no sea imagen). */
const topFill = (list: FPaint[]) => [...list].reverse().find((p) => p.type !== "IMAGE");

/** Fondo, bordes, esquinas, sombra y opacidad de un Rectangle. */
function visual(n: FNode): Item[] {
  const out: Item[] = [];
  const bg = paintToSlint(topFill(n.fills));
  if (bg) out.push(prop("background", bg));
  if (n.radii && n.radii.some((r) => r > 0)) {
    const [tl, tr, br, bl] = n.radii;
    if (tl === tr && tr === br && br === bl) out.push(prop("border-radius", formatLength(tl)));
    else {
      out.push(prop("border-top-left-radius", formatLength(tl)), prop("border-top-right-radius", formatLength(tr)));
      out.push(prop("border-bottom-right-radius", formatLength(br)), prop("border-bottom-left-radius", formatLength(bl)));
    }
  }
  if (n.type === "ELLIPSE") out.push(prop("border-radius", formatLength(Math.min(n.box.w, n.box.h) / 2)));
  const stroke = topFill(n.strokes);
  if (stroke && n.strokeWeight > 0 && stroke.type === "SOLID") {
    out.push(prop("border-width", formatLength(n.strokeWeight)), prop("border-color", colorToSlint(stroke.color)));
  }
  const shadow = n.effects.find((e) => e.type === "DROP_SHADOW");
  if (shadow?.color) {
    out.push(prop("drop-shadow-color", colorToSlint(shadow.color)));
    out.push(prop("drop-shadow-blur", formatLength(shadow.radius)));
    if (shadow.offset?.x) out.push(prop("drop-shadow-offset-x", formatLength(shadow.offset.x)));
    if (shadow.offset?.y) out.push(prop("drop-shadow-offset-y", formatLength(shadow.offset.y)));
  }
  if (n.opacity < 0.999) out.push(prop("opacity", String(Math.round(n.opacity * 100) / 100)));
  return out;
}

const hasVisual = (n: FNode) =>
  !!topFill(n.fills) || (n.strokes.length > 0 && n.strokeWeight > 0) || !!n.radii?.some((r) => r > 0) || n.effects.some((e) => e.type === "DROP_SHADOW") || n.opacity < 0.999;

const ALIGN: Record<string, string> = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between" };
const H_ALIGN: Record<string, string> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "left" };
const V_ALIGN: Record<string, string> = { TOP: "top", CENTER: "center", BOTTOM: "bottom" };

function count(ctx: Ctx, type: string) {
  ctx.stats[type] = (ctx.stats[type] ?? 0) + 1;
}

function el(type: string, id: string | null, items: Item[]): Element {
  return { kind: "element", type, id, items };
}

function convertText(n: FNode, parent: Parent, ctx: Ctx): Element {
  const t = n.text!;
  const items: Item[] = [...geometry(n, parent), prop("text", formatString(t.characters))];
  items.push(prop("font-size", formatLength(t.fontSize)));
  if (t.fontWeight && t.fontWeight !== 400) items.push(prop("font-weight", String(t.fontWeight)));
  if (t.fontFamily) items.push(prop("font-family", formatString(t.fontFamily)));
  const color = paintToSlint(topFill(t.fills), n.opacity);
  if (color && !color.startsWith("@")) items.push(prop("color", color));
  if (t.align !== "LEFT") items.push(prop("horizontal-alignment", H_ALIGN[t.align] ?? "left"));
  if (t.valign !== "TOP") items.push(prop("vertical-alignment", V_ALIGN[t.valign] ?? "top"));
  // Un texto de ancho fijo en Figma ajusta las líneas.
  if (t.autoResize !== "WIDTH_AND_HEIGHT") items.push(prop("wrap", "word-wrap"));
  count(ctx, "Text");
  return el("Text", uniqueId(ctx, n.name), items);
}

function convertWidget(n: FNode, type: string, parent: Parent, ctx: Ctx): Element {
  const label = firstText(n) ?? "";
  const items: Item[] = [...geometry(n, parent)];
  const v = variantText(n);
  switch (type) {
    case "Button":
      items.push(prop("text", formatString(label)));
      if (/primary|principal|filled|accent|cta/.test(v)) items.push(prop("primary", "true"));
      break;
    case "LineEdit":
    case "TextEdit":
      if (label) items.push(prop("placeholder-text", formatString(label)));
      break;
    case "CheckBox":
    case "Switch":
      items.push(prop("text", formatString(label)));
      if (/checked=(true|yes|on)|state=(on|checked)|\bon\b|activ/.test(v)) items.push(prop("checked", "true"));
      break;
    case "ComboBox":
      items.push(prop("model", `[${formatString(label || "Opción 1")}]`));
      break;
    case "Slider":
      items.push(prop("value", "50"));
      break;
    case "ProgressIndicator":
      items.push(prop("progress", "0.5"));
      break;
    case "Spinner":
      items.push(prop("indeterminate", "true"));
      break;
  }
  count(ctx, type);
  return el(type, uniqueId(ctx, n.name), items);
}

function convertImage(n: FNode, parent: Parent, ctx: Ctx): Element {
  const img = ctx.exp.images[n.image!];
  const file = `${ctx.assetDir}/${slug(n.name)}-${n.image}.png`;
  if (img) ctx.assets.push({ path: file, base64: img.base64 });
  else ctx.warnings.push(`Falta la imagen de “${n.name}” en el archivo.`);
  count(ctx, "Image");
  return el("Image", uniqueId(ctx, n.name), [...geometry(n, parent), prop("source", `@image-url(${formatString(file)})`), prop("image-fit", "fill")]);
}

function convertNode(n: FNode, parent: Parent, ctx: Ctx): Element | null {
  if (n.image) return convertImage(n, parent, ctx);
  if (n.text) return convertText(n, parent, ctx);
  const widget = widgetFor(n);
  if (widget) return convertWidget(n, widget, parent, ctx);

  const isShape = n.type === "RECTANGLE" || n.type === "ELLIPSE";
  if (isShape || !n.children.length) {
    count(ctx, "Rectangle");
    return el("Rectangle", uniqueId(ctx, n.name), [...geometry(n, parent), ...visual(n)]);
  }

  // Contenedor con Auto Layout → columna o fila (con un panel detrás si tiene fondo).
  if (n.layout) {
    const [pt, pr, pb, pl] = n.layout.padding;
    const boxType = n.layout.mode === "VERTICAL" ? "VerticalBox" : "HorizontalBox";
    const boxItems: Item[] = [];
    if (pt === pr && pr === pb && pb === pl) boxItems.push(prop("padding", formatLength(pt)));
    else boxItems.push(prop("padding-top", formatLength(pt)), prop("padding-right", formatLength(pr)), prop("padding-bottom", formatLength(pb)), prop("padding-left", formatLength(pl)));
    boxItems.push(prop("spacing", formatLength(n.layout.spacing)));
    const align = ALIGN[n.layout.primaryAlign] ?? "start";
    boxItems.push(prop("alignment", align));
    if (n.layout.wrap) ctx.warnings.push(`“${n.name}” usa Auto Layout con varias líneas (wrap): se convirtió en una sola ${n.layout.mode === "VERTICAL" ? "columna" : "fila"}.`);
    const flow: Parent = { kind: "flow", mode: n.layout.mode };
    for (const c of n.children) {
      if (c.sizing.positioning === "ABSOLUTE") ctx.warnings.push(`“${c.name}” tiene posición absoluta dentro de un Auto Layout: se acomodó con los demás.`);
      const child = convertNode(c, flow, ctx);
      if (child) boxItems.push(child);
    }
    count(ctx, boxType);
    if (!hasVisual(n)) return el(boxType, uniqueId(ctx, n.name), [...geometry(n, parent), ...boxItems]);
    const box = el(boxType, null, [prop("x", "0px"), prop("y", "0px"), prop("width", formatLength(n.box.w)), prop("height", formatLength(n.box.h)), ...boxItems]);
    count(ctx, "Rectangle");
    return el("Rectangle", uniqueId(ctx, n.name), [...geometry(n, parent), ...visual(n), ...(n.clips ? [prop("clip", "true")] : []), box]);
  }

  // Marco o grupo sin Auto Layout → panel con posiciones fijas.
  const abs: Parent = { kind: "abs", x: n.box.x, y: n.box.y };
  const kids = n.children.map((c) => convertNode(c, abs, ctx)).filter((x): x is Element => !!x);
  count(ctx, "Rectangle");
  return el("Rectangle", uniqueId(ctx, n.name), [...geometry(n, parent), ...visual(n), ...(n.clips ? [prop("clip", "true")] : []), ...kids]);
}

/**
 * Convierte una pantalla. `usedIds`: nombres que ya existen en el documento (para no repetirlos).
 * `assetDir`: carpeta para las imágenes, relativa al .slint.
 */
export function convertFrame(exp: FigmaExport, index: number, usedIds: Set<string>, assetDir = "figma"): ImportResult {
  const frame = exp.frames[index];
  if (!frame) throw new Error("Esa pantalla no existe en el archivo.");
  const ctx: Ctx = { used: new Set(usedIds), assets: [], exp, assetDir, stats: {}, warnings: [...(exp.warnings ?? [])] };
  const inside: Parent = { kind: "abs", x: frame.box.x, y: frame.box.y };
  let items: Element[];
  if (frame.layout) {
    // La pantalla misma tiene Auto Layout: un layout que ocupa toda la ventana.
    const asChild: FNode = { ...frame, fills: [], strokes: [], effects: [], radii: null, opacity: 1 };
    const converted = convertNode(asChild, inside, ctx);
    items = converted ? [converted] : [];
  } else {
    items = frame.children.map((c) => convertNode(c, inside, ctx)).filter((x): x is Element => !!x);
  }
  const bg = topFill(frame.fills);
  return {
    items,
    width: Math.round(frame.box.w),
    height: Math.round(frame.box.h),
    title: frame.name,
    background: bg?.type === "SOLID" ? colorToSlint(bg.color) : null,
    assets: ctx.assets,
    tokens: tokensGlobal(exp),
    stats: ctx.stats,
    warnings: ctx.warnings,
  };
}

/** `export global Tema { out property <color> primario: #…; }` con las variables de color. */
export function tokensGlobal(exp: FigmaExport): string | null {
  if (!exp.variables?.length) return null;
  const seen = new Set<string>();
  const lines = exp.variables.map((v) => {
    let name = slug(v.name.split("/").join("_")).replace(/_/g, "-");
    for (let i = 2; seen.has(name); i++) name = `${slug(v.name)}-${i}`;
    seen.add(name);
    return `    out property <color> ${name}: ${colorToSlint(v.color)};`;
  });
  return `// Colores del sistema de diseño (variables de Figma).\nexport global Tema {\n${lines.join("\n")}\n}`;
}
