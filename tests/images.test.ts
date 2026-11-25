import { resolveImagePath as r } from "../src/designer/imagePath.ts";

let fails = 0;
const ok = (cond: boolean, name: string) => {
  if (!cond) {
    fails++;
    console.error("✖", name);
  }
};
ok(r("/p/app/ui", "figma/logo.png") === "/p/app/ui/figma/logo.png", "relativa");
ok(r("/p/app/ui", "./a.png") === "/p/app/ui/a.png", "con ./");
ok(r("/p/app/ui", "../img/a.png") === "/p/app/img/a.png", "con ../");
ok(r("/p/app/ui", "/abs/a.png") === "/abs/a.png", "absoluta");
ok(r("C:\\p\\app\\ui", "figma/logo.png") === "C:\\p\\app\\ui\\figma\\logo.png", "Windows");
ok(r("C:\\p\\ui", "D:/x.png") === "D:/x.png", "absoluta en Windows");
ok(r(null, "a.png") === "a.png", "sin carpeta");
if (fails) process.exit(1);
console.log("✔ imágenes: todo OK");
