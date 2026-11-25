// Lista los textos con letras del español que siguen sin t(): candidatos a revisar a mano.
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const ROOT = new URL("../../src/", import.meta.url).pathname;
const files = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []; });
for (const f of files(ROOT)) {
  const rel = relative(ROOT, f);
  if (rel.startsWith("i18n/") || rel.includes("slintDoc") || rel.includes("slintLanguage")) continue;
  const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (n) => {
    const lit = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n);
    if (lit) {
      const text = n.text ?? "";
      const inT = (() => { let p = n.parent; for (let i = 0; i < 3 && p; i++, p = p.parent) if (ts.isCallExpression(p) && ["t", "tb"].includes(p.expression.getText())) return true; return false; })();
      if (!inT && /[áéíóúñ¿¡]|\b(de|para|con|que|una?|los|las|del|sin)\b/i.test(text) && /[a-záéíóú]{3}/i.test(text) && !(n.parent && ts.isImportDeclaration(n.parent))) {
        console.log(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  ${JSON.stringify(text.trim()).slice(0, 100)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
