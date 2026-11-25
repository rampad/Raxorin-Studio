// Agentes por ACP (Agent Client Protocol, JSON-RPC por stdio): GitHub Copilot (`copilot --acp`) y
// Gemini CLI (`gemini --acp`). El agente pide permiso al editor antes de cada acción
// (session/request_permission) y puede leer y escribir archivos a través del editor (fs/*), así que
// todo cambio pasa por la aprobación.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../i18n/index.ts";
import { backend, resultText } from "./backend";
import { contextNote } from "./prompt";
import { chatTools, READ_ONLY } from "./tools";
import { newId, type ApprovalDetail, type ChatContext, type Host, type Session } from "./types";

/** Cómo se lanza y se explica cada agente ACP. */
export interface AcpAgent {
  program: "copilot" | "gemini";
  label: string;
  args: (model: string) => string[];
  /** Qué decir cuando falta iniciar sesión. */
  loginHint: () => string;
}

export const COPILOT: AcpAgent = {
  program: "copilot",
  label: "Copilot",
  args: (model) => ["--acp", ...(model && model !== "default" ? ["--model", model] : [])],
  loginHint: () => t("Copilot no tiene la sesión iniciada. Pulsa «Iniciar sesión» en la configuración del chat (el engranaje) y vuelve a enviar el mensaje."),
};

export const GEMINI_CLI: AcpAgent = {
  program: "gemini",
  label: "Gemini CLI",
  args: (model) => ["--acp", ...(model && model !== "default" ? ["--model", model] : [])],
  loginHint: () => t("Gemini CLI no tiene la sesión iniciada. Pulsa «Iniciar sesión» en la configuración del chat (el engranaje), elige «Sign in with Google» y vuelve a enviar el mensaje."),
};

export const COPILOT_MODELS = [
  { id: "default", name: t("Predeterminado de Copilot") },
  { id: "auto", name: t("Automático") },
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
  { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
];

type Rpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string; data?: unknown } };
type AcpContent = { type: string; content?: { type: string; text?: string }; path?: string; oldText?: string | null; newText?: string; text?: string };
type ToolCall = { toolCallId: string; title?: string; kind?: string; status?: string; content?: AcpContent[]; rawInput?: Record<string, unknown>; rawOutput?: unknown };

export class AcpSession implements Session {
  private id: string;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private unlisten: UnlistenFn[] = [];
  private sessionId: string | null = null;
  private ctx: ChatContext | null = null;
  private answerId: string | null = null;
  private thinkingId: string | null = null;
  private calls = new Map<string, { item: string; kind?: string; paths: string[] }>();
  /** Títulos de las herramientas de solo lectura del MCP de Raxorin (así las nombra Copilot). */
  private readOnlyTitles = new Set<string>();
  /** Escrituras ya aprobadas en un pedido de permiso (ruta → texto nuevo), para no preguntar dos veces. */
  private approvedWrites = new Map<string, string>();
  private stderr = "";

  constructor(private agent: AcpAgent, private model: string, private host: Host, private exe: string) {
    this.id = `${agent.program}-${newId()}`;
  }

  private send_(msg: Rpc) {
    return backend.agentSend(this.id, JSON.stringify(msg));
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send_({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        this.waiting.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  private async start(ctx: ChatContext) {
    if (!ctx.cwd) throw new Error(t("Abre un proyecto para usar {0}.", this.agent.label));
    for (const tool of await chatTools()) if (READ_ONLY.includes(tool.name)) this.readOnlyTitles.add(tool.title ?? tool.name);
    this.unlisten.push(
      await listen<{ id: string; line: string }>("ai-agent-line", (e) => e.payload.id === this.id && void this.onLine(e.payload.line)),
      await listen<{ id: string; code: number | null; stderr: string }>("ai-agent-exit", (e) => e.payload.id === this.id && this.onExit(e.payload.stderr)),
    );
    await backend.agentStart(this.id, this.agent.program, this.agent.args(this.model), ctx.cwd);
    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "raxorin-studio", title: "Raxorin Studio", version: "" },
    });
    void init;
    try {
      const s = await this.request("session/new", {
        cwd: ctx.cwd,
        mcpServers: [{ name: "raxorin-studio", command: this.exe, args: ["--mcp", ...ctx.roots.flatMap((r) => ["--root", r])], env: [] }],
      });
      this.sessionId = s.sessionId;
    } catch (e) {
      throw new Error(this.explain(String(e instanceof Error ? e.message : e)));
    }
  }

  private explain(msg: string) {
    if (/auth|log ?in|token|unauthori|401|403|api key is missing|not configured|credentials/i.test(msg)) {
      this.host.needsLogin?.();
      return this.agent.loginHint() + `\n\n${msg}`;
    }
    return `${this.agent.label}: ${msg}`;
  }

  async send(text: string, ctx: ChatContext) {
    this.ctx = ctx;
    if (!this.sessionId) await this.start(ctx);
    this.answerId = null;
    this.thinkingId = null;
    try {
      const r = await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: `${contextNote(ctx)}\n\n${text}` }] });
      if (r?.stopReason === "refusal") this.host.push({ kind: "error", id: newId(), text: t("El modelo no quiso responder a esta solicitud.") });
      else if (r?.stopReason === "max_tokens") this.host.push({ kind: "info", id: newId(), text: t("La respuesta se cortó por su largo.") });
    } catch (e) {
      throw new Error(this.explain(String(e instanceof Error ? e.message : e)));
    }
  }

  private async onLine(line: string) {
    let m: Rpc;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const w = this.waiting.get(Number(m.id));
      if (!w) return;
      this.waiting.delete(Number(m.id));
      if (m.error) w.reject(new Error(m.error.message + (m.error.data ? ` (${JSON.stringify(m.error.data)})` : "")));
      else w.resolve(m.result);
      return;
    }
    if (m.method === "session/update") return this.onUpdate(m.params?.update ?? {});
    if (m.method && m.id !== undefined) {
      try {
        const result = await this.onRequest(m.method, m.params ?? {});
        await this.send_({ jsonrpc: "2.0", id: m.id, result });
      } catch (e) {
        await this.send_({ jsonrpc: "2.0", id: m.id, error: { code: (e as { code?: number }).code ?? -32603, message: String(e instanceof Error ? e.message : e) } });
      }
    }
  }

  private onUpdate(u: Record<string, any>) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") {
          if (!this.answerId) this.host.push({ kind: "assistant", id: (this.answerId = newId()), text: "" });
          this.host.append(this.answerId, u.content.text);
        }
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") {
          if (!this.thinkingId) this.host.push({ kind: "thinking", id: (this.thinkingId = newId()), text: "" });
          this.host.append(this.thinkingId, u.content.text);
        }
        break;
      case "tool_call": {
        const c = u as ToolCall & { locations?: { path: string }[] };
        const item = newId();
        this.calls.set(c.toolCallId, { item, kind: c.kind, paths: (c.locations ?? []).map((l) => l.path) });
        this.host.push({ kind: "tool", id: item, name: c.kind ?? "tool", summary: c.title ?? "", status: c.status === "completed" ? "done" : c.status === "failed" ? "error" : "running" });
        this.answerId = null;
        this.thinkingId = null;
        break;
      }
      case "tool_call_update": {
        const c = u as ToolCall & { locations?: { path: string }[] };
        const call = this.calls.get(c.toolCallId);
        if (!call) break;
        const item = call.item;
        if (c.locations?.length) call.paths = c.locations.map((l) => l.path);
        // Copilot edita los archivos por su cuenta (apply_patch): al terminar, recargarlos en el editor.
        if (c.status === "completed" && call.kind === "edit") call.paths.forEach((p) => this.host.fileChanged(p));
        const output = (c.content ?? []).map((x) => x.content?.text ?? (x.type === "diff" ? `${x.path}` : "")).filter(Boolean).join("\n");
        this.host.update(item, {
          ...(c.title ? { summary: c.title } : {}),
          ...(c.status ? { status: c.status === "completed" ? "done" : c.status === "failed" ? "error" : "running" } : {}),
          ...(output ? { output } : {}),
        });
        break;
      }
      case "plan":
        this.host.push({ kind: "plan", id: newId(), entries: (u.entries ?? []).map((e: { content: string; status: string }) => ({ content: e.content, status: e.status })) });
        break;
    }
  }

  private detailFor(call: ToolCall): ApprovalDetail {
    const diff = call.content?.find((c) => c.type === "diff");
    if (diff?.path) return { type: "diff", path: diff.path, before: diff.oldText ?? "", after: diff.newText ?? "" };
    const raw = call.rawInput ?? {};
    if (typeof raw.diff === "string") return { type: "patch", path: String(raw.fileName ?? raw.path ?? ""), text: raw.diff };
    const cmd = (raw.command ?? raw.cmd) as string | undefined;
    if (cmd) return { type: "command", text: Array.isArray(cmd) ? cmd.join(" ") : String(cmd) };
    const text = (call.content ?? []).map((c) => c.content?.text ?? "").filter(Boolean).join("\n");
    return { type: "text", text: text || JSON.stringify(raw, null, 2) };
  }

  private async onRequest(method: string, p: Record<string, any>): Promise<unknown> {
    const roots = this.ctx?.roots ?? [];
    switch (method) {
      case "session/request_permission": {
        const call = p.toolCall as ToolCall;
        const options = (p.options ?? []) as { optionId: string; kind: string }[];
        const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind.startsWith("allow"));
        const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind.startsWith("reject"));
        // Leer y las herramientas de solo lectura de Raxorin no necesitan preguntar.
        const readOnly = ["read", "search", "think"].includes(call.kind ?? "") || this.readOnlyTitles.has(call.title ?? "");
        if (readOnly && allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
        const detail = this.detailFor(call);
        const answer = await this.host.approve(call.title ?? t("Acción de {0}", this.agent.label), detail);
        if (answer.allow && detail.type === "diff") this.approvedWrites.set(detail.path, detail.after);
        const chosen = answer.allow ? allow : reject;
        return chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : { outcome: { outcome: "cancelled" } };
      }
      case "fs/read_text_file": {
        const r = await backend.tool(roots, "read_file", { path: p.path });
        if (r.isError) throw Object.assign(new Error(resultText(r)), { code: -32002 });
        let text = resultText(r);
        if (p.line || p.limit) {
          const lines = text.split("\n");
          const from = Math.max(0, (p.line ?? 1) - 1);
          text = lines.slice(from, p.limit ? from + p.limit : undefined).join("\n");
        }
        return { content: text };
      }
      case "fs/write_text_file": {
        const path = String(p.path);
        const content = String(p.content ?? "");
        if (this.approvedWrites.get(path) !== content) {
          let before = "";
          const cur = await backend.tool(roots, "read_file", { path }).catch(() => null);
          if (cur && !cur.isError) before = resultText(cur);
          const answer = await this.host.approve(t("Escribir {0}", path), { type: "diff", path, before, after: content });
          if (!answer.allow) throw new Error(`The user declined writing ${path}${answer.message ? `: ${answer.message}` : ""}`);
        }
        this.approvedWrites.delete(path);
        const r = await backend.tool(roots, "write_file", { path, content });
        if (r.isError) throw new Error(resultText(r));
        this.host.fileChanged(path);
        return null;
      }
      default:
        throw Object.assign(new Error(`Method not supported: ${method}`), { code: -32601 });
    }
  }

  private onExit(stderr: string) {
    this.stderr = stderr;
    this.sessionId = null;
    this.unlisten.splice(0).forEach((f) => f());
    const err = new Error(this.explain(stderr.trim().split("\n").slice(-6).join("\n") || t("{0} se cerró.", this.agent.label)));
    this.waiting.forEach((w) => w.reject(err));
    this.waiting.clear();
  }

  stop() {
    if (this.sessionId) void this.send_({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
  }

  dispose() {
    void backend.agentStop(this.id);
    this.unlisten.splice(0).forEach((f) => f());
  }
}
