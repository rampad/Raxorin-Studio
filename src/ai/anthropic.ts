// Proveedor Anthropic (clave de API): bucle de agente con el SDK oficial y las herramientas del IDE.
import Anthropic from "@anthropic-ai/sdk";
import { t } from "../i18n/index.ts";
import { chatTools, runTool } from "./tools";
import { contextNote, systemPrompt } from "./prompt";
import { newId, type ChatContext, type Host, type Session } from "./types";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

function client(apiKey: string, baseURL?: string) {
  // La clave es de la persona y está en su equipo (llavero del sistema): no hay un servidor intermedio.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, ...(baseURL ? { baseURL } : {}) });
}

export async function anthropicModels(apiKey: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  for await (const m of client(apiKey).models.list({ limit: 100 })) out.push({ id: m.id, name: m.display_name });
  return out;
}

/** Mensaje legible para los errores de la API. */
export function anthropicError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return t("La clave de API de Anthropic no es válida. Revísala en la configuración del chat.");
  if (e instanceof Anthropic.PermissionDeniedError) return t("La clave de API no tiene permiso para este modelo.");
  if (e instanceof Anthropic.RateLimitError) return t("Anthropic limitó las solicitudes por ahora (límite de uso). Espera un momento y vuelve a intentarlo.");
  if (e instanceof Anthropic.NotFoundError) return t("El modelo elegido no existe o tu cuenta no tiene acceso a él.");
  if (e instanceof Anthropic.APIConnectionError) return t("No se pudo conectar con Anthropic. Revisa tu conexión a internet.");
  if (e instanceof Anthropic.APIError) return `Anthropic: ${e.message}`;
  return String(e);
}

export class AnthropicSession implements Session {
  private messages: Anthropic.MessageParam[] = [];
  private stream: ReturnType<Anthropic["messages"]["stream"]> | null = null;
  private stopped = false;
  private api: Anthropic;

  /** `baseURL` solo para las pruebas (un servidor local que imita la API). */
  constructor(apiKey: string, private model: string, private host: Host, baseURL?: string) {
    this.api = client(apiKey, baseURL);
  }

  async send(text: string, ctx: ChatContext) {
    this.stopped = false;
    const tools: Anthropic.Tool[] = (await chatTools()).map((x) => ({
      name: x.name,
      description: x.description,
      input_schema: x.inputSchema as Anthropic.Tool.InputSchema,
      eager_input_streaming: true,
    }));
    const block: Anthropic.TextBlockParam = { type: "text", text: `${contextNote(ctx)}\n\n${text}` };
    // Si se detuvo antes de responder, el último mensaje es de la persona: se agrega a ese.
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
    else this.messages.push({ role: "user", content: [block] });
    let retries = 0;

    while (!this.stopped) {
      const answerId = newId();
      let thinkingId: string | null = null;
      let answered = false;
      this.stream = this.api.messages.stream({
        model: this.model,
        max_tokens: 32000,
        // Herramientas + instrucciones fijas en la caché de prompts; el contexto va en el mensaje.
        system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
        tools,
        thinking: { type: "adaptive", display: "summarized" },
        messages: this.messages,
      });
      this.stream.on("thinking", (delta: string) => {
        if (!thinkingId) {
          thinkingId = newId();
          this.host.push({ kind: "thinking", id: thinkingId, text: "" });
        }
        this.host.append(thinkingId, delta);
      });
      this.stream.on("text", (delta: string) => {
        if (!answered) {
          answered = true;
          this.host.push({ kind: "assistant", id: answerId, text: "" });
        }
        this.host.append(answerId, delta);
      });

      let message: Anthropic.Message;
      try {
        message = await this.stream.finalMessage();
        retries = 0;
      } catch (e) {
        if (this.stopped || e instanceof Anthropic.APIUserAbortError) return;
        // Una entrada de herramienta ilegible o una conexión cortada a mitad: se repite el turno (máx. 2).
        if (!(e instanceof Anthropic.APIError) && retries++ < 2) continue;
        throw new Error(anthropicError(e));
      }

      if (message.stop_reason === "refusal") {
        this.host.push({ kind: "error", id: newId(), text: t("El modelo no quiso responder a esta solicitud.") });
        // La respuesta rechazada no se guarda: la conversación sigue utilizable.
        return;
      }
      if (message.stop_reason === "pause_turn") {
        this.messages.push({ role: "assistant", content: message.content });
        continue;
      }
      const calls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      this.messages.push({ role: "assistant", content: message.content });
      if (!calls.length) return;
      if (message.stop_reason === "max_tokens") {
        this.messages.pop();
        throw new Error(t("La respuesta se cortó por su largo antes de terminar de pedir una herramienta. Pide un cambio más pequeño."));
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        if (this.stopped) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: "Stopped by the user.", is_error: true });
          continue;
        }
        const r = await runTool(this.host, ctx, call.name, call.input);
        results.push({ type: "tool_result", tool_use_id: call.id, content: r.text, is_error: r.isError });
      }
      this.messages.push({ role: "user", content: results });
    }
  }

  stop() {
    this.stopped = true;
    this.stream?.abort();
  }

  dispose() {
    this.stop();
  }
}
