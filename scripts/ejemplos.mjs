// Genera ejemplos/index.json (el catálogo del hub de ejemplos) a partir de
// ejemplos/ejemplos.meta.json y de los archivos de cada carpeta.
//
//   node scripts/ejemplos.mjs           → escribe el índice
//   node scripts/ejemplos.mjs --check   → falla si el índice no está al día (CI)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath: en Windows, .pathname daría "/D:/…".
const base = fileURLToPath(new URL("../ejemplos/", import.meta.url));
const meta = JSON.parse(readFileSync(join(base, "ejemplos.meta.json"), "utf8"));
const IGNORAR = new Set(["target", "Cargo.lock", ".DS_Store"]);

function archivos(dir) {
  return readdirSync(dir)
    .filter((n) => !IGNORAR.has(n))
    .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? archivos(join(dir, n)) : [join(dir, n)]));
}

const ejemplos = meta.map((e) => {
  const dir = join(base, e.id);
  if (!existsSync(dir)) throw new Error(`Falta la carpeta ejemplos/${e.id}`);
  const lista = archivos(dir).map((f) => relative(dir, f).split(sep).join("/")).sort();
  for (const f of [e.abrir, e.solucion].filter(Boolean)) {
    if (!lista.includes(f)) throw new Error(`${e.id}: no existe ${f}`);
  }
  return { ...e, archivos: lista };
});

const sobrantes = readdirSync(base).filter((n) => statSync(join(base, n)).isDirectory() && !meta.some((e) => e.id === n));
if (sobrantes.length) throw new Error(`Carpetas sin entrada en ejemplos.meta.json: ${sobrantes.join(", ")}`);

const texto = JSON.stringify({ formato: 1, ejemplos }, null, 2) + "\n";
const destino = join(base, "index.json");
if (process.argv.includes("--check")) {
  // Sin distinguir CRLF/LF (Git en Windows puede convertir los saltos de línea).
  const actual = existsSync(destino) ? readFileSync(destino, "utf8").replace(/\r\n/g, "\n") : null;
  if (actual !== texto) {
    console.error("ejemplos/index.json no está al día: ejecuta node scripts/ejemplos.mjs");
    process.exit(1);
  }
  console.log(`Índice de ejemplos al día (${ejemplos.length}).`);
} else {
  writeFileSync(destino, texto);
  console.log(`ejemplos/index.json: ${ejemplos.length} ejemplos.`);
}
