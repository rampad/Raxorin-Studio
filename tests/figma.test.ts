import { readFileSync } from "node:fs";
import * as S from "../src/designer/slintDoc.ts";
import * as F from "../src/designer/figmaImport.ts";
let fails = 0;
const ok = (cond: boolean, msg: string) => { console.log((cond ? "✔ " : "✖ ") + msg); if (!cond) fails++; };

// Archivo exportado por el plugin (test/plugin.test.cjs del repositorio Raxorin-Figma).
const exp = F.parseFigmaExport(readFileSync(new URL("./fixtures/figma-login.json", import.meta.url), "utf8"));
const r = F.convertFrame(exp, 0, new Set(["root"]));
ok(r.width === 360 && r.height === 380 && r.title === "Login", "tamaño y título de la ventana");
ok(r.background === "#f2f5fa", `fondo de la ventana (${r.background})`);

const card = r.items[0];
ok(card.type === "Rectangle" && S.getProp(card, "border-radius") === "12px", "tarjeta con fondo → Rectangle con esquinas");
ok(S.getProp(card, "drop-shadow-blur") === "16px" && S.getProp(card, "drop-shadow-offset-y") === "4px", "sombra");
ok(S.getProp(card, "x") === "20px" && S.getProp(card, "width") === "320px", "posición relativa a la pantalla");
const box = card.items.find((i): i is S.Element => i.kind === "element")!;
ok(box.type === "VerticalBox" && S.getProp(box, "padding") === "20px" && S.getProp(box, "spacing") === "12px", "Auto Layout → VerticalBox con márgenes y separación");
const kids = box.items.filter((i): i is S.Element => i.kind === "element");
ok(kids.map((k) => k.type).join() === "Image,Text,LineEdit,CheckBox,Button,Text", `controles: ${kids.map((k) => k.type).join()}`);
const [img, title, input, check, button] = kids;
ok(S.getProp(img, "source") === '@image-url("figma/logo-img1.png")' && r.assets[0].path === "figma/logo-img1.png", "vector → Image + archivo PNG");
ok(S.getProp(title, "font-weight") === "700" && S.getProp(title, "horizontal-alignment") === "center", "texto: grosor y alineación");
ok(S.getProp(title, "horizontal-stretch") === "1" && S.getProp(title, "x") === undefined, "texto que llena el ancho (FILL), sin x/y");
ok(S.getProp(title, "height") === undefined && S.getProp(title, "vertical-stretch") === "0", "texto de alto automático: sin alto fijo");
ok(S.getProp(input, "placeholder-text") === '"tu@correo.com"', "Input → LineEdit con texto de ayuda");
ok(S.getProp(check, "text") === '"Recordarme"', "Checkbox → CheckBox");
ok(S.getProp(button, "text") === '"Entrar"' && S.getProp(button, "primary") === "true", "Button (variante Primary) → botón principal");
ok(button.id === "entrar" && input.id === "input_correo", "nombres válidos a partir de los de Figma");
ok(r.tokens!.includes("export global Tema") && r.tokens!.includes("out property <color> primario: #0d66e6;"), "variables de color → global Tema");
ok(r.tokens!.includes("boton-fondo"), "nombres de variables con / y tildes");

// Reglas de controles por nombre.
const node = (name: string, extra: Partial<F.FNode> = {}): F.FNode => ({
  id: "1", name, type: "FRAME", box: { x: 0, y: 0, w: 10, h: 10 }, opacity: 1, fills: [], strokes: [], strokeWeight: 0, radii: null,
  effects: [], clips: false, layout: null, sizing: { h: "FIXED", v: "FIXED", positioning: "AUTO" }, component: null, text: null, image: null, children: [], ...extra,
});
ok(F.widgetFor(node("Botón Guardar")) === "Button", "“Botón” en español");
ok(F.widgetFor(node("Buttons row")) === null, "“Buttons row” no es un botón");
ok(F.widgetFor(node("Frame 3", { component: { name: "State=On", set: "Toggle", variant: { State: "On" } } })) === "Switch", "por el nombre del set de componentes");
ok(F.widgetFor(node("Text area")) === "TextEdit" && F.widgetFor(node("Select país")) === "ComboBox", "textarea y select");
ok(F.slug("Ícono 1") === "icono_1" && F.slug("123") === "e_123", "slug");
ok(F.colorToSlint({ r: 1, g: 0, b: 0, a: 0.5 }) === "#ff000080", "color con transparencia");

// Validación del archivo.
let msg = "";
try { F.parseFigmaExport('{"format":"otro"}'); } catch (e) { msg = String(e); }
ok(msg.includes("plugin"), "rechaza archivos que no son del plugin");

// El documento generado se vuelve a leer igual (lo puede abrir el diseñador).
const doc: S.Doc = { before: r.tokens!, stdImports: [], name: "AppWindow", after: "", root: { kind: "element", type: "Window", id: "root", items: [
  { kind: "prop", name: "title", value: S.formatString(r.title) }, { kind: "prop", name: "width", value: "360px" }, { kind: "prop", name: "height", value: "380px" }, ...r.items,
] } };
const text = S.generate(doc);
ok(S.generate(S.parse(text)) === text, "el .slint generado se lee y regenera igual");
if (process.env.FIGMA_SLINT_OUT) {
  const fs = await import("node:fs");
  fs.writeFileSync(process.env.FIGMA_SLINT_OUT, text);
}

console.log(fails ? `\n${fails} FALLA(S)` : "\nTodo OK");
if (fails) process.exit(1);
