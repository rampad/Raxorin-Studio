// Genera src-tauri/mcp/controles.json: el catálogo de controles del diseñador para el servidor MCP
// (herramienta slint_controls), en español e inglés, a partir de src/designer/widgets.ts.
//
//   node scripts/mcp-catalogo.ts          → escribe el archivo
//   node scripts/mcp-catalogo.ts --check  → falla si no está al día (npm test)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// El idioma se fija al cargar los módulos: cada idioma se genera en su propio proceso.
async function catalog() {
  const w = await import("../src/designer/widgets.ts");
  const prop = (p: { name: string; label: string; kind: string; options?: string[]; fallback?: string }) => ({
    name: p.name, label: p.label, kind: p.kind, ...(p.options ? { options: p.options } : {}), ...(p.fallback ? { default: p.fallback } : {}),
  });
  return {
    window: { props: w.WINDOW_DEF.props.map(prop) },
    layoutChild: w.LAYOUT_CHILD.map(prop),
    gridChild: w.GRID_CHILD.map(prop),
    widgets: w.WIDGETS.filter((x: { category?: string }) => x.category !== "hidden").map((x: any) => ({
      type: x.type,
      label: x.label,
      category: x.category,
      ...(x.layout ? { layout: x.layout } : {}),
      ...(x.container ? { container: true } : {}),
      ...(x.nonVisual ? { nonVisual: true } : {}),
      defaults: x.defaults,
      props: x.props.map(prop),
      events: x.events.map((e: any) => ({ name: e.name, label: e.label, params: e.params })),
      ...(x.bindable ? { bindable: x.bindable } : {}),
    })),
  };
}

if (process.env.RAXORIN_MCP_PARTE) {
  process.stdout.write(JSON.stringify(await catalog()));
  process.exit(0);
}
const self = fileURLToPath(import.meta.url);
const part = (lang: string) =>
  JSON.parse(execFileSync(process.execPath, [self], { env: { ...process.env, RAXORIN_LANG: lang, RAXORIN_MCP_PARTE: "1" }, encoding: "utf8" }));
const out = JSON.stringify({ slint: "1.19", es: part("es"), en: part("en") }, null, 1) + "\n";
const dest = fileURLToPath(new URL("../src-tauri/mcp/controles.json", import.meta.url));
if (process.argv.includes("--check")) {
  if (!existsSync(dest) || readFileSync(dest, "utf8").replace(/\r\n/g, "\n") !== out) {
    console.error("src-tauri/mcp/controles.json no está al día: ejecuta node scripts/mcp-catalogo.ts");
    process.exit(1);
  }
  console.log("Catálogo MCP al día.");
} else {
  writeFileSync(dest, out);
  console.log(`src-tauri/mcp/controles.json (${(out.length / 1024).toFixed(0)} KB)`);
}
