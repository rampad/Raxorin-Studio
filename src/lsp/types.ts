// Subconjunto de tipos del Language Server Protocol que usamos.

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Location { uri: string; range: Range }
export interface LocationLink { targetUri: string; targetRange: Range; targetSelectionRange: Range }
export interface TextEdit { range: Range; newText: string }
export interface InsertReplaceEdit { newText: string; insert: Range; replace: Range }
export type MarkupContent = { kind: "markdown" | "plaintext"; value: string };
export type MarkedString = string | { language: string; value: string };

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  tags?: (1 | 2)[];
  data?: unknown;
}
export interface PublishDiagnosticsParams { uri: string; diagnostics: Diagnostic[] }

export interface CompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | MarkupContent;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: TextEdit | InsertReplaceEdit;
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  data?: unknown;
}
export interface CompletionList { isIncomplete: boolean; items: CompletionItem[] }

export interface Hover { contents: MarkupContent | MarkedString | MarkedString[]; range?: Range }

export interface SignatureHelp {
  signatures: {
    label: string;
    documentation?: string | MarkupContent;
    parameters?: { label: string | [number, number]; documentation?: string | MarkupContent }[];
    activeParameter?: number;
  }[];
  activeSignature?: number;
  activeParameter?: number;
}

export interface TextDocumentEdit { textDocument: { uri: string; version?: number | null }; edits: TextEdit[] }
export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: (TextDocumentEdit | { kind: string })[];
}

export interface Command { title: string; command: string; arguments?: unknown[] }
export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
  data?: unknown;
}

export interface InlayHint {
  position: Position;
  label: string | { value: string; tooltip?: string | MarkupContent }[];
  kind?: 1 | 2;
  tooltip?: string | MarkupContent;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

export interface ServerCapabilities {
  completionProvider?: { resolveProvider?: boolean; triggerCharacters?: string[] };
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  codeActionProvider?: boolean | { resolveProvider?: boolean };
  renameProvider?: boolean | { prepareProvider?: boolean };
  [key: string]: unknown;
}
