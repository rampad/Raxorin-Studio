// Comandos del backend para el chat (src-tauri/src/ai.rs).
import { invoke } from "@tauri-apps/api/core";

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean };
}
export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}
export interface CliInfo { path: string; version: string }
export interface CliStatus { claude: CliInfo | null; copilot: CliInfo | null; gemini: CliInfo | null; exe: string }
export interface CliAuth { loggedIn: boolean | null; account: string | null; method: string | null }
export type CliProgram = "claude" | "copilot" | "gemini";

export const backend = {
  keyGet: (provider: "anthropic" | "gemini") => invoke<string | null>("ai_key_get", { provider }),
  keySet: (provider: "anthropic" | "gemini", key: string | null) => invoke<void>("ai_key_set", { provider, key }),
  tools: () => invoke<McpTool[]>("ai_tools"),
  tool: (roots: string[], name: string, args: unknown) => invoke<ToolResult>("ai_tool", { roots, name, args }),
  cliStatus: () => invoke<CliStatus>("ai_cli_status"),
  cliAuth: (program: CliProgram) => invoke<CliAuth>("ai_cli_auth", { program }),
  cliModels: (program: CliProgram) => invoke<string[]>("ai_cli_models", { program }),
  agentStart: (id: string, program: CliProgram, args: string[], cwd: string, env?: Record<string, string>) =>
    invoke<void>("ai_agent_start", { id, program, args, cwd, env }),
  agentSend: (id: string, line: string) => invoke<void>("ai_agent_send", { id, line }),
  agentStop: (id: string) => invoke<void>("ai_agent_stop", { id }),
  bridge: () => invoke<{ addr: string; token: string }>("ai_bridge"),
  approvalReply: (reqId: number, allow: boolean, message?: string) => invoke<void>("ai_approval_reply", { reqId, allow, message }),
  privateFile: (name: string, content: string) => invoke<string>("ai_private_file", { name, content }),
};

export const resultText = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
