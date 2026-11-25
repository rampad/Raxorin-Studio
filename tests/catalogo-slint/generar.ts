// Genera ui/catalogo.slint con TODOS los controles del diseñador, cada uno con TODAS sus
// propiedades y eventos, para comprobar con el compilador de Slint que los nombres y los tipos
// del catálogo (src/designer/widgets.ts) existen de verdad.
//
//   node tests/catalogo-slint/generar.ts && cargo build --manifest-path tests/catalogo-slint/Cargo.toml
import { writeFileSync } from "node:fs";
import { GRID_CHILD, LAYOUT_CHILD, WIDGETS, WINDOW_DEF, type PropDef, type WidgetDef } from "../../src/designer/widgets.ts";

const sample = (p: PropDef): string => {
  switch (p.kind) {
    case "length": return "10px";
    case "string": case "text": return '"x"';
    case "bool": return "true";
    case "color": return "#ff0000";
    case "number": return "1";
    case "int": return "1";
    case "percent": return "0.5";
    case "enum": return p.options![p.options!.length - 1];
    case "strings": return '["a", "b"]';
    case "image": return '@image-url("logo.png")';
    case "duration": return "100ms";
    case "items": return '[{ text: "a" }]';
  }
};

const ind = (n: number) => "    ".repeat(n);
const props = (ps: PropDef[], depth: number, skip: string[] = []) =>
  ps.filter((p) => !skip.includes(p.name)).map((p) => `${ind(depth)}${p.name}: ${sample(p)};`);
const events = (w: WidgetDef, depth: number) =>
  w.events.map((e) => `${ind(depth)}${e.name}(${e.params.map((x) => x.name).join(", ")}) => { }`);

function element(w: WidgetDef, depth: number, extra: PropDef[] = [], skipLayout = false): string[] {
  const skip = skipLayout ? ["x", "y", "width", "height"] : [];
  const body = [...props(w.props, depth + 1, skip), ...props(extra, depth + 1), ...events(w, depth + 1)];
  if (w.type === "TabWidget") body.push(`${ind(depth + 1)}Tab { title: "a"; }`);
  if (w.type === "GroupBox") body.push(`${ind(depth + 1)}Rectangle { }`);
  return [`${ind(depth)}${w.type} {`, ...body, `${ind(depth)}}`];
}

const out: string[] = [
  'import { Button, CheckBox, ComboBox, GridBox, GroupBox, HorizontalBox, LineEdit, ProgressIndicator, ScrollView, Slider,',
  '         SpinBox, Spinner, StandardButton, StandardListView, Switch, TabWidget, TextEdit, VerticalBox } from "std-widgets.slint";',
  "",
  "export component Catalogo inherits Window {",
  ...props(WINDOW_DEF.props, 1),
];
const visual = WIDGETS.filter((w) => w.category !== "hidden" && !w.nonVisual);
// 1. Con posición fija (x, y, width, height).
out.push(`${ind(1)}Rectangle {`);
for (const w of visual) out.push(...element(w, 2));
out.push(`${ind(1)}}`);
// 2. Dentro de un layout: con ancho/alto fijo, y con mínimos y máximos (Slint no admite ambos a la vez;
//    el diseñador quita uno al poner el otro).
const MINMAX = ["min-width", "max-width", "min-height", "max-height"];
out.push(`${ind(1)}VerticalBox {`);
for (const w of visual) out.push(...element(w, 2, LAYOUT_CHILD.filter((p) => !MINMAX.includes(p.name)), true));
for (const w of visual) out.push(...element(w, 2, LAYOUT_CHILD.filter((p) => !["width", "height"].includes(p.name)), true));
out.push(`${ind(1)}}`);
// 3. Dentro de una cuadrícula (fila, columna, cuántas ocupa).
out.push(`${ind(1)}GridBox {`);
for (const w of visual) out.push(...element(w, 2, GRID_CHILD, true));
out.push(`${ind(1)}}`);
// 4. Pestañas y componentes sin interfaz.
const tab = WIDGETS.find((w) => w.type === "Tab")!;
out.push(`${ind(1)}TabWidget {`, ...element(tab, 2), `${ind(1)}}`);
for (const w of WIDGETS.filter((x) => x.nonVisual)) out.push(...element(w, 1));
out.push("}", "");

writeFileSync(new URL("./ui/catalogo.slint", import.meta.url), out.join("\n"));
const nProps = WIDGETS.reduce((n, w) => n + w.props.length, 0) + WINDOW_DEF.props.length;
const nEvents = WIDGETS.reduce((n, w) => n + w.events.length, 0);
console.log(`ui/catalogo.slint: ${WIDGETS.length} controles, ${nProps} propiedades, ${nEvents} eventos.`);
