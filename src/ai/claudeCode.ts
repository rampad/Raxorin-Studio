// Proveedor Claude Code (suscripción de Claude): el `claude` instalado en el equipo, en modo
// stream-json, con las herramientas MCP de Raxorin Studio. Lo que no es de solo lectura (Edit, Write,
// Bash y las herramientas del MCP que cambian cosas) pasa por --permission-prompt-tool: la
// herramienta `approve` del MCP pregunta a esta ventana por el puente local (src-tauri/src/ai.rs).
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { lang, t } from "../i18n/index.ts";
import { backend } from "./backend";
import { contextNote } from "./prompt";
import { describe, READ_ONLY, summarize } from "./tools";
import { newId, type ChatContext, type Host, type Session } from "./types";

const MCP = "raxorin-studio";
export const CLAUDE_MODELS = [
  { id: "default", name: t("Predeterminado de Claude Code") },
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
  { id: "fable", name: "Fable" },
];

const APPEND_PROMPT = `You are running inside Raxorin Studio's chat panel (a Rust IDE). Prefer the ${MCP} MCP tools: build/check/test return structured compiler diagnostics, explain_error explains rustc codes, and slint_controls lists the widgets of the visual designer (use them for .slint files). Every change and command is approved by the user in the IDE; if they decline, ask instead of retrying. Reply in ${lang === "en" ? "English" : "Spanish"} unless the user writes in another language.`;

type Block = { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };

const blockText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("\n") : "";

export class ClaudeCodeSession implements Session {
  private id = `claude-${newId()}`;
  private started = false;
  private sessionId: string | null = null;
  private unlisten: UnlistenFn[] = [];
  private pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private answerId: string | null = null;
  private thinkingId: string | null = null;
  private streamed = false;
  private tools = new Map<string, { item: string; name: string; path: string }>();
  private lastError = "";

  constructor(private model: string, private host: Host, private exe: string) {}

  private async start(ctx: ChatContext) {
    if (!ctx.cwd) throw new Error(t("Abre un proyecto para usar Claude Code."));
    const bridge = await backend.bridge();
    const config = {
      mcpServers: {
        [MCP]: {
          command: this.exe,
          args: ["--mcp", ...ctx.roots.flatMap((r) => ["--root", r]), "--approval-bridge", bridge.addr],
          env: { RAXORIN_APPROVAL_TOKEN: bridge.token },
        },
      },
    };
    const configPath = await backend.privateFile("claude-mcp.json", JSON.stringify(config));
    const allowed = ["Read", "Grep", "Glob", ...READ_ONLY.map((n) => `mcp__${MCP}__${n}`)];
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--mcp-config", configPath, "--strict-mcp-config",
      "--permission-prompt-tool", `mcp__${MCP}__approve`,
      "--tools", "Read,Grep,Glob,Edit,Write,MultiEdit,Bash",
      "--allowedTools", allowed.join(","),
      "--append-system-prompt", APPEND_PROMPT,
      ...(this.model && this.model !== "default" ? ["--model", this.model] : []),
      ...(this.sessionId ? ["--resume", this.sessionId] : []),
    ];
    this.unlisten.push(
      await listen<{ id: string; line: string }>("ai-agent-line", (e) => e.payload.id === this.id && this.onLine(e.payload.line)),
      await listen<{ id: string; code: number | null; stderr: string }>("ai-agent-exit", (e) => e.payload.id === this.id && this.onExit(e.payload.code, e.payload.stderr)),
      await listen<{ reqId: number; toolName: string; input: Record<string, unknown> }>("ai-approval", (e) => void this.onApproval(e.payload)),
    );
    await backend.agentStart(this.id, "claude", args, ctx.cwd);
    this.started = true;
  }

  async send(text: string, ctx: ChatContext) {
    if (!this.started) await this.start(ctx);
    this.lastError = "";
    const done = new Promise<void>((resolve, reject) => (this.pending = { resolve, reject }));
    await backend.agentSend(this.id, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `${contextNote(ctx)}\n\n${text}` }] },
    }));
    return done;
  }

  private onLine(line: string) {
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.session_id) this.sessionId = m.session_id;
    // Los subagentes (Task) no se muestran paso a paso.
    if (m.parent_tool_use_id) return;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          const mcp = (m.mcp_servers as { name: string; status: string }[] | undefined)?.find((s) => s.name === MCP);
          if (mcp && mcp.status !== "connected") this.host.push({ kind: "info", id: newId(), text: t("Las herramientas de Raxorin Studio no se conectaron ({0}); Claude Code usará solo las suyas.", mcp.status) });
        }
        break;
      case "stream_event": {
        const ev = m.event;
        if (ev?.type === "message_start") {
          this.answerId = null;
          this.thinkingId = null;
          this.streamed = false;
        } else if (ev?.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta") {
            this.streamed = true;
            if (!this.answerId) this.host.push({ kind: "assistant", id: (this.answerId = newId()), text: "" });
            this.host.append(this.answerId, ev.delta.text);
          } else if (ev.delta?.type === "thinking_delta") {
            if (!this.thinkingId) this.host.push({ kind: "thinking", id: (this.thinkingId = newId()), text: "" });
            this.host.append(this.thinkingId, ev.delta.thinking);
          }
        }
        break;
      }
      case "assistant":
        for (const b of (m.message?.content ?? []) as Block[]) {
          if (b.type === "text" && !this.streamed && b.text) {
            if (!this.answerId) this.host.push({ kind: "assistant", id: (this.answerId = newId()), text: "" });
            this.host.append(this.answerId, b.text);
          } else if (b.type === "tool_use" && b.id && b.name) {
            const name = b.name.replace(`mcp__${MCP}__`, "");
            const item = newId();
            const input = b.input ?? {};
            this.tools.set(b.id, { item, name, path: String(input.file_path ?? input.path ?? "") });
            this.host.push({ kind: "tool", id: item, name, summary: summarize(name, input), status: "running" });
          }
        }
        // Lo que venga después (tras las herramientas) es otro bloque de respuesta.
        this.answerId = null;
        break;
      case "user":
        for (const b of (m.message?.content ?? []) as Block[]) {
          if (b.type !== "tool_result" || !b.tool_use_id) continue;
          const tool = this.tools.get(b.tool_use_id);
          if (!tool) continue;
          this.host.update(tool.item, { status: b.is_error ? "error" : "done", output: blockText(b.content) });
          if (!b.is_error && ["Edit", "Write", "MultiEdit", "write_file", "edit_file"].includes(tool.name) && tool.path) this.host.fileChanged(tool.path);
        }
        break;
      case "result":
        if (m.is_error) {
          this.lastError = String(m.result ?? m.subtype ?? "");
          this.host.push({ kind: "error", id: newId(), text: this.explain(this.lastError) });
        }
        this.pending?.resolve();
        this.pending = null;
        break;
    }
  }

  private explain(msg: string) {
    if (/log ?in|\/login|API key|authenticat/i.test(msg)) {
      this.host.needsLogin?.();
      return t("Claude Code no tiene la sesión iniciada. Pulsa «Iniciar sesión» en la configuración del chat (el engranaje) y vuelve a enviar el mensaje.") + `\n\n${msg}`;
    }
    return `Claude Code: ${msg}`;
  }

  private onExit(code: number | null, stderr: string) {
    this.started = false;
    this.unlisten.splice(0).forEach((f) => f());
    if (this.pending) {
      const detail = stderr.trim() || this.lastError;
      if (code !== 0 && code !== null && detail) this.host.push({ kind: "error", id: newId(), text: this.explain(detail) });
      this.pending.resolve();
      this.pending = null;
    }
  }

  private async onApproval(req: { reqId: number; toolName: string; input: Record<string, unknown> }) {
    const name = req.toolName.replace(`mcp__${MCP}__`, "");
    const { title, detail } = await describe(name, req.input);
    const answer = await this.host.approve(title, detail);
    await backend.approvalReply(req.reqId, answer.allow, answer.message);
  }

  stop() {
    // Detener = terminar el proceso; el siguiente mensaje sigue la misma conversación (--resume).
    void backend.agentStop(this.id);
  }

  dispose() {
    this.sessionId = null;
    this.stop();
    this.unlisten.splice(0).forEach((f) => f());
  }
}
