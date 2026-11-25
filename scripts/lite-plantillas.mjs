// Genera src/lite/plantillas.json con las plantillas de proyecto nuevo de src-tauri/src/fs_cmds.rs,
// para que Raxorin Studio Lite cree los mismos proyectos que la app de escritorio.
//
//   node scripts/lite-plantillas.mjs          → escribe el archivo
//   node scripts/lite-plantillas.mjs --check  → falla si no está al día (npm test)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rs = readFileSync(fileURLToPath(new URL("../src-tauri/src/fs_cmds.rs", import.meta.url)), "utf8");
const raw = (name) => {
  // const NOMBRE: &str = r#"…"#;  o  r##"…"##;
  const m = rs.match(new RegExp(`const ${name}: &str = r(#+)"([\\s\\S]*?)"\\1;`));
  if (!m) throw new Error(`No se encontró ${name} en fs_cmds.rs`);
  return m[2];
};
const version = rs.match(/const SLINT_VERSION: &str = "([^"]+)";/)[1];
const data = {
  slintVersion: version,
  es: { console: raw("CONSOLE_TEMPLATE"), slintUi: raw("SLINT_UI"), slintMain: raw("SLINT_MAIN") },
  en: { console: raw("CONSOLE_TEMPLATE_EN"), slintUi: raw("SLINT_UI_EN"), slintMain: raw("SLINT_MAIN_EN") },
  slintBuild: raw("SLINT_BUILD"),
};
const out = JSON.stringify(data, null, 1) + "\n";
const dest = fileURLToPath(new URL("../src/lite/plantillas.json", import.meta.url));
if (process.argv.includes("--check")) {
  if (!existsSync(dest) || readFileSync(dest, "utf8").replace(/\r\n/g, "\n") !== out) {
    console.error("src/lite/plantillas.json no está al día: ejecuta node scripts/lite-plantillas.mjs");
    process.exit(1);
  }
  console.log("Plantillas de Lite al día.");
} else {
  writeFileSync(dest, out);
  console.log("src/lite/plantillas.json");
}
