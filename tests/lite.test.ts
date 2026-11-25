// Raxorin Studio Lite: unir módulos para el Playground y devolver los errores a su archivo.
import { bundle, manifestInfo, parseDiagnostics, remapText } from "../src/lite/playground.ts";
import { crc32, fileBytes, makeZip } from "../src/lite/zip.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✔ " : "✖ ") + m); if (!c) fails++; };

const files = {
  "src/main.rs": "mod util;\npub mod juego;\n\nfn main() {\n    util::hola();\n}\n",
  "src/util.rs": "pub fn hola() {\n    println!(\"hola\");\n}\n",
  "src/juego/mod.rs": "pub mod tablero;\n",
  "src/juego/tablero.rs": "pub fn x() -> i32 {\n    let a = 1;\n    a = 2;\n    a\n}\n",
};
const b = bundle(files, "src/main.rs");
ok(b.code.includes("mod util {\npub fn hola()") && b.code.includes("pub mod juego {\npub mod tablero {"), "inserta módulos y submódulos en línea");
ok(b.missing.length === 0, "encuentra x.rs y x/mod.rs");
const lineOfA = b.code.split("\n").findIndex((l) => l.trim() === "a = 2;") + 1;
const lineOfHola = b.code.split("\n").findIndex((l) => l.trim() === "util::hola();") + 1;
ok(b.map[lineOfA - 1].file === "src/juego/tablero.rs" && b.map[lineOfA - 1].line === 3, "el mapa devuelve archivo y línea originales");

const stderr = `   Compiling playground v0.0.1 (/playground)
error[E0384]: cannot assign twice to immutable variable \`a\`
 --> src/main.rs:${lineOfA}:5
  |
warning: unused variable: \`z\`
 --> src/main.rs:${lineOfHola}:9
error: could not compile \`playground\` (bin "playground") due to 1 previous error; 1 warning emitted
`;
const d = parseDiagnostics(stderr, b.map);
ok(d.length === 2 && d[0].code === "E0384" && d[0].file === "src/juego/tablero.rs" && d[0].line === 3 && d[0].column === 5, "error con código, archivo y línea originales");
ok(d[1].level === "warning" && d[1].file === "src/main.rs" && d[1].line === 5, "advertencia en main.rs");
ok(remapText(stderr, b.map).includes("--> src/juego/tablero.rs:3:5"), "el texto del compilador muestra el archivo real");

const missing = bundle({ "src/main.rs": "mod falta;\nfn main() {}\n" }, "src/main.rs");
ok(missing.missing[0] === "src/falta.rs" && missing.code.startsWith("mod falta;"), "módulo inexistente: se deja para que lo diga el compilador");
ok(bundle({ "src/main.rs": "mod a {\n}\nfn main() {}\n" }, "src/main.rs").code.startsWith("mod a {"), "no toca módulos con cuerpo");

const m = manifestInfo(`[package]\nname = "x"\nedition = "2024"\n\n[dependencies]\nrand = "0.9"\nserde = { version = "1", features = ["derive"] }\n\n[dependencies.regex]\nversion = "1"\n\n[build-dependencies]\nslint-build = "1.19"\n`);
ok(m.edition === "2024" && m.deps.join(",") === "rand,serde,regex", "Cargo.toml: edición y dependencias (sin build-dependencies)");

// .zip: lo abre unzip y el contenido sale igual.
ok(crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "CRC-32 correcto");
const dir = mkdtempSync(join(tmpdir(), "lite-zip-"));
const png = "data:image/png;base64,iVBORw0KGgo=";
writeFileSync(join(dir, "p.zip"), makeZip("mi_juego", { "src/main.rs": fileBytes("fn main() { println!(\"ñ\"); }\n"), "ui/logo.png": fileBytes(png) }));
let unzipOk = false;
let haveUnzip = true;
try {
  execFileSync("unzip", ["-q", join(dir, "p.zip"), "-d", join(dir, "x")]);
  unzipOk = readFileSync(join(dir, "x/mi_juego/src/main.rs"), "utf8").includes("ñ") && readFileSync(join(dir, "x/mi_juego/ui/logo.png")).toString("base64") === "iVBORw0KGgo=";
} catch (e) {
  haveUnzip = (e as NodeJS.ErrnoException).code !== "ENOENT";
  if (haveUnzip) console.log(String(e));
}
if (haveUnzip) ok(unzipOk, ".zip válido: unzip lo abre con texto UTF-8 e imágenes");
else console.log("- (sin unzip en este sistema: se omite abrir el .zip)");
rmSync(dir, { recursive: true, force: true });

console.log(fails ? `\n${fails} FALLA(S)` : "\nTodo OK");
process.exit(fails ? 1 : 0);
