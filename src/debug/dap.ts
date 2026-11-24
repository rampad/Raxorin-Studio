// Cliente mínimo del Debug Adapter Protocol (DAP) para lldb-dap.
// El transporte lo hace el backend (src-tauri/src/dap.rs).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Source { name?: string; path?: string }
export interface StackFrame { id: number; name: string; source?: Source; line: number; column: number }
export interface Scope { name: string; variablesReference: number; expensive: boolean }
export interface Variable { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string }
export interface Breakpoint { id?: number; verified: boolean; line?: number; message?: string }

type Listener = (body: any) => void;

export class DapError extends Error {}

export class DapClient {
  private seq = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void; command: string }>();
  private listeners = new Map<string, Listener[]>();
  private unlisteners: UnlistenFn[] = [];
  private closed = false;
  capabilities: Record<string, unknown> = {};

  static async start(): Promise<DapClient> {
    const c = new DapClient();
    c.unlisteners.push(await listen<string>("dap-message", (e) => c.receive(e.payload)));
    c.unlisteners.push(await listen("dap-exit", () => c.emit("$exit", null)));
    await invoke("dap_start");
    return c;
  }

  request<T = any>(command: string, args: unknown = {}): Promise<T> {
    if (this.closed) return Promise.reject(new DapError("La sesión de depuración terminó"));
    const seq = this.seq++;
    const p = new Promise<T>((resolve, reject) => this.pending.set(seq, { resolve, reject, command }));
    this.send({ seq, type: "request", command, arguments: args });
    return p;
  }

  on(event: string, fn: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }

  private emit(event: string, body: unknown) {
    this.listeners.get(event)?.forEach((fn) => fn(body));
  }

  private send(msg: object) {
    invoke("dap_send", { msg: JSON.stringify(msg) }).catch(() => {});
  }

  private receive(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "response") {
      const p = this.pending.get(m.request_seq);
      if (!p) return;
      this.pending.delete(m.request_seq);
      if (m.success) p.resolve(m.body ?? {});
      else p.reject(new DapError(m.message || m.body?.error?.format || `Falló “${p.command}”`));
    } else if (m.type === "event") {
      this.emit(m.event, m.body ?? {});
    } else if (m.type === "request") {
      // Peticiones inversas (p. ej. runInTerminal): no las usamos.
      this.send({ seq: this.seq++, type: "response", request_seq: m.seq, command: m.command, success: false, message: "no soportado" });
    }
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.unlisteners.forEach((u) => u());
    this.pending.forEach((p) => p.reject(new DapError("La sesión de depuración terminó")));
    this.pending.clear();
    await invoke("dap_stop").catch(() => {});
  }
}
