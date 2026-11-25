// Proveedor Gemini (clave de API de Google AI Studio): bucle de agente con el SDK oficial.
import { GoogleGenAI, type Content, type FunctionCall, type Part } from "@google/genai";
import { t } from "../i18n/index.ts";
import { chatTools, runTool } from "./tools";
import { contextNote, systemPrompt } from "./prompt";
import { newId, type ChatContext, type Host, type Session } from "./types";

export async function geminiModels(apiKey: string): Promise<{ id: string; name: string }[]> {
  const ai = new GoogleGenAI({ apiKey });
  const out: { id: string; name: string }[] = [];
  for await (const m of await ai.models.list({ config: { pageSize: 100 } })) {
    const id = (m.name ?? "").replace(/^models\//, "");
    if (!id.startsWith("gemini") || !m.supportedActions?.includes("generateContent")) continue;
    if (/(image|tts|audio|live|embedding|robotics|computer-use)/.test(id)) continue;
    out.push({ id, name: m.displayName ?? id });
  }
  // Las más nuevas primero (por número de versión); las estables antes que las de vista previa.
  const ver = (id: string) => parseFloat(id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? "0");
  return out.sort((a, b) => ver(b.id) - ver(a.id) || Number(/preview|exp/.test(a.id)) - Number(/preview|exp/.test(b.id)) || a.id.localeCompare(b.id));
}

/** El predeterminado: la Flash estable más nueva (rápida y con herramientas), o la primera. */
export const geminiDefault = (models: { id: string }[]) =>
  models.find((m) => /flash$/.test(m.id))?.id ?? models.find((m) => /flash/.test(m.id) && !/lite|preview/.test(m.id))?.id ?? models[0]?.id ?? "";

export function geminiError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED.*key/i.test(msg)) return t("La clave de API de Gemini no es válida. Revísala en la configuración del chat.");
  if (/RESOURCE_EXHAUSTED|429/.test(msg)) return t("Gemini limitó las solicitudes por ahora (límite de uso). Espera un momento y vuelve a intentarlo.");
  if (/Failed to fetch|NetworkError/i.test(msg)) return t("No se pudo conectar con Gemini. Revisa tu conexión a internet.");
  return `Gemini: ${msg}`;
}

export class GeminiSession implements Session {
  private contents: Content[] = [];
  private abort: AbortController | null = null;
  private stopped = false;
  private ai: GoogleGenAI;

  /** `baseUrl` solo para las pruebas (un servidor local que imita la API). */
  constructor(apiKey: string, private model: string, private host: Host, baseUrl?: string) {
    this.ai = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  }

  async send(text: string, ctx: ChatContext) {
    this.stopped = false;
    const declarations = (await chatTools()).map((x) => ({ name: x.name, description: x.description, parametersJsonSchema: x.inputSchema }));
    const part: Part = { text: `${contextNote(ctx)}\n\n${text}` };
    const last = this.contents[this.contents.length - 1];
    if (last?.role === "user") last.parts = [...(last.parts ?? []), part];
    else this.contents.push({ role: "user", parts: [part] });

    while (!this.stopped) {
      this.abort = new AbortController();
      const parts: Part[] = [];
      const calls: FunctionCall[] = [];
      let answerId: string | null = null;
      let thinkingId: string | null = null;
      let finish: string | undefined;
      try {
        const stream = await this.ai.models.generateContentStream({
          model: this.model,
          contents: this.contents,
          config: {
            systemInstruction: systemPrompt(),
            tools: [{ functionDeclarations: declarations }],
            thinkingConfig: { includeThoughts: true },
            abortSignal: this.abort.signal,
          },
        });
        for await (const chunk of stream) {
          const cand = chunk.candidates?.[0];
          finish = cand?.finishReason ?? finish;
          for (const p of cand?.content?.parts ?? []) {
            // Se guardan las partes tal cual: Gemini pide que vuelvan con sus firmas de razonamiento.
            parts.push(p);
            if (p.functionCall) calls.push(p.functionCall);
            else if (p.text && p.thought) {
              if (!thinkingId) this.host.push({ kind: "thinking", id: (thinkingId = newId()), text: "" });
              this.host.append(thinkingId, p.text);
            } else if (p.text) {
              if (!answerId) this.host.push({ kind: "assistant", id: (answerId = newId()), text: "" });
              this.host.append(answerId, p.text);
            }
          }
        }
      } catch (e) {
        if (this.stopped) return;
        throw new Error(geminiError(e));
      }
      if (this.stopped) return;
      if (finish && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finish)) {
        this.host.push({ kind: "error", id: newId(), text: t("Gemini no quiso responder a esta solicitud ({0}).", finish) });
        return;
      }
      if (parts.length) this.contents.push({ role: "model", parts });
      if (!calls.length) {
        if (finish === "MAX_TOKENS") this.host.push({ kind: "info", id: newId(), text: t("La respuesta se cortó por su largo.") });
        return;
      }
      const responses: Part[] = [];
      for (const call of calls) {
        const r = this.stopped ? { text: "Stopped by the user.", isError: true } : await runTool(this.host, ctx, call.name ?? "", call.args ?? {});
        responses.push({ functionResponse: { id: call.id, name: call.name, response: r.isError ? { error: r.text } : { output: r.text } } });
      }
      this.contents.push({ role: "user", parts: responses });
    }
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  dispose() {
    this.stop();
  }
}
