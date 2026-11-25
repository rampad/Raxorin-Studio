// Prueba los bucles de agente de Anthropic y Gemini (src/ai/anthropic.ts, src/ai/gemini.ts) sin red
// ni claves: un servidor local imita cada API (pide edit_file y después responde), y las
// herramientas se ejecutan de verdad en el MCP de Raxorin Studio (`raxorin-studio --mcp`).
//
//   node tests/ai/agentes.mjs <raxorin-studio>     (empaqueta este archivo con esbuild y lo ejecuta)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.argv[2];
const root = realpathSync(mkdtempSync(join(tmpdir(), "raxorin-ai-")));
mkdirSync(join(root, "src"));
const file = join(root, "src", "main.rs");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✔ " : "✖ ") + m); if (!c) fails++; };

// --- El MCP real hace de backend (invoke) ---
const mcp = spawn(exe, ["--mcp", "--root", root], { stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map<number, (v: any) => void>();
createInterface({ input: mcp.stdout! }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); });
let rid = 0;
const rpc = (method: string, params: unknown) => new Promise<any>((res) => { const id = ++rid; waiting.set(id, res); mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const tools = (await rpc("tools/list", {})).result.tools;
(globalThis as any).window = globalThis;
(globalThis as any).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string, args: any) => {
    if (cmd === "ai_tools") return tools;
    if (cmd === "ai_tool") return (await rpc("tools/call", { name: args.name, arguments: args.args })).result;
    if (cmd === "read_file") return readFileSync(args.path, "utf8");
    throw new Error("invoke no simulado: " + cmd);
  },
};

const { AnthropicSession } = await import("../../src/ai/anthropic");
const { GeminiSession } = await import("../../src/ai/gemini");
import type { Host, Item } from "../../src/ai/types";

function fakeHost(answer: boolean) {
  const items: Item[] = [];
  const approvals: string[] = [];
  const changed: string[] = [];
  const host: Host = {
    push: (i) => items.push(i),
    update: (id, p) => Object.assign(items.find((i) => i.id === id) ?? {}, p),
    append: (id, t) => { const i = items.find((x) => x.id === id) as { text: string } | undefined; if (i) i.text += t; },
    approve: async (title, detail) => { approvals.push(title + (detail.type === "diff" ? ` [${detail.before.length}→${detail.after.length}]` : "")); return { allow: answer, message: answer ? undefined : "prefiero otro nombre" }; },
    fileChanged: (p) => changed.push(p),
  };
  return { host, items, approvals, changed };
}
const ctx = { roots: [root], cwd: root, activeFile: file, selection: null, diagnostics: "" };
const editArgs = { path: file, old_text: "println!(\"Hello\")", new_text: "println!(\"Hola\")" };
const body = (req: IncomingMessage) => new Promise<any>((res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => res(JSON.parse(s))); });

// --- Anthropic ---
{
  const requests: any[] = [];
  const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  const start = { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
  const server = createServer(async (req, res) => {
    const b = await body(req);
    requests.push(b);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      res.end(sse([["message_start", start],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Lo cambio." } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "edit_file", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(editArgs) } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }]]));
    } else {
      res.end(sse([["message_start", start],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Listo." } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
        ["message_stop", { type: "message_stop" }]]));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  for (const allow of [true, false]) {
    writeFileSync(file, 'fn main() {\n    println!("Hello");\n}\n');
    requests.length = 0;
    const h = fakeHost(allow);
    await new AnthropicSession("sk-test", "claude-test", h.host, url).send("Saluda en español", ctx);
    const text = readFileSync(file, "utf8");
    const result = requests[1]?.messages.at(-1).content[0];
    if (allow) {
      ok(h.approvals.length === 1 && text.includes('"Hola"'), "Anthropic: pide aprobación con diff y edita el archivo");
      ok(result?.type === "tool_result" && result.tool_use_id === "tu1" && /Edited/.test(result.content) && !result.is_error, "Anthropic: el resultado real vuelve al modelo");
      ok(h.changed[0] === file, "Anthropic: avisa al editor del archivo cambiado");
      ok(requests[0].tools.length >= 17 && requests[0].tools.every((t: any) => t.eager_input_streaming) && requests[0].system[0].cache_control, "Anthropic: herramientas, streaming de entradas y caché");
      ok(h.items.some((i) => i.kind === "assistant" && i.text === "Listo."), "Anthropic: muestra la respuesta final");
    } else {
      ok(text.includes('"Hello"') && result?.is_error && /declined.*prefiero otro nombre/.test(result.content), "Anthropic: rechazado → no edita y el modelo recibe el motivo");
    }
  }
  server.close();
}

// --- Gemini ---
{
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const b = await body(req);
    requests.push({ url: req.url, ...b });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (parts: unknown[], finishReason?: string) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] })}\n\n`;
    if (requests.length === 1) {
      res.end(chunk([{ text: "pensando", thought: true }]) + chunk([{ functionCall: { id: "fc1", name: "edit_file", args: editArgs }, thoughtSignature: "firma-1" }], "STOP"));
    } else {
      res.end(chunk([{ text: "Listo." }], "STOP"));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(file, 'fn main() {\n    println!("Hello");\n}\n');
  const h = fakeHost(true);
  await new GeminiSession("AIza-test", "gemini-test", h.host, url).send("Saluda en español", ctx);
  const second = requests[1];
  const modelTurn = second?.contents.find((c: any) => c.role === "model");
  const response = second?.contents.at(-1).parts[0].functionResponse;
  ok(readFileSync(file, "utf8").includes('"Hola"') && h.approvals.length === 1, "Gemini: pide aprobación y edita el archivo");
  ok(modelTurn?.parts.some((p: any) => p.thoughtSignature === "firma-1"), "Gemini: devuelve la firma de razonamiento");
  ok(response?.name === "edit_file" && response.id === "fc1" && /Edited/.test(response.response.output), "Gemini: el resultado real vuelve al modelo");
  ok(requests[0].url.includes("streamGenerateContent") && requests[0].tools[0].functionDeclarations.length >= 17, "Gemini: streaming y herramientas");
  ok(h.items.some((i) => i.kind === "thinking") && h.items.some((i) => i.kind === "assistant" && i.text === "Listo."), "Gemini: razonamiento y respuesta");
  server.close();
}

mcp.stdin!.end();
rmSync(root, { recursive: true, force: true });
console.log(fails ? `\n${fails} FALLA(S)` : "\nTodo OK");
process.exit(fails ? 1 : 0);
