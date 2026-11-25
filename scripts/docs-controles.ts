// Genera la referencia de controles del diseñador (raxorin.dev/slint/controles/) a partir del
// catálogo src/designer/widgets.ts, para que la documentación no se desactualice.
//
//   node scripts/docs-controles.ts ../Raxorin-Webs/docs/src/content/docs/slint/controles.md
import { writeFileSync } from "node:fs";
import { GRID_CHILD, LAYOUT_CHILD, RUST_TYPE, WIDGETS, WINDOW_DEF, type PropDef, type WidgetDef } from "../src/designer/widgets.ts";

const KIND: Record<PropDef["kind"], string> = {
  length: "longitud (px)", string: "texto", text: "texto (varias líneas)", bool: "sí / no", color: "color",
  number: "número", int: "número entero", percent: "0 a 1", enum: "opción", strings: "lista de textos",
  image: "imagen", duration: "duración (ms)", items: "elementos de lista",
};
const esc = (s: string) => s.replace(/\|/g, "\\|");

function propsTable(props: PropDef[]): string[] {
  const rows = props.map((p) => {
    const opts = p.kind === "enum" && p.options ? `: ${p.options.map((o) => `\`${o}\``).join(", ")}` : "";
    return `| \`${p.name}\` | ${esc(p.label)} | ${KIND[p.kind]}${opts} | ${p.fallback ? `\`${p.fallback}\`` : "—"} |`;
  });
  return ["| Propiedad | En el panel | Valor | Por defecto |", "|---|---|---|---|", ...rows];
}

function widget(w: WidgetDef): string[] {
  const out = [`### ${w.label.replace(/ \(.*\)$/, "")} — \`${w.type}\``, ""];
  if (w.nonVisual) out.push("No se ve en la ventana: el diseñador lo muestra en la bandeja **Componentes**, debajo del lienzo.", "");
  if (w.container && !w.layout) out.push("Contenedor: los controles de adentro se ubican con posición fija (X, Y).", "");
  if (w.layout === "vertical" || w.layout === "horizontal" || w.layout === "grid") out.push("Layout automático: acomoda solo a los controles de adentro.", "");
  out.push(...propsTable(w.props), "");
  if (w.events.length) {
    out.push("| Evento | En el panel | Recibe |", "|---|---|---|");
    for (const e of w.events) {
      const params = e.params.length ? e.params.map((p) => `\`${p.name}\` (${RUST_TYPE[p.slint]})`).join(", ") : "—";
      out.push(`| \`${e.name}\` | ${esc(e.label)} | ${params} |`);
    }
    out.push("");
  }
  if (w.bindable?.length) {
    out.push(`**Usar desde Rust:** ${w.bindable.map((b) => `\`${b.prop}\` (${RUST_TYPE[b.slint]})`).join(", ")}.`, "");
  }
  return out;
}

const visible = WIDGETS.filter((w) => w.category !== "hidden");
const section = (title: string, cat: WidgetDef["category"]) => [`## ${title}`, "", ...visible.filter((w) => w.category === cat).flatMap(widget)];

const doc = [
  "---",
  "title: Referencia de controles",
  "description: Todos los controles del diseñador visual, con sus propiedades, eventos y lo que se puede usar desde Rust.",
  "sidebar:",
  "  order: 6",
  "---",
  "",
  "<!-- Generado por scripts/docs-controles.ts (repositorio Raxorin-Studio) a partir de src/designer/widgets.ts. No lo edites a mano. -->",
  "",
  `El diseñador ofrece ${visible.length} controles. Cada propiedad de esta página se puede cambiar en el panel **Propiedades**`,
  "(o escribiendo una expresión con **fx**), y cada evento se conecta con **Eventos → Crear**: se agrega la función en",
  "`main.rs` (ver [Conectar con Rust](/slint/conectar-con-rust/)).",
  "",
  "Todas las propiedades y eventos de esta página se comprueban con el compilador de Slint 1.19 en cada cambio del",
  "diseñador.",
  "",
  "## La ventana — `Window`",
  "",
  ...propsTable(WINDOW_DEF.props),
  "",
  "## Dentro de un layout",
  "",
  "Dentro de una columna, fila o cuadrícula, la posición la decide el layout. En lugar de X e Y aparecen:",
  "",
  ...propsTable(LAYOUT_CHILD),
  "",
  "Slint no permite poner a la vez un ancho fijo y un ancho mínimo o máximo (ni lo mismo con el alto): al poner uno, el",
  "diseñador quita el otro.",
  "",
  "Y dentro de una cuadrícula, además:",
  "",
  ...propsTable(GRID_CHILD),
  "",
  ...section("Controles", "common"),
  ...section("Contenedores y layouts", "containers"),
  ...section("Componentes sin interfaz", "components"),
];

const dest = process.argv[2];
if (!dest) throw new Error("Uso: node scripts/docs-controles.ts <archivo.md>");
writeFileSync(dest, doc.join("\n") + "\n");
console.log(`${dest}: ${visible.length} controles.`);
