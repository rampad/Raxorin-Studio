// Cliente mínimo de Language Server Protocol para rust-analyzer.
// El transporte lo hace el backend (src-tauri/src/lsp.rs); aquí vive el
// protocolo JSON-RPC y la sincronización de documentos con Monaco.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as monaco from "monaco-editor";
import type * as L from "./types";

export class LspError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

/** Errores normales cuando el usuario sigue escribiendo; no hay que mostrarlos. */
export const isBenign = (e: unknown) =>
  e instanceof LspError && (e.code === -32800 || e.code === -32801 || e.code === -32802);

/** Avisa a Monaco que debe volver a pedir las pistas de tipos. */
export const inlayHintsRefresh = new monaco.Emitter<void>();

type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void };
type Listener = (params: any) => void;

export interface ClientOptions {
  root: string;
  clippy: boolean;
  /** Cargo.toml de cada proyecto/workspace de la carpeta (para analizarlos todos). */
  linkedProjects?: string[];
}

/** Traducción de las tareas de progreso más comunes de rust-analyzer. */
const PROGRESS_ES: Record<string, string> = {
  Indexing: "Indexando",
  Fetching: "Leyendo Cargo.toml",
  "Loading proc-macros": "Cargando macros",
  "Building CrateGraph": "Analizando dependencias",
  "Building compile-time-deps": "Compilando dependencias",
  "Building build-artifacts": "Compilando dependencias",
  "Roots Scanned": "Escaneando archivos",
  "cargo check": "Revisando (cargo check)",
  "cargo clippy": "Revisando (clippy)",
};

export class LspClient {
  capabilities: L.ServerCapabilities = {};
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Listener[]>();
  private unlisteners: UnlistenFn[] = [];
  private disposables: monaco.IDisposable[] = [];
  private modelSubs = new Map<string, monaco.IDisposable[]>();
  private progress = new Map<string | number, { title: string; message?: string; percentage?: number }>();
  private disposed = false;
  /** Último conjunto de diagnósticos por URI (para las acciones rápidas). */
  readonly diagnostics = new Map<string, L.Diagnostic[]>();

  private constructor(private opts: ClientOptions) {}

  static async start(opts: ClientOptions): Promise<LspClient> {
    const c = new LspClient(opts);
    c.unlisteners.push(await listen<string>("lsp-message", (e) => c.receive(e.payload)));
    c.unlisteners.push(await listen("lsp-exit", () => c.emit("$/exit", null)));
    await invoke("lsp_start", { root: opts.root });
    await c.initialize();
    c.attachMonaco();
    return c;
  }

  // ---------- JSON-RPC ----------

  request<T = any>(method: string, params: unknown, token?: monaco.CancellationToken): Promise<T> {
    if (this.disposed) return Promise.reject(new LspError(-32800, "cliente cerrado"));
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    token?.onCancellationRequested(() => {
      if (this.pending.has(id)) this.notify("$/cancelRequest", { id });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return p;
  }

  notify(method: string, params: unknown) {
    if (!this.disposed) this.send({ jsonrpc: "2.0", method, params });
  }

  on(method: string, fn: Listener) {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  private emit(method: string, params: unknown) {
    this.listeners.get(method)?.forEach((fn) => fn(params));
  }

  private send(msg: object) {
    invoke("lsp_send", { msg: JSON.stringify(msg) }).catch((e) => console.warn("lsp_send", e));
  }

  private receive(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      // Respuesta a una petición nuestra.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new LspError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      // Petición del servidor: hay que responder siempre.
      this.handleServerRequest(msg.id, msg.method, msg.params);
    } else if (msg.method) {
      this.handleNotification(msg.method, msg.params);
    }
  }

  private handleServerRequest(id: number | string, method: string, _params: any) {
    if (method === "workspace/inlayHint/refresh") inlayHintsRefresh.fire();
    // workDoneProgress/create, registerCapability, etc.: basta con aceptar.
    this.send({ jsonrpc: "2.0", id, result: null });
  }

  private handleNotification(method: string, params: any) {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as L.PublishDiagnosticsParams;
      this.diagnostics.set(monaco.Uri.parse(p.uri).toString(), p.diagnostics);
      this.applyMarkers(p.uri);
    } else if (method === "$/progress") {
      this.handleProgress(params.token, params.value);
    }
    this.emit(method, params);
  }

  private handleProgress(token: string | number, v: any) {
    if (!v || typeof v !== "object") return;
    if (v.kind === "begin") this.progress.set(token, { title: v.title, message: v.message, percentage: v.percentage });
    else if (v.kind === "report") {
      const cur = this.progress.get(token);
      if (cur) this.progress.set(token, { ...cur, message: v.message ?? cur.message, percentage: v.percentage ?? cur.percentage });
    } else if (v.kind === "end") {
      this.progress.delete(token);
      if (this.progress.size === 0) inlayHintsRefresh.fire(); // terminó de indexar
    }
    this.emit("$/statusText", this.statusText());
  }

  /** Texto corto para la barra de estado, o "" si está inactivo. */
  statusText(): string {
    const first = this.progress.values().next().value;
    if (!first) return "";
    const title = PROGRESS_ES[first.title] ?? first.title;
    return first.percentage !== undefined ? `${title} ${first.percentage}%` : `${title}…`;
  }

  // ---------- Ciclo de vida ----------

  private async initialize() {
    const rootUri = monaco.Uri.file(this.opts.root).toString();
    const name = this.opts.root.split(/[\\/]/).filter(Boolean).pop() ?? "proyecto";
    const result = await this.request<{ capabilities: L.ServerCapabilities }>("initialize", {
      processId: null,
      clientInfo: { name: "Raxorin Studio", version: "0.2.0" },
      locale: "es",
      rootUri,
      workspaceFolders: [{ uri: rootUri, name }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        window: { workDoneProgress: true },
        workspace: {
          workspaceFolders: true,
          applyEdit: false,
          workspaceEdit: { documentChanges: true },
          inlayHint: { refreshSupport: true },
        },
        textDocument: {
          synchronization: { didSave: true },
          completion: {
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              insertReplaceSupport: true,
              labelDetailsSupport: true,
              deprecatedSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              parameterInformation: { labelOffsetSupport: true },
              activeParameterSupport: true,
            },
          },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentHighlight: {},
          formatting: {},
          rename: { prepareSupport: true },
          inlayHint: {},
          publishDiagnostics: { tagSupport: { valueSet: [1, 2] } },
          codeAction: {
            isPreferredSupport: true,
            dataSupport: true,
            resolveSupport: { properties: ["edit"] },
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite"],
              },
            },
          },
        },
      },
      // Configuración de rust-analyzer.
      initializationOptions: {
        check: { command: this.opts.clippy ? "clippy" : "check" },
        checkOnSave: true,
        completion: { autoimport: { enable: true } },
        inlayHints: {
          typeHints: { enable: true },
          parameterHints: { enable: true },
          chainingHints: { enable: true },
          closingBraceHints: { enable: false },
        },
        lens: { enable: false },
        ...(this.opts.linkedProjects?.length ? { linkedProjects: this.opts.linkedProjects } : {}),
      },
    });
    this.capabilities = result.capabilities;
    this.notify("initialized", {});
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unlisteners.forEach((u) => u());
    this.disposables.forEach((d) => d.dispose());
    this.modelSubs.forEach((subs) => subs.forEach((d) => d.dispose()));
    this.pending.forEach((p) => p.reject(new LspError(-32800, "cliente cerrado")));
    this.pending.clear();
    for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, "rust-analyzer", []);
    await invoke("lsp_stop").catch(() => {});
  }

  // ---------- Sincronización de documentos ----------

  private attachMonaco() {
    monaco.editor.getModels().forEach((m) => this.openModel(m));
    this.disposables.push(monaco.editor.onDidCreateModel((m) => this.openModel(m)));
  }

  private openModel(model: monaco.editor.ITextModel) {
    if (model.uri.scheme !== "file" || model.getLanguageId() !== "rust") return;
    const uri = model.uri.toString();
    if (this.modelSubs.has(uri)) return;
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "rust", version: model.getVersionId(), text: model.getValue() },
    });
    const change = model.onDidChangeContent(() => {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: model.getVersionId() },
        contentChanges: [{ text: model.getValue() }],
      });
    });
    const close = model.onWillDispose(() => {
      this.notify("textDocument/didClose", { textDocument: { uri } });
      this.modelSubs.get(uri)?.forEach((d) => d.dispose());
      this.modelSubs.delete(uri);
    });
    this.modelSubs.set(uri, [change, close]);
    this.applyMarkers(uri);
  }

  didSave(path: string) {
    const uri = monaco.Uri.file(path).toString();
    if (this.modelSubs.has(uri)) this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  /** Recargar tras cambiar Cargo.toml (p. ej. al agregar un crate). */
  reloadWorkspace() {
    return this.request("rust-analyzer/reloadWorkspace", null).catch(() => {});
  }

  private applyMarkers(rawUri: string) {
    const uri = monaco.Uri.parse(rawUri);
    const model = monaco.editor.getModel(uri);
    if (!model) return;
    const diags = this.diagnostics.get(uri.toString()) ?? [];
    monaco.editor.setModelMarkers(model, "rust-analyzer", diags.map(toMarker));
  }
}

const SEVERITY = [
  monaco.MarkerSeverity.Error, // LSP 1 = Error (índice 0)
  monaco.MarkerSeverity.Warning,
  monaco.MarkerSeverity.Info,
  monaco.MarkerSeverity.Hint,
];

export function toMarker(d: L.Diagnostic): monaco.editor.IMarkerData {
  return {
    severity: SEVERITY[(d.severity ?? 1) - 1] ?? monaco.MarkerSeverity.Error,
    message: d.message,
    source: d.source,
    code: d.code === undefined
      ? undefined
      : d.codeDescription
        ? { value: String(d.code), target: monaco.Uri.parse(d.codeDescription.href) }
        : String(d.code),
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    tags: d.tags?.map((t) => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated)),
  };
}
