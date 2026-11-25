// Arregla parámetros o variables locales llamados `t` que tapan a la función t() de traducción:
// los renombra a `it` (solo dentro de su función), sin tocar las llamadas t("…").
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const isTranslateCall = (id) =>
    ts.isCallExpression(id.parent) && id.parent.expression === id && id.parent.arguments[0] &&
    (ts.isStringLiteral(id.parent.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(id.parent.arguments[0]));
  const visit = (node) => {
    const fn = ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) ? node : null;
    const decl = fn?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === "t");
    if (fn && decl && fn.body) {
      let usesTranslate = false;
      const refs = [];
      const scan = (n) => {
        if (ts.isIdentifier(n) && n.text === "t") {
          if (isTranslateCall(n)) usesTranslate = true;
          else if (!(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) refs.push(n);
        }
        ts.forEachChild(n, scan);
      };
      scan(fn.body);
      if (usesTranslate) {
        edits.push({ pos: decl.name.getStart(sf), end: decl.name.getEnd(), text: "it" });
        for (const r of refs) {
          // `{ t }` abreviado en un objeto → `{ t: it }`
          const text = ts.isShorthandPropertyAssignment(r.parent) ? "t: it" : "it";
          edits.push({ pos: r.getStart(sf), end: r.getEnd(), text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let out = src;
  for (const e of edits.sort((a, b) => b.pos - a.pos)) out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  if (edits.length) writeFileSync(file, out);
  console.log(`${file}: ${edits.length} cambios`);
}
