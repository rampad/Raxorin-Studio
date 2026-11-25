// Genera la referencia de controles del diseñador (raxorin.dev/slint/controles/) a partir del
// catálogo src/designer/widgets.ts, para que la documentación no se desactualice.
//
//   node scripts/docs-controles.ts ../Raxorin-Webs/docs/src/content/docs/slint/controles.md
//   RAXORIN_LANG=en node scripts/docs-controles.ts ../Raxorin-Webs/docs/src/content/docs/en/slint/controles.md
import { writeFileSync } from "node:fs";
import { lang } from "../src/i18n/index.ts";
import { GRID_CHILD, LAYOUT_CHILD, RUST_TYPE, WIDGETS, WINDOW_DEF, type PropDef, type WidgetDef } from "../src/designer/widgets.ts";

const ES = {
  kind: {
    length: "longitud (px)", string: "texto", text: "texto (varias líneas)", bool: "sí / no", color: "color", number: "número",
    int: "número entero", percent: "0 a 1", enum: "opción", strings: "lista de textos", image: "imagen", duration: "duración (ms)",
    items: "elementos de lista",
  },
  propsHead: "| Propiedad | En el panel | Valor | Por defecto |",
  eventsHead: "| Evento | En el panel | Recibe |",
  nonVisual: "No se ve en la ventana: el diseñador lo muestra en la bandeja **Componentes**, debajo del lienzo.",
  absContainer: "Contenedor: los controles de adentro se ubican con posición fija (X, Y).",
  layout: "Layout automático: acomoda solo a los controles de adentro.",
  useFromRust: "**Usar desde Rust:**",
  title: "Referencia de controles",
  description: "Todos los controles del diseñador visual, con sus propiedades, eventos y lo que se puede usar desde Rust.",
  intro: (n: number) => [
    `El diseñador ofrece ${n} controles. Cada propiedad de esta página se puede cambiar en el panel **Propiedades**`,
    "(o escribiendo una expresión con **fx**), y cada evento se conecta con **Eventos → Crear**: se agrega la función en",
    "`main.rs` (ver [Conectar con Rust](/slint/conectar-con-rust/)).",
    "",
    "Todas las propiedades y eventos de esta página se comprueban con el compilador de Slint 1.19 en cada cambio del",
    "diseñador.",
  ],
  window: "## La ventana — `Window`",
  inLayout: "## Dentro de un layout",
  inLayoutText: "Dentro de una columna, fila o cuadrícula, la posición la decide el layout. En lugar de X e Y aparecen:",
  conflicts: [
    "Slint no permite poner a la vez un ancho fijo y un ancho mínimo o máximo (ni lo mismo con el alto): al poner uno, el",
    "diseñador quita el otro.",
  ],
  inGrid: "Y dentro de una cuadrícula, además:",
  sections: ["Controles", "Contenedores y layouts", "Componentes sin interfaz"],
};
const EN: typeof ES = {
  kind: {
    length: "length (px)", string: "text", text: "text (multiple lines)", bool: "yes / no", color: "color", number: "number",
    int: "integer", percent: "0 to 1", enum: "option", strings: "list of texts", image: "image", duration: "duration (ms)",
    items: "list items",
  },
  propsHead: "| Property | In the panel | Value | Default |",
  eventsHead: "| Event | In the panel | Receives |",
  nonVisual: "It isn't visible in the window: the designer shows it in the **Components** tray, below the canvas.",
  absContainer: "Container: the controls inside it are placed at fixed positions (X, Y).",
  layout: "Automatic layout: it arranges the controls inside it by itself.",
  useFromRust: "**Use from Rust:**",
  title: "Controls reference",
  description: "Every control in the visual designer, with its properties, events and what can be used from Rust.",
  intro: (n: number) => [
    `The designer offers ${n} controls. Every property on this page can be changed in the **Properties** panel`,
    "(or by writing an expression with **fx**), and every event is connected with **Events → Create**: the function is added",
    "to `main.rs` (see [Connecting to Rust](/en/slint/conectar-con-rust/)).",
    "",
    "Every property and event on this page is checked with the Slint 1.19 compiler on every change to the designer.",
  ],
  window: "## The window — `Window`",
  inLayout: "## Inside a layout",
  inLayoutText: "Inside a column, row or grid, the layout decides the position. Instead of X and Y you get:",
  conflicts: [
    "Slint doesn't allow a fixed width together with a minimum or maximum width (nor the same for height): setting one makes",
    "the designer remove the other.",
  ],
  inGrid: "And inside a grid, also:",
  sections: ["Controls", "Containers and layouts", "Components without UI"],
};
const L = lang === "en" ? EN : ES;
const esc = (s: string) => s.replace(/\|/g, "\\|");

function propsTable(props: PropDef[]): string[] {
  const rows = props.map((p) => {
    const opts = p.kind === "enum" && p.options ? `: ${p.options.map((o) => `\`${o}\``).join(", ")}` : "";
    return `| \`${p.name}\` | ${esc(p.label)} | ${L.kind[p.kind]}${opts} | ${p.fallback ? `\`${p.fallback}\`` : "—"} |`;
  });
  return [L.propsHead, "|---|---|---|---|", ...rows];
}

function widget(w: WidgetDef): string[] {
  const out = [`### ${w.label.replace(/ \(.*\)$/, "")} — \`${w.type}\``, ""];
  if (w.nonVisual) out.push(L.nonVisual, "");
  if (w.container && !w.layout) out.push(L.absContainer, "");
  if (w.layout === "vertical" || w.layout === "horizontal" || w.layout === "grid") out.push(L.layout, "");
  out.push(...propsTable(w.props), "");
  if (w.events.length) {
    out.push(L.eventsHead, "|---|---|---|");
    for (const e of w.events) {
      const params = e.params.length ? e.params.map((p) => `\`${p.name}\` (${RUST_TYPE[p.slint]})`).join(", ") : "—";
      out.push(`| \`${e.name}\` | ${esc(e.label)} | ${params} |`);
    }
    out.push("");
  }
  if (w.bindable?.length) out.push(`${L.useFromRust} ${w.bindable.map((b) => `\`${b.prop}\` (${RUST_TYPE[b.slint]})`).join(", ")}.`, "");
  return out;
}

const visible = WIDGETS.filter((w) => w.category !== "hidden");
const section = (title: string, cat: WidgetDef["category"]) => [`## ${title}`, "", ...visible.filter((w) => w.category === cat).flatMap(widget)];

const doc = [
  "---",
  `title: ${L.title}`,
  `description: ${L.description}`,
  "sidebar:",
  "  order: 6",
  "---",
  "",
  "<!-- Generado por scripts/docs-controles.ts (repositorio Raxorin-Studio) a partir de src/designer/widgets.ts. No lo edites a mano. -->",
  "",
  ...L.intro(visible.length),
  "",
  L.window,
  "",
  ...propsTable(WINDOW_DEF.props),
  "",
  L.inLayout,
  "",
  L.inLayoutText,
  "",
  ...propsTable(LAYOUT_CHILD),
  "",
  ...L.conflicts,
  "",
  L.inGrid,
  "",
  ...propsTable(GRID_CHILD),
  "",
  ...section(L.sections[0], "common"),
  ...section(L.sections[1], "containers"),
  ...section(L.sections[2], "components"),
];

const dest = process.argv[2];
if (!dest) throw new Error("Uso: node scripts/docs-controles.ts <archivo.md>");
writeFileSync(dest, doc.join("\n") + "\n");
console.log(`${dest}: ${visible.length} controles (${lang}).`);
