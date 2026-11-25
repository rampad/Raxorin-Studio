// Chat con IA: lo que comparten los proveedores (Anthropic, Gemini, Claude Code, Copilot) y el panel.

export type ProviderId = "anthropic" | "gemini" | "claude-code" | "copilot" | "gemini-cli";

/** Lo que la persona ve aprobar: un cambio de archivo, un comando o una acción descrita. */
export type ApprovalDetail =
  | { type: "diff"; path: string; before: string; after: string }
  /** Un diff unificado ya hecho (lo que manda Copilot al pedir permiso para editar). */
  | { type: "patch"; path: string; text: string }
  | { type: "command"; text: string }
  | { type: "text"; text: string };

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "done" | "error"; output?: string }
  | { kind: "approval"; id: string; title: string; detail: ApprovalDetail; state: "pending" | "approved" | "rejected" }
  | { kind: "plan"; id: string; entries: { content: string; status: string }[] }
  | { kind: "error"; id: string; text: string }
  | { kind: "info"; id: string; text: string };

/** Lo que el chat sabe del IDE en cada mensaje. */
export interface ChatContext {
  /** Carpetas donde la IA puede leer y escribir (el proyecto o la solución). */
  roots: string[];
  /** Carpeta principal (donde se ejecutan Claude Code y Copilot). */
  cwd: string | null;
  activeFile: string | null;
  selection: string | null;
  /** Resumen de los errores y advertencias actuales. */
  diagnostics: string;
}

export interface Approval {
  allow: boolean;
  message?: string;
}

/** Lo que el panel ofrece a un proveedor. */
export interface Host {
  push(item: Item): void;
  update(id: string, patch: Partial<Item>): void;
  /** Agrega texto a un elemento de texto (respuesta o razonamiento). */
  append(id: string, text: string): void;
  approve(title: string, detail: ApprovalDetail): Promise<Approval>;
  /** Un archivo cambió en el disco (para recargarlo en el editor). */
  fileChanged(path: string): void;
  /** La CLI no tiene la sesión iniciada: mostrar cómo iniciarla. */
  needsLogin?(): void;
}

export interface Session {
  /** Envía un mensaje y resuelve cuando termina la respuesta (con todas sus herramientas). */
  send(text: string, ctx: ChatContext): Promise<void>;
  stop(): void;
  dispose(): void;
}

let counter = 0;
export const newId = () => `i${Date.now().toString(36)}-${(counter++).toString(36)}`;
