import { defaultConfig, isSep, normalize, newSepId, rowItems, TOOLS } from "../src/toolbarConfig.ts";
let fails = 0;
const ok = (cond: boolean, msg: string) => { console.log((cond ? "✔ " : "✖ ") + msg); if (!cond) fails++; };

const def = defaultConfig();
const ids = def.items.map((i) => i.id);
ok(Object.keys(TOOLS).every((t) => ids.includes(t as never)), "la configuración inicial incluye todos los controles");
ok(def.items.filter((i) => i.on && !isSep(i.id)).map((i) => i.id).join(",") ===
  "new,open,openSolution,save,format,packages,startup,config,build,check,test,debug,run,stop,diag", "orden inicial como la barra original");
ok(["saveAll", "theme", "sidebar", "bottom", "publish"].every((t) => def.items.find((i) => i.id === t)?.on === false), "controles opcionales ocultos al inicio");
ok(def.labels, "textos visibles al inicio");

// Configuración guardada antigua: sin controles nuevos, con uno que ya no existe y un duplicado.
const old = normalize({ items: [{ id: "build", on: true }, { id: "borrado", on: true }, { id: "build", on: false }, { id: "|1", on: true }, { id: "run", on: true }], labels: false });
ok(old.items[0].id === "build" && old.items[0].on, "conserva el orden y la visibilidad guardados");
ok(!old.items.some((i) => (i.id as string) === "borrado"), "quita controles que ya no existen");
ok(old.items.filter((i) => i.id === "build").length === 1, "quita duplicados");
ok(Object.keys(TOOLS).every((t) => old.items.some((i) => i.id === t)), "agrega los controles nuevos");
ok(old.items.filter((i) => !["build", "run", "|1"].includes(i.id)).every((i) => !i.on), "los controles agregados quedan ocultos");
ok(old.labels === false, "respeta 'sin textos'");
ok(normalize(null).items.length === def.items.length && normalize("basura").labels, "valores inválidos → configuración inicial");
ok(newSepId(def.items) === "|3", "id libre para un separador nuevo");

// Segunda barra.
ok(def.secondRow === false && rowItems(def, 2).length === 0 && rowItems(def, 1).length === def.items.length, "sin segunda barra al inicio: todo en la primera");
ok(["ai", "terminal", "git"].every((t) => def.items.find((i) => i.id === t)?.on === false), "Chat con IA, Terminal y Git disponibles pero ocultos");
const two = normalize({ ...def, secondRow: true, items: def.items.map((i) => (["diag", "theme"].includes(i.id) ? { ...i, row: 2 } : i)) });
ok(two.secondRow && rowItems(two, 2).map((i) => i.id).join(",") === "diag,theme", "los controles marcados van a la segunda barra, en orden");
ok(!rowItems(two, 1).some((i) => i.id === "diag"), "y no se repiten en la primera");
const off = normalize({ ...two, secondRow: false });
ok(rowItems(off, 1).some((i) => i.id === "diag") && off.items.find((i) => i.id === "diag")?.row === 2, "al apagar la segunda barra todo vuelve a la primera, sin olvidar el reparto");
ok(normalize({ items: [{ id: "build", on: true, row: 7 }] }).items[0].row === undefined, "fila inválida → primera barra");

console.log(fails ? `\n${fails} FALLA(S)` : "\nTodo OK");
if (fails) process.exit(1);
