// Sesión de depuración: arranca lldb-dap, envía los puntos de interrupción,
// sigue el estado (ejecutando / detenido) y ofrece pila, variables y evaluación.

import { invoke } from "@tauri-apps/api/core";
import { DapClient, type StackFrame, type Variable } from "./dap";
import type { BreakpointStore } from "./breakpoints";
import { t, tErr } from "../i18n/index.ts";

export type DebugStatus = "idle" | "starting" | "running" | "stopped";

export interface WatchResult { expr: string; value?: string; type?: string; error?: string; ref: number }

export interface DebugSnapshot {
  status: DebugStatus;
  reason?: string;
  description?: string;
  threadId?: number;
  frames: StackFrame[];
  frameId?: number;
  /** Variables locales del marco seleccionado. */
  locals: Variable[];
  /** variablesReference del ámbito de las locales (para editar valores). */
  localsRef: number;
  /** Hilos del programa (al estar detenido). */
  threads: { id: number; name: string }[];
  /** Hilo cuya pila se está mostrando. */
  viewThreadId?: number;
  watches: WatchResult[];
  /** Aumenta en cada detención (para invalidar árboles de variables). */
  stopCount: number;
  stdin: boolean;
}

export interface DebugHost {
  output: (text: string, kind: "stdout" | "muted" | "warning" | "error" | "success" | "info") => void;
  /** Abre el archivo y resalta la línea donde se detuvo. */
  showLocation: (path: string, line: number) => void;
  /** ¿El archivo pertenece al proyecto? (para saltar el código de la biblioteca estándar) */
  isUserCode: (path: string) => boolean;
  onStopped: () => void;
  onEnded: () => void;
}

export interface StartOptions {
  program: string;
  /** Depurador en uso: cambia algunos campos de la configuración de inicio. */
  kind: "lldb-dap" | "codelldb" | null;
  cwd: string;
  formatters: string | null;
  /** Limita la profundidad de los formateadores (tipos recursivos como los de Slint). */
  formatterGuard: string | null;
  stdinSupported: boolean;
  /** "Ejecutar hasta el cursor" antes de iniciar: punto de un solo uso. */
  runTo?: { path: string; line: number };
}

const WATCH_KEY = "raxorinstudio.watches";
const IGNORED_OUTPUT = /no plugin for the language "rust"|^Running initCommands|^Running preRunCommands|^\(lldb\) (command script import|settings set|breakpoint set)|^Console is in '|^Launching: |^Launched process|^Process exited with code|^Executing script: |^Breakpoint \d+:/;

export class DebugController {
  private client: DapClient | null = null;
  private listeners = new Set<() => void>();
  private snap: DebugSnapshot = { status: "idle", frames: [], locals: [], localsRef: 0, threads: [], watches: [], stopCount: 0, stdin: false };
  private watchExprs: string[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(WATCH_KEY) ?? "[]");
    } catch {
      return [];
    }
  })();
  private lastStart: StartOptions | null = null;

  constructor(private breakpoints: BreakpointStore, private host: DebugHost) {
    this.snap.watches = this.watchExprs.map((expr) => ({ expr, ref: 0 }));
    // Solo los cambios del usuario se reenvían al depurador (evita un bucle con "verificado").
    breakpoints.onEdit((path) => {
      if (this.client && this.snap.status !== "starting") void this.sendBreakpoints(path);
    });
  }

  // ---------- Suscripción (useSyncExternalStore) ----------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  private update(patch: Partial<DebugSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  get active() {
    return this.snap.status !== "idle";
  }

  // ---------- Inicio ----------
  async start(opts: StartOptions) {
    if (this.client) await this.stop();
    this.lastStart = opts;
    this.update({ status: "starting", frames: [], locals: [], reason: undefined, description: undefined, frameId: undefined });

    let stdinPath: string | null = null;
    if (opts.stdinSupported) stdinPath = await invoke<string | null>("debug_stdin_create").catch(() => null);

    let client: DapClient;
    try {
      client = await DapClient.start();
    } catch (e) {
      this.host.output(`${e}\n`, "error");
      this.update({ status: "idle" });
      this.host.onEnded();
      return;
    }
    this.client = client;

    client.on("output", (b: { category?: string; output: string }) => {
      if (b.category === "telemetry") return;
      const text = (b.output ?? "").replace(/\r\n/g, "\n");
      if (b.category === "stdout" || b.category === "stderr") this.host.output(text, "stdout");
      else if (!IGNORED_OUTPUT.test(text.trim())) this.host.output(text, b.category === "important" ? "warning" : "muted");
    });
    client.on("initialized", async () => {
      try {
        await this.sendAllBreakpoints();
        await client.request("configurationDone");
      } catch (e) {
        this.host.output(t("No se pudo configurar el depurador: {0}\n", tErr(e)), "error");
      }
    });
    client.on("stopped", (b: { reason: string; threadId?: number; description?: string; text?: string }) => this.onStopped(b));
    client.on("continued", () => this.markRunning());
    client.on("exited", (b: { exitCode: number }) => {
      this.host.output(
        t("\n{0} El programa terminó con código {1}\n", b.exitCode === 0 ? "✔" : "✖", b.exitCode),
        b.exitCode === 0 ? "success" : "error",
      );
    });
    client.on("terminated", () => void this.end());
    client.on("$exit", () => void this.end());

    try {
      await client.request("initialize", {
        clientID: "raxorin-studio",
        clientName: "Raxorin Studio",
        adapterID: opts.kind === "codelldb" ? "lldb" : "lldb-dap",
        locale: "es",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsVariableType: true,
        supportsRunInTerminalRequest: false,
      });
      const preRunCommands = [
        // Detenerse cuando el programa entra en pánico (como una excepción en C#).
        "breakpoint set --name rust_panic",
        ...(stdinPath ? [`settings set target.input-path "${stdinPath}"`] : []),
        ...(opts.runTo ? [oneShot(opts.runTo.path, opts.runTo.line)] : []),
      ];
      // CodeLLDB: trae su propio soporte de Rust (sourceLanguages) y la salida del programa
      // llega como eventos "output" (terminal "console").
      const codelldb = opts.kind === "codelldb";
      await client.request("launch", codelldb ? {
        type: "lldb",
        request: "launch",
        program: opts.program,
        cwd: opts.cwd,
        stopOnEntry: false,
        terminal: "console",
        sourceLanguages: ["rust"],
        preRunCommands,
      } : {
        program: opts.program,
        cwd: opts.cwd,
        stopOnEntry: false,
        // Mostrar Vec, String, Option… de forma legible.
        initCommands: opts.formatters
          ? [
              `command script import "${opts.formatters}"`,
              ...(opts.formatterGuard ? [`command script import "${opts.formatterGuard}"`] : []),
            ]
          : [],
        preRunCommands,
      });
      this.update({ stdin: !!stdinPath });
      this.markRunning();
      const n = this.breakpoints.all().filter((b) => b.enabled).length;
      this.host.output(
        n > 0
          ? t("▶ Depurando. Se detendrá al llegar a uno de tus {0} punto(s) de interrupción ", n) +
              t("(si está dentro de un evento, como el clic de un botón, primero usa ese control en la ventana).\n")
          : t("▶ Depurando. No hay puntos de interrupción: pon uno con clic en el margen o F9.\n"),
        "info",
      );
      const windows = navigator.userAgent.includes("Windows");
      this.host.output(
        stdinPath
          ? ""
          : windows && codelldb
            ? t("(En Windows el programa se abre en su propia ventana de consola: ahí ves lo que imprime y puedes escribirle.)\n")
            : t("(La entrada por teclado no está disponible al depurar en este sistema)\n"),
        "muted",
      );
    } catch (e) {
      this.host.output(t("No se pudo iniciar la depuración: {0}\n", tErr(e)), "error");
      await this.end();
    }
  }

  private markRunning() {
    this.breakpoints.setCurrentLine(null);
    this.update({ status: "running", frames: [], locals: [], localsRef: 0, threads: [], reason: undefined, description: undefined });
  }

  // ---------- Detenido ----------
  private async onStopped(b: { reason: string; threadId?: number; description?: string; text?: string }) {
    const client = this.client;
    if (!client) return;
    const threadId = b.threadId ?? (await client.request<{ threads: { id: number }[] }>("threads")).threads[0]?.id;
    if (threadId === undefined) return;
    const { stackFrames } = await client
      .request<{ stackFrames: StackFrame[] }>("stackTrace", { threadId, startFrame: 0, levels: 60 })
      .catch(() => ({ stackFrames: [] as StackFrame[] }));

    const threads = await client
      .request<{ threads: { id: number; name: string }[] }>("threads")
      .then((r) => r.threads)
      .catch(() => []);
    const panic = stackFrames.some((f) => /rust_panic|panic_fmt|begin_panic/.test(f.name));
    // Mostrar el primer marco que sea código del usuario (no la biblioteca estándar).
    const frame = stackFrames.find((f) => f.source?.path && this.host.isUserCode(f.source.path)) ?? stackFrames[0];
    const reason = panic ? "panic" : b.reason;
    this.update({
      status: "stopped",
      reason,
      description: panic ? t("El programa entró en pánico (panic!)") : describe(b.reason, b.description),
      threadId,
      viewThreadId: threadId,
      threads,
      frames: stackFrames,
      stopCount: this.snap.stopCount + 1,
    });
    if (panic) this.host.output(t("\n✖ El programa entró en pánico. Revisa la pila de llamadas y las variables.\n"), "error");
    if (frame) await this.selectFrame(frame.id);
    this.host.onStopped();
  }

  async selectFrame(frameId: number) {
    const frame = this.snap.frames.find((f) => f.id === frameId);
    if (!this.client || !frame) return;
    this.update({ frameId });
    if (frame.source?.path) {
      this.breakpoints.setCurrentLine({ path: frame.source.path, line: frame.line });
      if (this.host.isUserCode(frame.source.path)) this.host.showLocation(frame.source.path, frame.line);
    } else this.breakpoints.setCurrentLine(null);
    await this.refreshValues();
  }

  /** Vuelve a leer las variables locales y las inspecciones del marco actual. */
  private async refreshValues() {
    const frameId = this.snap.frameId;
    if (frameId === undefined) return;
    const { vars, ref } = await this.localsFor(frameId);
    const watches = await this.evaluateWatches(frameId);
    this.update({ locals: vars, localsRef: ref, watches });
  }

  private async localsFor(frameId: number): Promise<{ vars: Variable[]; ref: number }> {
    if (!this.client) return { vars: [], ref: 0 };
    try {
      const { scopes } = await this.client.request<{ scopes: { name: string; variablesReference: number }[] }>("scopes", { frameId });
      const local = scopes.find((s) => /local/i.test(s.name)) ?? scopes[0];
      return local ? { vars: await this.variables(local.variablesReference), ref: local.variablesReference } : { vars: [], ref: 0 };
    } catch {
      return { vars: [], ref: 0 };
    }
  }

  /** Cambia el valor de una variable mientras el programa está detenido. */
  async setVariable(parentRef: number, name: string, value: string): Promise<string | null> {
    if (!this.client || this.snap.status !== "stopped") return t("El programa no está detenido");
    try {
      await this.client.request("setVariable", { variablesReference: parentRef, name, value });
      // Las referencias cambian: volver a leer todo (y reiniciar los árboles expandidos).
      this.update({ stopCount: this.snap.stopCount + 1 });
      await this.refreshValues();
      this.host.output(`✎ ${name} = ${value}\n`, "info");
      return null;
    } catch (e) {
      return tErr(e).replace(/^.*?Error:\s*/, "");
    }
  }

  /** Muestra la pila de otro hilo. */
  async selectThread(threadId: number) {
    if (!this.client || this.snap.status !== "stopped") return;
    const { stackFrames } = await this.client
      .request<{ stackFrames: StackFrame[] }>("stackTrace", { threadId, startFrame: 0, levels: 60 })
      .catch(() => ({ stackFrames: [] as StackFrame[] }));
    this.update({ viewThreadId: threadId, frames: stackFrames });
    const frame = stackFrames.find((f) => f.source?.path && this.host.isUserCode(f.source.path)) ?? stackFrames[0];
    if (frame) await this.selectFrame(frame.id);
  }

  /**
   * Consola de depuración (como la ventana Inmediato de Visual Studio).
   * Las líneas que empiezan con ` son comandos de LLDB.
   */
  async repl(input: string): Promise<{ ok: boolean; text: string }> {
    if (!this.client || this.snap.status !== "stopped") {
      return { ok: false, text: t("Detén el programa en un punto de interrupción para evaluar expresiones.") };
    }
    try {
      const r = await this.client.request<{ result: string; type?: string }>("evaluate", {
        expression: input,
        frameId: this.snap.frameId,
        context: "repl",
      });
      // "(int) $0 = 300" → "300"
      const text = input.startsWith("`") ? r.result.trim() : r.result.replace(/^\([^)]*\)\s*\$\d+\s*=\s*/, "").trim();
      // Si cambió algo (p. ej. `i = 5`), refrescar las variables.
      if (/[^=!<>]=[^=]/.test(input)) {
        this.update({ stopCount: this.snap.stopCount + 1 });
        await this.refreshValues();
      }
      return { ok: true, text };
    } catch (e) {
      return { ok: false, text: tErr(e).replace(/^.*?Error:\s*/, "") };
    }
  }

  async variables(ref: number): Promise<Variable[]> {
    if (!this.client || !ref) return [];
    try {
      return (await this.client.request<{ variables: Variable[] }>("variables", { variablesReference: ref })).variables;
    } catch {
      return [];
    }
  }

  async evaluate(expression: string, context: "watch" | "hover" | "repl" = "watch") {
    if (!this.client || this.snap.status !== "stopped") throw new Error(t("El programa no está detenido"));
    return this.client.request<{ result: string; type?: string; variablesReference: number }>("evaluate", {
      expression,
      frameId: this.snap.frameId,
      context,
    });
  }

  // ---------- Inspección (watch) ----------
  private async evaluateWatches(frameId: number | undefined): Promise<WatchResult[]> {
    return Promise.all(
      this.watchExprs.map(async (expr) => {
        if (!this.client || frameId === undefined) return { expr, ref: 0 };
        try {
          const r = await this.evaluate(expr, "watch");
          return { expr, value: r.result, type: r.type, ref: r.variablesReference };
        } catch (e) {
          return { expr, error: tErr(e).replace(/^.*?:\s*/, ""), ref: 0 };
        }
      }),
    );
  }

  async addWatch(expr: string) {
    expr = expr.trim();
    if (!expr || this.watchExprs.includes(expr)) return;
    this.watchExprs.push(expr);
    this.saveWatches();
    this.update({ watches: await this.evaluateWatches(this.snap.status === "stopped" ? this.snap.frameId : undefined) });
  }

  async removeWatch(expr: string) {
    this.watchExprs = this.watchExprs.filter((e) => e !== expr);
    this.saveWatches();
    this.update({ watches: this.snap.watches.filter((w) => w.expr !== expr) });
  }

  private saveWatches() {
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(this.watchExprs));
    } catch {
      /* sin almacenamiento */
    }
  }

  // ---------- Puntos de interrupción ----------
  async sendBreakpoints(path: string) {
    if (!this.client) return;
    const enabled = this.breakpoints.forFile(path).filter((b) => b.enabled);
    try {
      const res = await this.client.request<{ breakpoints: { verified: boolean; line?: number; message?: string }[] }>(
        "setBreakpoints",
        {
          source: { path },
          breakpoints: enabled.map((b) => ({
            line: b.line,
            condition: b.condition,
            hitCondition: b.hitCondition,
            logMessage: b.logMessage,
          })),
          sourceModified: false,
        },
      );
      this.breakpoints.setVerified(path, res.breakpoints);
    } catch {
      /* el adaptador ya terminó */
    }
  }

  private sentFiles = new Set<string>();
  async sendAllBreakpoints() {
    const files = new Set([...this.breakpoints.all().map((b) => b.path), ...this.sentFiles]);
    this.sentFiles = new Set(this.breakpoints.all().map((b) => b.path));
    for (const f of files) await this.sendBreakpoints(f);
  }

  // ---------- Controles ----------
  private thread() {
    return this.snap.threadId ?? 0;
  }
  continue = () => this.client?.request("continue", { threadId: this.thread() }).then(() => this.markRunning()).catch(() => {});
  stepOver = () => this.step("next");
  stepInto = () => this.step("stepIn");
  stepOut = () => this.step("stepOut");
  pause = () => this.client?.request("pause", { threadId: this.thread() }).catch(() => {});

  private step(cmd: string) {
    if (this.snap.status !== "stopped") return;
    this.client?.request(cmd, { threadId: this.thread() }).then(() => this.markRunning()).catch(() => {});
  }

  /** Continúa hasta llegar a esa línea (punto de interrupción de un solo uso). */
  async runToCursor(path: string, line: number) {
    if (!this.client || this.snap.status !== "stopped") return;
    try {
      await this.client.request("evaluate", { expression: "`" + oneShot(path, line), frameId: this.snap.frameId, context: "repl" });
      await this.continue();
    } catch (e) {
      this.host.output(t("No se pudo ejecutar hasta el cursor: {0}\n", tErr(e)), "error");
    }
  }

  async stop() {
    const c = this.client;
    if (!c) return;
    // Pedir que cierre el programa; si no responde, el backend igual lo cierra de forma ordenada.
    await Promise.race([c.request("disconnect", { terminateDebuggee: true }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    await this.end();
  }

  async restart() {
    const opts = this.lastStart ? { ...this.lastStart, runTo: undefined } : null;
    await this.stop();
    if (opts) await this.start(opts);
  }

  private async end() {
    const c = this.client;
    if (!c) return;
    this.client = null;
    await c.dispose();
    this.breakpoints.setCurrentLine(null);
    this.breakpoints.clearVerified();
    this.update({ status: "idle", frames: [], locals: [], frameId: undefined, reason: undefined, description: undefined, stdin: false });
    this.host.output(t("■ Depuración finalizada\n"), "muted");
    this.host.onEnded();
  }
}

function describe(reason: string, description?: string) {
  switch (reason) {
    case "breakpoint": return t("Detenido en un punto de interrupción");
    case "step": return "Paso a paso";
    case "pause": return t("En pausa");
    case "exception": return description ? t("Excepción: {0}", description) : t("Excepción");
    case "entry": return t("Al inicio del programa");
    default: return description ?? reason;
  }
}

/** Comando de LLDB: punto de interrupción que se borra solo al alcanzarlo. */
function oneShot(path: string, line: number) {
  return `breakpoint set --one-shot true --file "${path.replace(/"/g, '\\"')}" --line ${line}`;
}
