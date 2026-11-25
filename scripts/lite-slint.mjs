// Descarga el intérprete de Slint para WebAssembly (la versión que usa el IDE) a public-lite/slint/.
// Lo sirve la propia app (sin depender de un CDN en cada visita).
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const version = "1.19.0";
const plantillas = JSON.parse(readFileSync(fileURLToPath(new URL("../src/lite/plantillas.json", import.meta.url)), "utf8"));
if (!version.startsWith(plantillas.slintVersion)) throw new Error(`Slint ${version} no coincide con las plantillas (${plantillas.slintVersion})`);
const dir = fileURLToPath(new URL("../public-lite/slint/", import.meta.url));
mkdirSync(dir, { recursive: true });
for (const f of ["slint_wasm_interpreter.js", "slint_wasm_interpreter_bg.wasm"]) {
  const dest = dir + f;
  if (existsSync(dest) && statSync(dest).size > 1000) continue;
  const res = await fetch(`https://releases.slint.dev/${version}/wasm-interpreter/${f}`);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`public-lite/slint/${f}`);
}
writeFileSync(dir + "VERSION", version + "\n");
