// Envuelve en t("…") los textos de la interfaz (en español) de src/. Entiende la estructura de
// TypeScript: no toca imports, claves, comparaciones, tipos ni atributos técnicos.
//
//   node scripts/i18n/envolver.mjs            → muestra qué cambiaría (sin escribir)
//   node scripts/i18n/envolver.mjs --escribir → aplica los cambios
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const WRITE = process.argv.includes("--escribir");
const ROOT = fileURLToPath(new URL("../../src/", import.meta.url));
const SKIP_FILES = ["i18n/", "monaco-setup", "designer/slintLanguage.ts", "designer/slintDoc.ts", "vite-env.d.ts"];

// Atributos JSX y propiedades de objetos que muestran texto al usuario.
const UI_ATTRS = new Set(["title", "placeholder", "label", "aria-label", "alt", "okLabel", "cancelLabel", "desc", "hint", "message", "description", "emptyText"]);
const UI_PROPS = new Set([
  "label", "title", "desc", "description", "text", "hint", "message", "placeholder", "okLabel", "cancelLabel",
  "what", "blank", "name", "tooltip", "help", "detail", "summary", "lead", "empty", "caption", "subtitle", "body",
]);
// Propiedades técnicas: nunca se traducen.
const TECH_PROPS = new Set([
  "type", "kind", "id", "icon", "slug", "group", "category", "shortcut", "key", "className", "path", "pattern",
  "cmd", "href", "idBase", "value", "fallback", "slint", "prop", "tipo", "nivel", "categoria", "file", "mode",
]);
const SKIP_CALLS = /^(invoke|listen|emit|localStorage\.\w+|sessionStorage\.\w+|document\.\w+|require|import|setItem|getItem|querySelector\w*|getElementById|matchMedia|addEventListener|removeEventListener|new RegExp|RegExp|startsWith|endsWith|includes|split|replace|replaceAll|match|test|indexOf|join|padStart|padEnd|setData|getData|dispatchEvent|registerLanguage|setMonarchTokensProvider|defineTheme|Codicon|codicon|lit)$/;

const SPANISH_WORDS = /\b(de|la|el|en|y|para|con|que|no|un|una|los|las|se|del|al|es|por|o|lo|sin|más|tu|su|como|este|esta|hay|ya|si|le|te|ni|muy|qué|cómo)\b/i;
const looksCode = (s) => {
  const x = s.trim();
  // "(sin rama)", "2. Cómo empezar", ". Sus cambios…": texto, no código.
  if (/^\(?[A-Za-zÁÉÍÓÚáéíóúñ¿¡]/.test(x) && /^\(/.test(x) && /\s|[áéíóúñ]/.test(x)) return false;
  if (/^\d+\.\s+[A-ZÁÉÍÓÚ]/.test(x)) return false;
  return /^[./#@<{[(]|=>|::|^--|^\w+\(|^[\w-]+:[\w-]|\$\{|^\w+\.\w+$|^[a-z][\w-]*$|^#[0-9a-f]+$|^\d/.test(x) ||
    /^[A-Z_][A-Z0-9_]*$/.test(x);
};

// Nombres propios y comandos que se muestran tal cual en cualquier idioma.
const KEEP = new Set(["Español", "English", "README", "brew install gh", "`frame variable"]);

function spanish(s, uiContext) {
  const x = s.trim();
  if (KEEP.has(x)) return false;
  if (!/[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(x) || x.length < 2) return false;
  // Títulos en mayúsculas en la interfaz ("EXPLORADOR", "ESQUEMA").
  if (uiContext && /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ]{3,}$/.test(x)) return true;
  if (looksCode(x)) return false;
  if (/[áéíóúñ¿¡ÁÉÍÓÚÑ]/.test(x)) return true;
  if (/\s/.test(x) && SPANISH_WORDS.test(x)) return true;
  // Donde es texto visible (JSX, title, placeholder, label…): toda frase, y las palabras sueltas
  // con mayúscula ("Guardar") o en mayúsculas ("EXPLORADOR").
  if (uiContext && /[a-záéíóúñ]{2,}\s+\S*[a-záéíóúñ]{2,}/i.test(x) && !/[{}<>=;]|\.\w{2,4}$/.test(x)) return true;
  return uiContext && /^[A-ZÁÉÍÓÚÑ¿¡][\wÁÉÍÓÚáéíóúñ…'’.,:!?()\s-]*$/.test(x);
}

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

function propName(node) {
  const n = node.name;
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : null;
}

/** ¿El literal está en un lugar donde es texto para el usuario? (true / false / "ui" = contexto visible) */
function context(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return false;
  if (ts.isLiteralTypeNode(p)) return false;
  if (ts.isCaseClause(p)) return false;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isEnumMember(p)) && p.name === node) return false;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword].includes(op)) return false;
  }
  if (ts.isPropertyAssignment(p)) {
    const k = propName(p);
    if (k && TECH_PROPS.has(k)) return false;
    return k && UI_PROPS.has(k) ? "ui" : true;
  }
  if (ts.isJsxAttribute(p.parent ?? p) || ts.isJsxAttribute(p)) {
    const attr = ts.isJsxAttribute(p) ? p : p.parent;
    const k = attr.name.getText();
    return UI_ATTRS.has(k) ? "ui" : false;
  }
  if (ts.isJsxExpression(p)) {
    const attr = p.parent;
    if (attr && ts.isJsxAttribute(attr)) return UI_ATTRS.has(attr.name.getText()) ? "ui" : false;
    return "ui";
  }
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const callee = p.expression.getText();
    const last = callee.split(".").pop();
    if (SKIP_CALLS.test(callee) || SKIP_CALLS.test(last) || callee === "t" || callee === "tb") return false;
    return true;
  }
  if (ts.isArrayLiteralExpression(p)) return context(p) === false ? false : true;
  if (ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p) || ts.isBinaryExpression(p)) {
    const c = context(p);
    return c;
  }
  if (ts.isReturnStatement(p) || ts.isArrowFunction(p)) return true;
  if (ts.isVariableDeclaration(p)) return true;
  if (ts.isTemplateSpan(p) || ts.isTaggedTemplateExpression(p)) return false;
  return true;
}

let total = 0;
const report = [];
const mixed = [];
for (const file of files(ROOT)) {
  const rel = relative(ROOT, file);
  if (SKIP_FILES.some((s) => rel.startsWith(s) || rel.includes(s))) continue;
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const c = context(node);
      if (c !== false && spanish(node.text, c === "ui")) {
        const inJsxAttr = ts.isJsxAttribute(node.parent);
        const call = `t(${JSON.stringify(node.text)})`;
        edits.push({ pos: node.getStart(sf), end: node.getEnd(), text: inJsxAttr ? `{${call}}` : call, key: node.text });
      }
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      const statics = parts.join(" ");
      const c = context(node);
      if (c !== false && spanish(statics, c === "ui")) {
        let key = node.head.text;
        node.templateSpans.forEach((s, i) => (key += `{${i}}` + s.literal.text));
        const args = node.templateSpans.map((s) => s.expression.getText(sf));
        const inJsxAttr = ts.isJsxAttribute(node.parent);
        const call = `t(${JSON.stringify(key)}, ${args.join(", ")})`;
        edits.push({ pos: node.getStart(sf), end: node.getEnd(), text: call, key });
        return; // no entrar en las expresiones internas
      }
    }
    if (ts.isJsxText(node)) {
      const raw = node.text;
      const trimmed = raw.trim();
      if (trimmed && /[A-Za-zÁÉÍÓÚáéíóúñ]{2}/.test(trimmed) && (spanish(trimmed, true) || /^[.,;:)(]/.test(trimmed))) {
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        // Si el texto ocupa líneas propias, los espacios no cuentan en JSX.
        const keepLead = lead.includes("\n") ? lead : lead ? "{\" \"}" : "";
        const keepTrail = trail.includes("\n") ? trail : trail ? "{\" \"}" : "";
        const key = trimmed.replace(/\s+/g, " ");
        edits.push({ pos: node.getStart(sf), end: node.getEnd(), text: `${keepLead}{t(${JSON.stringify(key)})}${keepTrail}`, key });
        const siblings = node.parent.children ?? [];
        if (siblings.some((s) => ts.isJsxExpression(s) && s.expression)) mixed.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}  ${key}`);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) continue;
  total += edits.length;
  report.push(`${String(edits.length).padStart(4)}  ${rel}`);
  if (WRITE) {
    let out = src;
    for (const e of edits.sort((a, b) => b.pos - a.pos)) out = out.slice(0, e.pos) + e.text + out.slice(e.end);
    if (!/import \{[^}]*\bt\b[^}]*\} from "[./]+i18n(\/index\.ts)?"/.test(out)) {
      let imp = relative(dirname(file), join(ROOT, "i18n")).replace(/\\/g, "/");
      if (!imp.startsWith(".")) imp = "./" + imp;
      // Después del último import.
      const lastImport = [...out.matchAll(/^import [^;]+;$/gms)].pop();
      const at = lastImport ? lastImport.index + lastImport[0].length : 0;
      out = out.slice(0, at) + `${at ? "\n" : ""}import { t } from "${imp}/index.ts";${at ? "" : "\n"}` + out.slice(at);
    }
    writeFileSync(file, out);
  } else {
    for (const e of edits) report.push(`        ${JSON.stringify(e.key).slice(0, 110)}`);
  }
}
console.log(report.join("\n"));
console.log(`\n${total} textos ${WRITE ? "envueltos" : "a envolver"}.`);
if (mixed.length) console.log(`\nTextos JSX junto a valores (revisar a mano):\n${mixed.join("\n")}`);
