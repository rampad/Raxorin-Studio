// Envuelve en t() los textos en español que van como argumentos de otro t("…{0}…", "texto").
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const ROOT = fileURLToPath(new URL("../../src/", import.meta.url));
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []; });
let total = 0;
for (const f of walk(ROOT)) {
  if (f.includes("/i18n/")) continue;
  const src = readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText() === "t") {
      for (const a of n.arguments.slice(1)) {
        const lits = [];
        const find = (x) => {
          if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && /[a-záéíóúñ]{3}/i.test(x.text) && !/^[\w.-]+$/.test(x.text) || ((ts.isStringLiteral(x)) && /^(proyectos?|ninguno|ninguna|carpeta|solución|archivo|archivos|sí|no)$/.test(x.text))) lits.push(x);
          else if (!ts.isCallExpression(x)) ts.forEachChild(x, find);
        };
        find(a);
        for (const l of lits) edits.push({ pos: l.getStart(sf), end: l.getEnd(), text: `t(${JSON.stringify(l.text)})` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!edits.length) continue;
  let out = src;
  for (const e of edits.sort((a, b) => b.pos - a.pos)) out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  writeFileSync(f, out);
  total += edits.length;
  console.log(`${edits.length}  ${f.replace(ROOT, "src/")}  ${edits.map((e) => e.text).join(" ")}`.slice(0, 220));
}
console.log(`${total} argumentos envueltos`);
