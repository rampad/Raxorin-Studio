export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Ruta relativa al proyecto, para mostrarla más corta. */
export const relative = (root: string | null, p: string) =>
  root && p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, "") : p;

export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "rs": return "rust";
    case "toml": return "ini";
    case "md": return "markdown";
    case "json": return "json";
    case "html": return "html";
    case "css": return "css";
    case "js": return "javascript";
    case "ts": return "typescript";
    case "yml": case "yaml": return "yaml";
    default: return "plaintext";
  }
}
