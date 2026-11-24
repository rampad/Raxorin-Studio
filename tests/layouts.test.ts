import * as S from "../src/designer/slintDoc.ts";
import * as O from "../src/designer/designOps.ts";
let fails = 0;
const ok = (cond: boolean, msg: string) => { console.log((cond ? "✔ " : "✖ ") + msg); if (!cond) fails++; };

const src = `import { Button, VerticalBox } from "std-widgets.slint";

export component AppWindow inherits Window {
    width: 400px;
    height: 300px;
    col1 := VerticalBox {
        x: 10px;
        y: 10px;
        width: 200px;
        height: 200px;
        b1 := Button { text: "Uno"; }
        b2 := Button { text: "Dos"; }
    }
    suelto := Button {
        x: 250px;
        y: 20px;
        width: 100px;
        height: 32px;
        text: "Suelto";
    }
}
`;
const doc = S.parse(src);
const kids = (el: S.Element) => O.elementChildren(el).map((k) => k.el.id);

// Mover un botón con posición fija a la columna, entre b1 y b2.
let d = S.clone(doc);
let p = O.moveElement(d.root, [3], { kind: "flow", path: [2], index: 1 }, { w: 100, h: 32 });
const col = S.getAt(d.root, [2])!;
ok(JSON.stringify(kids(col)) === '["b1","suelto","b2"]', "mover a una columna lo inserta en la posición pedida");
const moved = S.getAt(d.root, p!)!;
ok(moved.id === "suelto" && ["x", "y", "width", "height"].every((n) => S.getProp(moved, n) === undefined), "dentro del layout pierde x/y/ancho/alto");
ok(S.getProp(moved, "text") === '"Suelto"', "conserva sus demás propiedades");
// Y el archivo generado vuelve a leerse igual.
const regen = S.parse(S.generate(d));
ok(JSON.stringify(kids(S.getAt(regen.root, [2])!)) === '["b1","suelto","b2"]', "el .slint generado conserva el orden");

// Reordenar dentro del mismo layout (hacia adelante cuenta la posición antes de quitarlo).
d = S.clone(doc);
O.moveElement(d.root, [2, 4], { kind: "flow", path: [2], index: 2 }, { w: 1, h: 1 });
ok(JSON.stringify(kids(S.getAt(d.root, [2])!)) === '["b2","b1"]', "reordenar dentro de la misma columna");

// Sacar un botón del layout a la ventana: recibe posición y tamaño.
d = S.clone(doc);
p = O.moveElement(d.root, [2, 5], { kind: "abs", path: [], x: 40, y: 250 }, { w: 120, h: 32 });
const out = S.getAt(d.root, p!)!;
ok(out.id === "b2" && S.getProp(out, "x") === "40px" && S.getProp(out, "width") === "120px", "al salir del layout recibe x/y y tamaño");
ok(JSON.stringify(kids(S.getAt(d.root, [2])!)) === '["b1"]', "y deja de estar en la columna");

// No se puede meter un contenedor dentro de sí mismo.
d = S.clone(doc);
ok(O.moveElement(d.root, [2], { kind: "flow", path: [2], index: 0 }, { w: 1, h: 1 }) === null, "no se puede mover un contenedor dentro de sí mismo");

// Cuadrícula: celdas como Slint (row reinicia la columna, sin col va a la derecha).
const grid = S.parse(`export component W inherits Window {
    g := GridBox {
        a := Text { }
        b := Text { }
        c := Text { row: 1; }
        e := Text { col: 3; }
    }
}
`).root;
const cells = O.gridCells(O.elementChildren(S.getAt(grid, [0])!).map((k) => k.el));
ok(JSON.stringify(cells.map((c) => [c.row, c.col])) === "[[0,0],[0,1],[1,0],[1,3]]", "celdas de la cuadrícula como en Slint");
ok(JSON.stringify(O.freeCell(S.getAt(grid, [0])!, 0, 0)) === '{"row":0,"col":2}', "celda ocupada → la siguiente libre de la fila");
const nuevo: S.Element = { kind: "element", type: "Button", id: "nuevo", items: [] };
p = O.addElement(grid, nuevo, { kind: "grid", path: [0], row: 2, col: 1 }, { w: 1, h: 1 });
const g = S.getAt(grid, [0])!;
ok(S.getProp(S.getAt(grid, p)!, "row") === "2" && S.getProp(S.getAt(grid, p)!, "col") === "1", "agregar a una celda libre");
ok(O.elementChildren(g).every((k) => S.getProp(k.el, "row") !== undefined), "los demás quedan con fila/columna explícitas (no se mueven)");

// Teclado: reordenar.
d = S.clone(doc);
p = O.reorder(d.root, [2, 4], 1);
ok(JSON.stringify(kids(S.getAt(d.root, [2])!)) === '["b2","b1"]' && S.getAt(d.root, p!)!.id === "b1", "reordenar con el teclado");
ok(O.reorder(d.root, p!, 1) === null, "no pasa del último");

// Plantillas: TabWidget con dos pestañas; GroupBox con una columna.
const tw = O.fromTemplate({ type: "TabWidget" });
const tabs = O.elementChildren(tw).map((k) => k.el);
ok(tabs.length === 2 && tabs.every((t) => t.type === "Tab") && S.getProp(tabs[0], "title") === '"Pestaña 1"', "TabWidget nuevo con dos pestañas");
const gb = O.fromTemplate({ type: "GroupBox" });
const gbInner = O.elementChildren(gb)[0].el;
ok(gbInner.type === "Rectangle" && S.getProp(gbInner, "background") === undefined, "GroupBox nuevo con un panel interno transparente (posición libre)");
ok(O.groupInner(gb)?.mode === "free", "el contenido del grupo se reconoce como libre");

// Convertir un grupo con columna (versión anterior) a libre: conserva lo que se veía.
const viejo = S.parse(`export component W inherits Window {
    g := GroupBox {
        title: "Datos";
        VerticalBox {
            a := Button { text: "A"; }
            b := LineEdit { }
        }
    }
}
`).root;
const grupo = S.getAt(viejo, [0])!;
O.setGroupMode(grupo, "free", (c) => (c.id === "a" ? { x: 8, y: 8, w: 244, h: 32 } : null));
const libre = O.groupInner(grupo)!;
const [ga, gbtn] = O.elementChildren(libre.el).map((k) => k.el);
ok(libre.mode === "free" && S.getProp(libre.el, "background") === undefined, "columna → panel libre");
ok(S.getProp(ga, "x") === "8px" && S.getProp(ga, "width") === "244px", "usa la posición y tamaño dibujados");
ok(S.getProp(gbtn, "y") === "48px" && S.getProp(gbtn, "width") === "200px", "sin posición conocida: se apila debajo con su tamaño");
ok(S.getProp(grupo, "title") === '"Datos"', "conserva el título del grupo");
O.setGroupMode(grupo, "horizontal");
const fila = O.groupInner(grupo)!;
ok(fila.mode === "horizontal" && O.elementChildren(fila.el).every((k) => S.getProp(k.el, "x") === undefined && S.getProp(k.el, "width") === undefined), "libre → fila: quita posiciones y tamaños");
ok(O.elementChildren(fila.el).map((k) => k.el.id).join() === "a,b", "y conserva los controles en orden");
const gen = S.generate({ before: "", stdImports: [], name: "W", root: { kind: "element", type: "Window", id: "root", items: [{ ...tw, id: "pestanas1" }] }, after: "" });
ok(gen.includes('import { TabWidget } from "std-widgets.slint";') && gen.includes('Tab {') && !/import \{[^}]*\bTab\b[^}]*Widget/.test(gen.replace("TabWidget", "")), "importa TabWidget pero no Tab");

console.log(fails ? `\n${fails} FALLA(S)` : "\nTodo OK");
if (fails) process.exit(1);
