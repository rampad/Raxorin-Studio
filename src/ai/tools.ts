// Las herramientas del IDE para los agentes por API (Anthropic, Gemini): las mismas del servidor
// MCP, con aprobación para lo que cambia archivos, agrega paquetes, crea proyectos o ejecuta el programa.
import { api } from "../api";
import { t } from "../i18n/index.ts";
import { backend, resultText, type McpTool } from "./backend";
import { applyEdit } from "./diff";
import type { ApprovalDetail, ChatContext, Host } from "./types";

/** Necesitan el visto bueno de la persona. Compilar, probar, leer y formatear, no. */
export const NEEDS_APPROVAL = new Set(["write_file", "edit_file", "run", "add_dependency", "create_project", "create_from_sample"]);
/** Herramientas del MCP que Claude Code y Copilot pueden usar sin preguntar. */
export const READ_ONLY = ["ide_info", "list_projects", "list_dir", "read_file", "build", "check", "test", "format", "explain_error", "search_crates", "list_samples", "slint_controls"];

let cached: Promise<McpTool[]> | null = null;
export const chatTools = () => (cached ??= backend.tools());

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Comprueba que la entrada tiene lo que pide el esquema (los modelos a veces la cortan). */
export function validate(tool: McpTool, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "The tool input must be a JSON object.";
  const obj = input as Record<string, unknown>;
  for (const k of tool.inputSchema.required ?? []) if (!(k in obj)) return `Missing required argument “${k}”.`;
  for (const [k, v] of Object.entries(obj)) {
    const type = (tool.inputSchema.properties[k] as { type?: string } | undefined)?.type;
    const ok = !type || (type === "string" ? typeof v === "string" : type === "boolean" ? typeof v === "boolean"
      : type === "integer" || type === "number" ? typeof v === "number" : type === "array" ? Array.isArray(v) : true);
    if (!ok) return `Argument “${k}” must be of type ${type}.`;
  }
  return null;
}

async function readOr(path: string, fallback = "") {
  try {
    return await api.readFile(path);
  } catch {
    return fallback;
  }
}

/** Qué se le muestra a la persona para aprobar cada herramienta (también para Claude Code y Copilot). */
export async function describe(name: string, input: Record<string, unknown>): Promise<{ title: string; detail: ApprovalDetail }> {
  const path = str(input.path) || str(input.file_path);
  switch (name) {
    case "write_file":
    case "Write":
      return { title: t("Escribir {0}", path), detail: { type: "diff", path, before: await readOr(path), after: str(input.content) } };
    case "edit_file":
    case "Edit": {
      const before = await readOr(path);
      const after = applyEdit(before, str(input.old_text) || str(input.old_string), str(input.new_text) || str(input.new_string), !!input.replace_all);
      return { title: t("Editar {0}", path), detail: after === null ? { type: "text", text: t("El texto a reemplazar no está en el archivo; si lo apruebas, la herramienta devolverá un error.") } : { type: "diff", path, before, after } };
    }
    case "MultiEdit": {
      const before = await readOr(path);
      let after: string | null = before;
      for (const e of (input.edits as Record<string, unknown>[] | undefined) ?? []) {
        after = after === null ? null : applyEdit(after, str(e.old_string), str(e.new_string), !!e.replace_all);
      }
      return { title: t("Editar {0}", path), detail: after === null ? { type: "text", text: JSON.stringify(input, null, 2) } : { type: "diff", path, before, after } };
    }
    case "run": {
      const args = ((input.args as string[] | undefined) ?? []).join(" ");
      const stdin = str(input.stdin);
      return { title: t("Ejecutar el programa"), detail: { type: "command", text: `cargo run${args ? " -- " + args : ""}${stdin ? `\n\n${t("Entrada:")}\n${stdin}` : ""}` } };
    }
    case "Bash":
      return { title: t("Ejecutar un comando"), detail: { type: "command", text: str(input.command) + (input.description ? `\n\n# ${str(input.description)}` : "") } };
    case "add_dependency": {
      const feats = (input.features as string[] | undefined)?.length ? ` --features ${(input.features as string[]).join(",")}` : "";
      return { title: t("Agregar un paquete"), detail: { type: "command", text: `cargo add ${str(input.name)}${input.version ? "@" + str(input.version) : ""}${feats}${input.dev ? " --dev" : ""}` } };
    }
    case "create_project":
      return { title: t("Crear un proyecto"), detail: { type: "text", text: `${str(input.parent)}/${str(input.name)} (${str(input.kind)})` } };
    case "create_from_sample":
      return { title: t("Crear un proyecto desde un ejemplo"), detail: { type: "text", text: `${str(input.parent)}/${str(input.name)} ← ${str(input.id)}` } };
    default:
      return { title: name, detail: { type: "text", text: JSON.stringify(input, null, 2) } };
  }
}

/** Resumen corto de una llamada para la tarjeta de herramienta. */
export function summarize(name: string, input: Record<string, unknown>): string {
  const p = str(input.path) || str(input.file_path) || str(input.project);
  const short = p.split(/[\\/]/).slice(-2).join("/");
  if (name === "explain_error") return str(input.code);
  if (name === "search_crates") return str(input.query);
  if (name === "Bash") return str(input.command).slice(0, 80);
  if (name === "Grep" || name === "Glob") return str(input.pattern);
  return short;
}

/** Ejecuta una herramienta pedida por un modelo por API: valida, pide aprobación si hace falta, ejecuta. */
export async function runTool(host: Host, ctx: ChatContext, name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
  const tool = (await chatTools()).find((x) => x.name === name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  const invalid = validate(tool, input);
  if (invalid) return { text: invalid, isError: true };
  const args = input as Record<string, unknown>;
  const itemId = `tool-${Math.random().toString(36).slice(2)}`;
  if (NEEDS_APPROVAL.has(name)) {
    const { title, detail } = await describe(name, args);
    const answer = await host.approve(title, detail);
    if (!answer.allow) {
      return { text: `The user declined this action${answer.message ? `: ${answer.message}` : "."} Don't retry it unchanged; ask or try another approach.`, isError: true };
    }
  }
  host.push({ kind: "tool", id: itemId, name, summary: summarize(name, args), status: "running" });
  try {
    const r = await backend.tool(ctx.roots, name, args);
    const text = resultText(r);
    host.update(itemId, { status: r.isError ? "error" : "done", output: text });
    if (!r.isError && (name === "write_file" || name === "edit_file")) host.fileChanged(str(args.path));
    return { text, isError: !!r.isError };
  } catch (e) {
    const text = String(e);
    host.update(itemId, { status: "error", output: text });
    return { text, isError: true };
  }
}
