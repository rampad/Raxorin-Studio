import { readFileSync } from "node:fs";
import * as S from "../src/designer/slintDoc.ts";
let fails = 0;
const ok = (cond: boolean, msg: string) => { console.log((cond ? "✔ " : "✖ ") + msg); if (!cond) fails++; };

// 1. La plantilla sale idéntica (ida y vuelta).
const tpl = readFileSync(new URL("./fixtures/app-window.slint", import.meta.url), "utf8");
const d = S.parse(tpl);
const out = S.generate(d);
ok(out === tpl, "plantilla: parse → generate idéntico");
if (out !== tpl) console.log(out);
ok(d.root.items.filter((i) => i.kind === "element").length === 3, "3 elementos hijos");
const btn = S.getAt(d.root, [d.root.items.findIndex((i) => i.kind === "element" && i.id === "saludar")])!;
ok(btn.type === "Button" && S.getProp(btn, "text") === '"Saludar"', "botón con texto");
ok(btn.items.some((i) => i.kind === "handler" && i.name === "clicked"), "manejador clicked");

// 2. Código escrito a mano: se conserva lo que no se entiende.
const hand = `import { Button, VerticalBox } from "std-widgets.slint";
import { Tema } from "tema.slint";

component Tarjeta inherits Rectangle { }

export component AppWindow inherits Window {
    in property <int> contador: 0;
    callback sumar(int) -> int;
    // comentario importante
    title: "Hola \\{contador} veces";
    background: contador > 3 ? #ff0000 : #00ff00;
    animate background { duration: 200ms; }
    VerticalBox {
        Text { text: "a; b {c}"; }
        lista := ComboBox {
            model: ["Uno", "Dos \\"tres\\""];
            selected(valor) => { debug(valor); }
        }
        for item in [1, 2]: Text { text: item; }
        if contador > 1: Rectangle { }
    }
    states [ activo when contador > 0: { background: red; } ]
}
`;
const h = S.parse(hand);
const h2 = S.generate(h);
ok(S.generate(S.parse(h2)) === h2, "código a mano: idempotente");
for (const frag of ["callback sumar(int) -> int;", "// comentario importante", "animate background { duration: 200ms; }",
  "for item in [1, 2]: Text { text: item; }", "states [ activo when contador > 0: { background: red; } ]",
  'import { Tema } from "tema.slint";', "component Tarjeta inherits Rectangle { }", 'title: "Hola \\{contador} veces";'])
  ok(h2.includes(frag), "conserva: " + frag);
ok(h2.startsWith('import { Button, ComboBox, VerticalBox } from "std-widgets.slint";'), "import std-widgets actualizado (agrega ComboBox)");
const vbox = h.root.items.find((i) => i.kind === "element") as S.Element;
const combo = vbox.items.find((i) => i.kind === "element" && i.id === "lista") as S.Element;
ok(JSON.stringify(S.parseStringArray(S.getProp(combo, "model"))) === JSON.stringify(["Uno", 'Dos "tres"']), "modelo del ComboBox");

// 3. Editar: mover un elemento y agregar uno nuevo.
const e = S.parse(tpl);
const t = e.root.items.find((i) => i.kind === "element" && i.id === "saludo") as S.Element;
S.setProp(t, "x", S.formatLength(40.4));
S.setProp(t, "color", "#ff8800");
e.root.items.push({ kind: "element", type: "CheckBox", id: "casilla1", items: [{ kind: "prop", name: "text", value: S.formatString('Acepto "todo"') }] });
const g = S.generate(e);
ok(g.includes("x: 40px;") && g.includes("color: #ff8800;"), "setProp");
ok(g.startsWith('import { Button, CheckBox, LineEdit } from "std-widgets.slint";'), "import agregado para CheckBox");
ok(g.includes('casilla1 := CheckBox {\n        text: "Acepto \\"todo\\"";\n    }'), "nuevo elemento generado");
ok(S.parseString(S.formatString('a "b" \\ {c}')) === 'a "b" \\ {c}', "texto con comillas, barra y llaves");

// 4. Errores claros.
try { S.parse("component X { }"); ok(false, "error sin Window"); } catch (err) { ok(err instanceof S.SlintParseError, "error: falta export component"); }
try { S.parse('export component A inherits Window { Text { text: "x"; }'); ok(false, "llave"); } catch (err) { ok(err instanceof S.SlintParseError, "error: llave sin cerrar"); }

console.log(fails ? `\n${fails} FALLA(S)` : "\nTodo OK");
process.exit(fails ? 1 : 0);
