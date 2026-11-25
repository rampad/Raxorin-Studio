// Prueba de Raxorin Studio Lite en Chrome (sin dependencias: el protocolo de DevTools por WebSocket).
//   node tests/lite/navegador.mjs <url de lite.html> <carpeta de capturas>
// Crea un proyecto de consola, lo ejecuta en el Rust Playground, provoca un error y lo encuentra en
// su archivo; abre un ejemplo de Slint y comprueba que la vista previa real dibuja la ventana.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, shots = tmpdir()] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(join(tmpdir(), "lite-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, "--window-size=1400,900", "--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? "✔ " : "✖ ") + m); if (!c) fails++; };

let ws, id = 0;
const pending = new Map();
const consoleErrors = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
      const page = targets.find((x) => x.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener("open", r, { once: true }));
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
          if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
        });
        return;
      }
    } catch { /* Chrome arrancando */ }
    await sleep(200);
  }
  throw new Error("Chrome no respondió");
}
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => {
  const r = (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result;
  if (r?.exceptionDetails && process.env.DEBUG) console.log("  excepción:", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r?.result?.value;
};
const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(250); } return false; };
const shot = async (name) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(join(shots, name), Buffer.from(r.result.data, "base64")); };
const setFile = (suffix, text) => js(`(() => { const m = monaco.editor.getModels().find((x) => x.uri.path.endsWith(${JSON.stringify(suffix)})); m.setValue(${JSON.stringify(text)}); return true; })()`);
const click = (text, sel = "button") => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().includes(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);

try {
  await connect();
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  // prompt() del nombre del proyecto: se responde solo.
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.prompt = (m, d) => d ?? 'prueba'; window.confirm = () => true;" });
  await cdp("Page.navigate", { url });
  ok(await waitFor(`!!document.querySelector('.lite-welcome')`), "pantalla de bienvenida");
  await shot("lite-1-bienvenida.png");

  // Consola: crear, ejecutar en el Playground.
  await click("Aplicación de consola");
  ok(await waitFor(`!!document.querySelector('.monaco-editor') && document.querySelector('.lite-file.active')?.textContent.includes('main.rs')`), "proyecto de consola creado y main.rs abierto en el editor");
  await click("Ejecutar");
  ok(await waitFor(`[...document.querySelectorAll('.lite-out.success')].some((x) => x.textContent.includes('✔'))`, 90000), "se ejecuta en el Rust Playground");
  const out = await js(`[...document.querySelectorAll('.lite-out.stdout')].map((x) => x.textContent).join('\\n')`);
  ok(/Hola|Hello/.test(out ?? ""), `salida del programa: ${JSON.stringify((out ?? "").slice(0, 60))}`);

  // Entrada (stdin): el programa pide el nombre; sin entrada se abre el cuadro y se avisa.
  ok(await waitFor(`!!document.querySelector('.lite-stdin textarea')`, 5000), "el programa lee la entrada: se abre el cuadro «Entrada»");
  await js(`document.querySelector('.lite-stdin textarea').focus()`);
  await cdp("Input.insertText", { text: "Ana" });
  await click("Ejecutar");
  ok(await waitFor(`[...document.querySelectorAll('.lite-out.stdout')].some((x) => /Ana/.test(x.textContent))`, 90000), "con la entrada «Ana», el programa la lee y responde");

  // Error en un módulo: aparece con su archivo y línea (los módulos se unen para el Playground).
  // Necesita el editor expuesto, que solo existe en desarrollo (npm run lite:dev).
  if (await js(`typeof monaco !== "undefined"`)) {
  await js(`(() => { window.prompt = () => 'src/util.rs'; return true; })()`);
  await click("", ".lite-files-head .icon-btn[title]"); // archivo nuevo
  ok(await waitFor(`monaco.editor.getModels().some((x) => x.uri.path.endsWith('/src/util.rs'))`, 5000), "archivo nuevo src/util.rs");
  await setFile("/src/util.rs", "pub fn doble(n: i32) -> i32 {\n    let r = 0;\n    r = n * 2;\n    r\n}\n");
  await setFile("/src/main.rs", "mod util;\n\nfn main() {\n    println!(\"{}\", util::doble(21));\n}\n");
  if (process.env.DEBUG) console.log("  modelos:", await js(`monaco.editor.getModels().map((m) => m.uri.path + ' ' + m.getValue().length).join(' | ')`), "· botones:", await js(`[...document.querySelectorAll('button')].filter((b) => b.textContent.includes('Ejecutar')).map((b) => b.disabled + ':' + b.textContent.trim()).join(' | ')`));
  await click("Ejecutar");
  ok(await waitFor(`[...document.querySelectorAll('.lite-diag.error')].some((x) => x.textContent.includes('src/util.rs:3'))`, 90000), "error E0384 encontrado en src/util.rs línea 3");
  await click("src/util.rs:3", ".lite-diag");
  ok(await waitFor(`document.querySelector('.lite-file.active')?.textContent.includes('util.rs')`, 5000), "clic en el error → abre util.rs");
  await setFile("/src/util.rs", "pub fn doble(n: i32) -> i32 {\n    n * 2\n}\n");
  await click("Ejecutar");
  ok(await waitFor(`[...document.querySelectorAll('.lite-out.stdout')].some((x) => x.textContent.trim() === '42')`, 90000), "corregido: el programa con módulos imprime 42");
  } else console.log("  (versión publicada: se omite la prueba de módulos, que necesita el editor expuesto en desarrollo)");
  await shot("lite-2-consola.png");

  // Ejemplo de Slint: vista previa real.
  await click("Ejemplos");
  ok(await waitFor(`document.querySelectorAll('.lite-sample').length > 3`, 30000), "catálogo de ejemplos desde GitHub");
  await click("Conversor de temperatura", ".lite-sample");
  ok(await waitFor(`!!document.querySelector('.lite-preview-canvas canvas')`, 60000), "ejemplo de Slint abierto con la vista previa");
  ok(await waitFor(`(() => { const c = document.querySelector('.lite-preview-canvas canvas'); return c && c.width > 50 && c.height > 50; })()`, 60000), "Slint (WebAssembly) dibuja la ventana en el lienzo");
  ok(await waitFor(`!document.querySelector('.lite-preview-msg')`, 30000), "la vista previa terminó de cargar");
  const diags = await js(`document.querySelectorAll('.lite-preview-diags .lite-diag.error').length`);
  ok(diags === 0, `sin errores de Slint (${diags})`);
  await sleep(1500);
  await shot("lite-3-slint.png");
  const designer = await js(`!!document.querySelector('.designer, .slint-designer, [class*=designer]')`);
  ok(designer, "el .slint se abre en el diseñador visual");
} catch (e) {
  ok(false, String(e));
} finally {
  if (consoleErrors.length) console.log("Errores en la consola:\n  " + consoleErrors.slice(0, 8).join("\n  "));
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FALLA(S)` : "\nTodo OK");
process.exit(fails ? 1 : 0);
