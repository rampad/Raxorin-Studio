// Resaltado de sintaxis de Slint para Monaco.
import * as monaco from "monaco-editor";

export function registerSlintLanguage() {
  if (monaco.languages.getLanguages().some((l) => l.id === "slint")) return;
  monaco.languages.register({ id: "slint", extensions: [".slint"], aliases: ["Slint"] });
  monaco.languages.setLanguageConfiguration("slint", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
    surroundingPairs: [{ open: "{", close: "}" }, { open: '"', close: '"' }],
    indentationRules: { increaseIndentPattern: /\{[^}]*$/, decreaseIndentPattern: /^\s*\}/ },
  });
  monaco.languages.setMonarchTokensProvider("slint", {
    keywords: [
      "import", "from", "export", "component", "inherits", "property", "callback", "in", "out", "in-out",
      "private", "public", "pure", "function", "return", "if", "else", "for", "animate", "states", "transitions",
      "when", "struct", "enum", "global", "root", "parent", "self", "true", "false", "changed",
    ],
    types: ["int", "float", "string", "bool", "color", "brush", "length", "physical-length", "duration", "angle", "image", "percent", "relative-font-size"],
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/"/, "string", "@string"],
        [/#[0-9a-fA-F]{3,8}\b/, "number.hex"],
        [/\d+(\.\d+)?(px|phx|rem|ms|s|deg|rad|turn|%)?/, "number"],
        [/@[a-z-]+/, "annotation"],
        [/[A-Z][\w-]*/, "type.identifier"],
        [/[a-z_][\w-]*(?=\s*:=)/, "variable.name"],
        [/[a-z_][\w-]*(?=\s*(\(.*\))?\s*=>)/, "function"],
        [/[a-z_][\w-]*(?=\s*:(?!=))/, "attribute.name"],
        [/[a-z_][\w-]*/, { cases: { "@keywords": "keyword", "@types": "type", "@default": "identifier" } }],
        [/:=|<=>|=>|[{}()[\];:,.?<>!=+\-*/&|]/, "delimiter"],
      ],
      comment: [[/\*\//, "comment", "@pop"], [/./, "comment"]],
      string: [
        [/\\\{/, { token: "delimiter.bracket", next: "@interp" }],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
        [/[^"\\]+/, "string"],
      ],
      interp: [[/\}/, { token: "delimiter.bracket", next: "@pop" }], { include: "root" }],
    },
  } as monaco.languages.IMonarchLanguage);
}
