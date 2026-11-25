// Conecta las funciones de Monaco (autocompletado, hover, ir a definición…)
// con las peticiones LSP equivalentes de rust-analyzer.

import * as monaco from "monaco-editor";
import { inlayHintsRefresh, isBenign, type LspClient } from "./client";
import type * as L from "./types";
import { t } from "../i18n/index.ts";

export interface ProviderHost {
  /** Cliente LSP activo (o null si rust-analyzer no está listo). */
  getClient: () => LspClient | null;
  /** Asegura que el archivo esté abierto en una pestaña (para poder aplicar ediciones y guardarlas). */
  ensureOpen: (path: string) => Promise<void>;
  /** Crea un modelo de solo lectura para mostrar otro archivo (vista previa / ir a definición). */
  ensureModel: (uri: monaco.Uri) => Promise<void>;
}

// ---------- Conversión de tipos ----------

const toPosition = (p: monaco.IPosition): L.Position => ({ line: p.lineNumber - 1, character: p.column - 1 });

const toRange = (r: L.Range): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

const fromRange = (r: monaco.IRange): L.Range => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});

const docId = (model: monaco.editor.ITextModel) => ({ uri: model.uri.toString() });

const toTextEdit = (e: L.TextEdit): monaco.languages.TextEdit => ({ range: toRange(e.range), text: e.newText });

function toMarkdown(doc: string | L.MarkupContent | undefined): string | monaco.IMarkdownString | undefined {
  if (doc === undefined) return undefined;
  if (typeof doc === "string") return doc;
  return doc.kind === "markdown" ? { value: doc.value } : doc.value;
}

function hoverContents(c: L.Hover["contents"]): monaco.IMarkdownString[] {
  const one = (m: L.MarkupContent | L.MarkedString): monaco.IMarkdownString => {
    if (typeof m === "string") return { value: m };
    if ("kind" in m) return { value: m.value };
    return { value: "```" + m.language + "\n" + m.value + "\n```" };
  };
  return Array.isArray(c) ? c.map(one) : [one(c)];
}

// LSP CompletionItemKind (1..25) → Monaco
const K = monaco.languages.CompletionItemKind;
const COMPLETION_KIND = [
  K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface,
  K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File,
  K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter,
];

type LspSuggestion = monaco.languages.CompletionItem & { _lsp: L.CompletionItem };

function toSuggestion(it: L.CompletionItem, fallback: monaco.IRange): LspSuggestion {
  let range: monaco.languages.CompletionItem["range"] = fallback;
  let text = it.insertText ?? it.label;
  if (it.textEdit) {
    text = it.textEdit.newText;
    range = "range" in it.textEdit
      ? toRange(it.textEdit.range)
      : { insert: toRange(it.textEdit.insert), replace: toRange(it.textEdit.replace) };
  }
  return {
    label: it.labelDetails
      ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description }
      : it.label,
    kind: COMPLETION_KIND[(it.kind ?? 1) - 1] ?? K.Text,
    detail: it.detail,
    documentation: toMarkdown(it.documentation),
    insertText: text,
    insertTextRules: it.insertTextFormat === 2
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    range,
    sortText: it.sortText,
    filterText: it.filterText,
    preselect: it.preselect,
    commitCharacters: it.commitCharacters,
    additionalTextEdits: it.additionalTextEdits?.map(toTextEdit),
    tags: it.deprecated || it.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    _lsp: it,
  };
}

function toLocations(res: L.Location | L.Location[] | L.LocationLink[] | null): L.Location[] {
  if (!res) return [];
  const list = Array.isArray(res) ? res : [res];
  return list.map((l) => ("targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l));
}

/** Convierte un WorkspaceEdit de LSP al formato de Monaco, abriendo los archivos afectados. */
async function toWorkspaceEdit(host: ProviderHost, edit: L.WorkspaceEdit | undefined) {
  const out: monaco.languages.WorkspaceEdit = { edits: [] };
  if (!edit) return out;
  const perFile: [string, L.TextEdit[]][] = [];
  if (edit.documentChanges) {
    for (const ch of edit.documentChanges) if ("textDocument" in ch) perFile.push([ch.textDocument.uri, ch.edits]);
  } else if (edit.changes) {
    perFile.push(...Object.entries(edit.changes));
  }
  for (const [rawUri, edits] of perFile) {
    const uri = monaco.Uri.parse(rawUri);
    await host.ensureOpen(uri.fsPath);
    for (const e of edits) out.edits.push({ resource: uri, textEdit: toTextEdit(e), versionId: undefined });
  }
  return out;
}

/** Ejecuta una petición LSP ignorando errores esperables (cancelación, contenido modificado). */
async function ask<T>(host: ProviderHost, method: string, params: unknown, token?: monaco.CancellationToken) {
  const c = host.getClient();
  if (!c) return null;
  try {
    return await c.request<T>(method, params, token);
  } catch (e) {
    if (!isBenign(e)) console.warn(method, e);
    return null;
  }
}

// ---------- Registro ----------

let registered = false;

export function registerRustProviders(host: ProviderHost) {
  if (registered) return;
  registered = true;
  const lang = "rust";

  monaco.languages.registerCompletionItemProvider(lang, {
    triggerCharacters: [".", ":", "'", "("],
    async provideCompletionItems(model, position, context, token) {
      const res = await ask<L.CompletionList | L.CompletionItem[]>(host, "textDocument/completion", {
        textDocument: docId(model),
        position: toPosition(position),
        context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
      }, token);
      if (!res) return { suggestions: [] };
      const items = Array.isArray(res) ? res : res.items;
      const word = model.getWordUntilPosition(position);
      const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        incomplete: !Array.isArray(res) && res.isIncomplete,
        suggestions: items.map((it) => toSuggestion(it, fallback)),
      };
    },
    async resolveCompletionItem(item, token) {
      const lsp = (item as LspSuggestion)._lsp;
      if (!lsp || !host.getClient()?.capabilities.completionProvider?.resolveProvider) return item;
      const r = await ask<L.CompletionItem>(host, "completionItem/resolve", lsp, token);
      if (!r) return item;
      return {
        ...item,
        detail: r.detail ?? item.detail,
        documentation: toMarkdown(r.documentation) ?? item.documentation,
        additionalTextEdits: r.additionalTextEdits?.map(toTextEdit) ?? item.additionalTextEdits,
      };
    },
  });

  monaco.languages.registerHoverProvider(lang, {
    async provideHover(model, position, token) {
      const h = await ask<L.Hover>(host, "textDocument/hover", { textDocument: docId(model), position: toPosition(position) }, token);
      if (!h) return null;
      return { contents: hoverContents(h.contents), range: h.range ? toRange(h.range) : undefined };
    },
  });

  monaco.languages.registerSignatureHelpProvider(lang, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, position, token) {
      const s = await ask<L.SignatureHelp>(host, "textDocument/signatureHelp", { textDocument: docId(model), position: toPosition(position) }, token);
      if (!s || s.signatures.length === 0) return null;
      return {
        value: {
          signatures: s.signatures.map((sig) => ({
            label: sig.label,
            documentation: toMarkdown(sig.documentation),
            parameters: (sig.parameters ?? []).map((p) => ({ label: p.label, documentation: toMarkdown(p.documentation) })),
            activeParameter: sig.activeParameter,
          })),
          activeSignature: s.activeSignature ?? 0,
          activeParameter: s.activeParameter ?? 0,
        },
        dispose() {},
      };
    },
  });

  // Ir a definición / tipo / implementación / referencias.
  const locationProvider = (method: string) =>
    async (model: monaco.editor.ITextModel, position: monaco.Position, token: monaco.CancellationToken) => {
      const res = await ask<L.Location | L.Location[] | L.LocationLink[]>(host, method, {
        textDocument: docId(model),
        position: toPosition(position),
        context: { includeDeclaration: true },
      }, token);
      const locs = toLocations(res);
      await Promise.all(locs.map((l) => host.ensureModel(monaco.Uri.parse(l.uri))));
      return locs.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
    };
  monaco.languages.registerDefinitionProvider(lang, { provideDefinition: locationProvider("textDocument/definition") });
  monaco.languages.registerTypeDefinitionProvider(lang, { provideTypeDefinition: locationProvider("textDocument/typeDefinition") });
  monaco.languages.registerImplementationProvider(lang, { provideImplementation: locationProvider("textDocument/implementation") });
  const references = locationProvider("textDocument/references");
  monaco.languages.registerReferenceProvider(lang, {
    provideReferences: (model, position, _context, token) => references(model, position, token),
  });

  monaco.languages.registerDocumentHighlightProvider(lang, {
    async provideDocumentHighlights(model, position, token) {
      const res = await ask<{ range: L.Range; kind?: number }[]>(host, "textDocument/documentHighlight", {
        textDocument: docId(model),
        position: toPosition(position),
      }, token);
      return (res ?? []).map((h) => ({ range: toRange(h.range), kind: (h.kind ?? 1) - 1 }));
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(lang, {
    displayName: "rustfmt",
    async provideDocumentFormattingEdits(model, options, token) {
      const edits = await ask<L.TextEdit[]>(host, "textDocument/formatting", {
        textDocument: docId(model),
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      }, token);
      return (edits ?? []).map(toTextEdit);
    },
  });

  monaco.languages.registerRenameProvider(lang, {
    async provideRenameEdits(model, position, newName, token) {
      const edit = await ask<L.WorkspaceEdit>(host, "textDocument/rename", {
        textDocument: docId(model),
        position: toPosition(position),
        newName,
      }, token);
      if (!edit) return { edits: [], rejectReason: t("No se pudo renombrar este elemento.") };
      return toWorkspaceEdit(host, edit);
    },
    async resolveRenameLocation(model, position, token) {
      const r = await ask<L.Range | { range: L.Range; placeholder: string } | null>(host, "textDocument/prepareRename", {
        textDocument: docId(model),
        position: toPosition(position),
      }, token);
      if (!r) return { range: new monaco.Range(1, 1, 1, 1), text: "", rejectReason: t("Este elemento no se puede renombrar.") };
      const range = toRange("range" in r ? r.range : r);
      return { range, text: "placeholder" in r ? r.placeholder : model.getValueInRange(range) };
    },
  });

  // Acciones rápidas (Ctrl/⌘ + .): importar, corregir errores, refactorizar…
  monaco.languages.registerCodeActionProvider(lang, {
    async provideCodeActions(model, range, context, token) {
      const c = host.getClient();
      if (!c) return { actions: [], dispose() {} };
      const lspRange = fromRange(range);
      const inRange = (d: L.Diagnostic) =>
        !(d.range.end.line < lspRange.start.line || d.range.start.line > lspRange.end.line);
      const diagnostics = (c.diagnostics.get(model.uri.toString()) ?? []).filter(inRange);
      const res = await ask<(L.CodeAction | L.Command)[]>(host, "textDocument/codeAction", {
        textDocument: docId(model),
        range: lspRange,
        context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger },
      }, token);
      const actions: monaco.languages.CodeAction[] = [];
      for (const a of res ?? []) {
        if (typeof (a as L.Command).command === "string") continue; // comandos sueltos: no soportados aún
        const ca = a as L.CodeAction;
        actions.push(Object.assign(
          {
            title: ca.title,
            kind: ca.kind,
            isPreferred: ca.isPreferred,
            disabled: ca.disabled?.reason,
            edit: ca.edit ? await toWorkspaceEdit(host, ca.edit) : undefined,
          },
          { _lsp: ca },
        ));
      }
      return { actions, dispose() {} };
    },
    async resolveCodeAction(action, token) {
      const lsp = (action as monaco.languages.CodeAction & { _lsp?: L.CodeAction })._lsp;
      if (!lsp || action.edit) return action;
      const r = await ask<L.CodeAction>(host, "codeAction/resolve", lsp, token);
      if (r?.edit) action.edit = await toWorkspaceEdit(host, r.edit);
      return action;
    },
  }, { providedCodeActionKinds: ["quickfix", "refactor"] });

  // Pistas de tipos en línea (como `: i32` en gris).
  monaco.languages.registerInlayHintsProvider(lang, {
    onDidChangeInlayHints: inlayHintsRefresh.event,
    async provideInlayHints(model, range, token) {
      const res = await ask<L.InlayHint[]>(host, "textDocument/inlayHint", {
        textDocument: docId(model),
        range: fromRange(range),
      }, token);
      return {
        hints: (res ?? []).map((h) => ({
          label: typeof h.label === "string" ? h.label : h.label.map((p) => ({ label: p.value })),
          position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
          kind: h.kind === 2 ? monaco.languages.InlayHintKind.Parameter : monaco.languages.InlayHintKind.Type,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
        })),
        dispose() {},
      };
    },
  });
}
