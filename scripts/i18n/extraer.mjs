// Extrae los textos a traducir:
//   - interfaz: el primer argumento de cada t("…") y lit("…") en src/
//   - backend: los textos en español de src-tauri/src (fuera de las pruebas), con sus valores
//     variables ({}, {nombre}, {:?}…) convertidos en {0}, {1}…
// y muestra cuáles faltan en src/i18n/en.ts y src/i18n/backend-en.ts.
//
//   node scripts/i18n/extraer.mjs            → resumen
//   node scripts/i18n/extraer.mjs --faltan   → JSON con las claves sin traducir
//   node scripts/i18n/extraer.mjs --check    → falla si falta alguna (para CI)
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const walk = (d, re) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p, re) : re.test(n) ? [p] : []; });

export function frontendKeys() {
  const keys = new Map();
  for (const f of walk(join(ROOT, "src"), /\.tsx?$/)) {
    if (f.includes("/i18n/")) continue;
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n) => {
      if (ts.isCallExpression(n) && ["t", "lit"].includes(n.expression.getText()) && n.arguments[0] &&
        (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0]))) {
        const k = n.arguments[0].text;
        if (!keys.has(k)) keys.set(k, relative(ROOT, f));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // Valores que se traducen con t(variable): los grupos del panel de propiedades.
  for (const g of ["Diseño", "Contenido", "Apariencia", "Comportamiento"]) if (!keys.has(g)) keys.set(g, "src/designer/widgets.ts");
  return keys;
}

/** Texto de Rust → plantilla con {0}, {1}… (null si no es un mensaje en español). */
function rustTemplate(lit) {
  let i = 0;
  const tpl = lit.replace(/\{\{|\}\}|\{[^{}]*\}/g, (m) => (m === "{{" ? "{" : m === "}}" ? "}" : `{${i++}}`));
  const plain = tpl.replace(/\{\d+\}/g, "");
  if (!/[áéíóúñ¿¡]|\b(de|la|el|en|para|con|que|no|un|una|los|las|se|del|al|es|por|sin|ya|hay|falta|está|Depurador|Compilador|Herramientas|Instalando|Descargando|Listo|Ejecuta|Abre|Escribe|Primero|buscando|puede|tardar|desconocida|interrumpida)\b/i.test(plain)) return null;
  if (!/[A-Za-záéíóúñ]{3}/.test(plain)) return null;
  return tpl.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
}

export function backendKeys() {
  const keys = new Map();
  for (const f of walk(join(ROOT, "src-tauri/src"), /\.rs$/)) {
    let src = readFileSync(f, "utf8");
    const tests = src.search(/#\[cfg\(test\)\]\s*mod tests/);
    if (tests >= 0) src = src.slice(0, tests);
    // Quitar comentarios para no confundirlos con textos.
    src = src.replace(/^\s*\/\/.*$/gm, "");
    for (const m of src.matchAll(/(?<![\w'])"((?:[^"\\\n]|\\.)*)"/g)) {
      const tpl = rustTemplate(m[1]);
      if (!tpl) continue;
      // Los textos que son solo un salto de línea o puntuación alrededor de valores no sirven de plantilla.
      if (tpl.replace(/\{\d+\}|[\s.,:;!?()\-–—>]/g, "").length < 4) continue;
      if (!keys.has(tpl)) keys.set(tpl, relative(ROOT, f));
    }
  }
  return keys;
}

async function main() {
  const { EN } = await import(join(ROOT, "src/i18n/en.ts"));
  const { BACKEND_EN } = await import(join(ROOT, "src/i18n/backend-en.ts"));
  const fk = frontendKeys();
  const bk = backendKeys();
  const missF = [...fk].filter(([k]) => !(k in EN));
  const missB = [...bk].filter(([k]) => !(k in BACKEND_EN));
  const unusedF = Object.keys(EN).filter((k) => !fk.has(k));
  if (process.argv.includes("--faltan")) {
    console.log(JSON.stringify({ interfaz: missF.map(([k, f]) => [k, f]), backend: missB.map(([k, f]) => [k, f]) }, null, 1));
    return;
  }
  console.log(`Interfaz: ${fk.size} textos, faltan ${missF.length}${unusedF.length ? `, ${unusedF.length} traducciones sin usar` : ""}.`);
  console.log(`Backend: ${bk.size} mensajes, faltan ${missB.length}.`);
  if (process.argv.includes("--check") && (missF.length || missB.length)) process.exit(1);
}
main();
