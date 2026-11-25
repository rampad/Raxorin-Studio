// Puntos de interrupción: se guardan por proyecto, se dibujan en el margen
// del editor (punto rojo) y siguen a su línea cuando editas el archivo.

import * as monaco from "monaco-editor";
import { t } from "../i18n/index.ts";

export interface BreakpointInfo {
  path: string;
  line: number;
  enabled: boolean;
  /** Solo detenerse si esta expresión es verdadera (p. ej. `i == 5`). */
  condition?: string;
  /** Detenerse a partir de la N-ésima vez que se pasa por la línea. */
  hitCondition?: string;
  /** Punto de registro: escribe este mensaje (con `{expr}`) y NO detiene el programa. */
  logMessage?: string;
  /** undefined = aún no se sabe (no hay sesión); false = el depurador no pudo colocarlo. */
  verified?: boolean;
  message?: string;
}

type Listener = () => void;

const keyFor = (root: string) => `raxorinstudio.breakpoints:${root}`;

export class BreakpointStore {
  private files = new Map<string, BreakpointInfo[]>();
  private decorations = new Map<string, string[]>(); // uri → ids de decoraciones
  private listeners = new Set<Listener>();
  /** Avisos de cambios hechos por el usuario (no los de "verificado"), por archivo. */
  private editListeners = new Set<(path: string) => void>();
  private root: string | null = null;
  private version = 0;
  private currentLine: { path: string; line: number } | null = null;

  constructor() {
    monaco.editor.getModels().forEach((m) => this.track(m));
    monaco.editor.onDidCreateModel((m) => this.track(m));
  }

  // ---------- Suscripción (para React) ----------
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  onEdit(fn: (path: string) => void) {
    this.editListeners.add(fn);
    return () => this.editListeners.delete(fn);
  }
  private edited(path: string) {
    this.editListeners.forEach((fn) => fn(path));
  }
  private changed(persist = true) {
    this.version++;
    if (persist) this.save();
    this.listeners.forEach((fn) => fn());
  }

  // ---------- Persistencia por proyecto ----------
  load(root: string | null) {
    this.root = root;
    this.files.clear();
    if (root) {
      try {
        const saved = JSON.parse(localStorage.getItem(keyFor(root)) ?? "[]") as BreakpointInfo[];
        for (const b of saved) this.files.set(b.path, [...(this.files.get(b.path) ?? []), { ...b, verified: undefined }]);
      } catch {
        /* sin almacenamiento */
      }
    }
    monaco.editor.getModels().forEach((m) => this.render(m));
    this.changed(false);
  }

  private save() {
    if (!this.root) return;
    try {
      const data = this.all().map(({ path, line, enabled, condition, hitCondition, logMessage }) => ({
        path, line, enabled, condition, hitCondition, logMessage,
      }));
      localStorage.setItem(keyFor(this.root), JSON.stringify(data));
    } catch {
      /* sin almacenamiento */
    }
  }

  // ---------- Consultas y cambios ----------
  all(): BreakpointInfo[] {
    return [...this.files.values()].flat().sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }
  forFile(path: string): BreakpointInfo[] {
    return this.files.get(path) ?? [];
  }
  get(path: string, line: number): BreakpointInfo | undefined {
    return this.forFile(path).find((b) => b.line === line);
  }

  /** Crea o modifica el punto de una línea (al agregarlo manualmente o editarlo). */
  upsert(path: string, line: number, patch: Partial<Pick<BreakpointInfo, "condition" | "hitCondition" | "logMessage" | "enabled">>, oldLine?: number) {
    const list = this.forFile(path).filter((b) => b.line !== (oldLine ?? line) && b.line !== line);
    const prev = this.get(path, oldLine ?? line);
    const clean = (v?: string) => (v && v.trim() ? v.trim() : undefined);
    list.push({
      path,
      line,
      enabled: patch.enabled ?? prev?.enabled ?? true,
      condition: clean(patch.condition),
      hitCondition: clean(patch.hitCondition),
      logMessage: clean(patch.logMessage),
    });
    list.sort((a, b) => a.line - b.line);
    this.set(path, list);
  }

  toggle(path: string, line: number) {
    const list = this.files.get(path) ?? [];
    const i = list.findIndex((b) => b.line === line);
    if (i >= 0) list.splice(i, 1);
    else list.push({ path, line, enabled: true });
    this.set(path, list);
  }

  setEnabled(path: string, line: number, enabled: boolean) {
    const list = this.forFile(path).map((b) => (b.line === line ? { ...b, enabled } : b));
    this.set(path, list);
  }

  remove(path: string, line: number) {
    this.set(path, this.forFile(path).filter((b) => b.line !== line));
  }

  removeAll() {
    const paths = [...this.files.keys()];
    this.files.clear();
    paths.forEach((p) => this.renderPath(p));
    this.changed();
    paths.forEach((p) => this.edited(p));
  }

  /** Resultado de setBreakpoints: el depurador puede mover la línea o rechazarlo. */
  setVerified(path: string, results: { verified: boolean; line?: number; message?: string }[]) {
    const enabled = this.forFile(path).filter((b) => b.enabled);
    enabled.forEach((b, i) => {
      b.verified = results[i]?.verified ?? false;
      b.message = results[i]?.message;
    });
    this.renderPath(path);
    this.changed(false);
  }

  clearVerified() {
    for (const list of this.files.values()) list.forEach((b) => (b.verified = undefined));
    monaco.editor.getModels().forEach((m) => this.render(m));
    this.changed(false);
  }

  private set(path: string, list: BreakpointInfo[]) {
    if (list.length) this.files.set(path, list);
    else this.files.delete(path);
    this.renderPath(path);
    this.changed();
    this.edited(path);
  }

  // ---------- Línea actual de ejecución ----------
  setCurrentLine(loc: { path: string; line: number } | null) {
    const prev = this.currentLine;
    this.currentLine = loc;
    if (prev) this.renderPath(prev.path);
    if (loc) this.renderPath(loc.path);
  }

  // ---------- Decoraciones en el editor ----------
  private renderPath(path: string) {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model) this.render(model);
  }

  private render(model: monaco.editor.ITextModel) {
    if (model.uri.scheme !== "file") return;
    const path = model.uri.fsPath;
    const uri = model.uri.toString();
    const decos: monaco.editor.IModelDeltaDecoration[] = this.forFile(path).map((b) => ({
      range: new monaco.Range(b.line, 1, b.line, 1),
      options: {
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        glyphMarginClassName: [
          "bp-glyph",
          b.logMessage ? "log" : b.condition || b.hitCondition ? "cond" : "",
          !b.enabled ? "disabled" : b.verified === false ? "unverified" : "",
        ].filter(Boolean).join(" "),
        glyphMarginHoverMessage: { value: describeBreakpoint(b) + "\n\n*Clic: quitar · Clic derecho: editar*" },
        className: b.enabled && !b.logMessage ? "bp-line" : undefined,
      },
    }));
    if (this.currentLine && this.currentLine.path === path) {
      decos.push({
        range: new monaco.Range(this.currentLine.line, 1, this.currentLine.line, 1),
        options: { isWholeLine: true, className: "debug-current-line", glyphMarginClassName: "debug-current-glyph", zIndex: 10 },
      });
    }
    // Ids de decoraciones previas de los puntos (las de la línea actual no se rastrean).
    this.decorations.set(uri, model.deltaDecorations(this.decorations.get(uri) ?? [], decos));
  }

  /** Mantiene las líneas sincronizadas cuando el usuario edita el archivo. */
  private track(model: monaco.editor.ITextModel) {
    if (model.uri.scheme !== "file") return;
    this.render(model);
    model.onDidChangeContent(() => {
      const path = model.uri.fsPath;
      const list = this.files.get(path);
      const ids = this.decorations.get(model.uri.toString());
      if (!list || !ids) return;
      let moved = false;
      list.forEach((b, i) => {
        const r = ids[i] ? model.getDecorationRange(ids[i]) : null;
        if (r && r.startLineNumber !== b.line) {
          b.line = r.startLineNumber;
          moved = true;
        }
      });
      if (moved) {
        // Quitar duplicados si dos puntos terminaron en la misma línea.
        this.files.set(path, list.filter((b, i) => list.findIndex((x) => x.line === b.line) === i));
        this.changed();
        this.edited(path);
      }
    });
    model.onWillDispose(() => this.decorations.delete(model.uri.toString()));
  }
}

/** Texto para el usuario: qué hace este punto. */
export function describeBreakpoint(b: BreakpointInfo): string {
  const parts: string[] = [];
  if (b.logMessage) parts.push(t("**Punto de registro:** escribe `{0}` sin detener el programa", b.logMessage));
  else if (b.condition && b.hitCondition) parts.push(t("**Se detiene** cuando `{0}`, a partir de la vez {1}", b.condition, b.hitCondition));
  else if (b.condition) parts.push(t("**Se detiene** solo cuando `{0}`", b.condition));
  else if (b.hitCondition) parts.push(t("**Se detiene** a partir de la vez número {0}", b.hitCondition));
  else parts.push(t("**Punto de interrupción**"));
  if (!b.enabled) parts.push("(desactivado)");
  if (b.verified === false) parts.push(t("— no colocado{0}", b.message ? ": " + b.message : t(" (¿línea sin código?)")));
  return parts.join(" ");
}
