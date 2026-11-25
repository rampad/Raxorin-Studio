// Compilar y ejecutar en el Rust Playground oficial (play.rust-lang.org) desde el navegador.
//
// El Playground recibe un solo archivo: los módulos del proyecto (`mod x;` → src/x.rs o
// src/x/mod.rs) se insertan en línea (`mod x { … }`) y un mapa de líneas devuelve cada error a su
// archivo y línea originales.

export const PLAYGROUND = "https://play.rust-lang.org";

export interface Diagnostic {
  level: "error" | "warning";
  code: string | null;
  message: string;
  file: string | null;
  line: number;
  column: number;
}

export interface Bundle {
  code: string;
  /** Línea del archivo unido (1-based, índice 0 = línea 1) → archivo y línea originales. */
  map: { file: string; line: number }[];
  missing: string[];
}

const MOD_RE = /^(\s*)((?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*))\s*;\s*(\/\/.*)?$/;

/**
 * Une `entry` (src/main.rs o src/lib.rs) con sus módulos. `files` usa rutas relativas al proyecto
 * ("src/main.rs"). Los módulos que no existen quedan como estaban (el compilador lo dirá).
 */
export function bundle(files: Record<string, string>, entry: string): Bundle {
  const out: string[] = [];
  const map: Bundle["map"] = [];
  const missing: string[] = [];
  const visit = (file: string, dir: string, depth: number) => {
    const lines = files[file].replace(/\r\n/g, "\n").split("\n");
    lines.forEach((line, i) => {
      const m = depth < 16 ? line.match(MOD_RE) : null;
      // `#[path = "…"]` y módulos con cuerpo no se tocan.
      const prev = i > 0 ? lines[i - 1].trim() : "";
      if (m && !prev.startsWith("#[path")) {
        const name = m[3];
        const cands = [`${dir}/${name}.rs`, `${dir}/${name}/mod.rs`];
        const found = cands.find((c) => c in files);
        if (found) {
          out.push(`${m[1]}${m[2]} {`);
          map.push({ file, line: i + 1 });
          // Los hijos de src/x.rs están en src/x/; los de src/x/mod.rs, también.
          visit(found, found.endsWith("/mod.rs") ? found.slice(0, -"/mod.rs".length) : found.slice(0, -3), depth + 1);
          out.push(`${m[1]}}`);
          map.push({ file, line: i + 1 });
          return;
        }
        missing.push(cands[0]);
      }
      out.push(line);
      map.push({ file, line: i + 1 });
    });
  };
  visit(entry, entry.slice(0, entry.lastIndexOf("/")), 0);
  return { code: out.join("\n"), map, missing };
}

/** Errores y advertencias del texto de cargo (el Playground no da JSON), con su archivo original. */
export function parseDiagnostics(stderr: string, map: Bundle["map"]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = stderr.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(error|warning)(?:\[(E\d{4})\])?: (.+)$/);
    if (!h) continue;
    const message = h[3];
    // Resúmenes de cargo, no diagnósticos del código.
    if (/^(could not compile|aborting due to|.*generated \d+ warnings?|build failed)/.test(message)) continue;
    let file: string | null = null, line = 0, column = 0;
    for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
      const loc = lines[k].match(/^\s*--> src\/(?:main|lib)\.rs:(\d+):(\d+)/);
      if (loc) {
        const m = map[Number(loc[1]) - 1];
        if (m) {
          file = m.file;
          line = m.line;
        }
        column = Number(loc[2]);
        break;
      }
    }
    out.push({ level: h[1] as "error" | "warning", code: h[2] ?? null, message, file, line, column });
  }
  return out;
}

/** Reemplaza las referencias `src/main.rs:L:C` del texto del compilador por el archivo y línea reales. */
export function remapText(stderr: string, map: Bundle["map"]): string {
  return stderr.replace(/(-->\s*)src\/(?:main|lib)\.rs:(\d+):(\d+)/g, (all, arrow: string, l: string, c: string) => {
    const m = map[Number(l) - 1];
    return m ? `${arrow}${m.file}:${m.line}:${c}` : all;
  });
}

export interface RunRequest {
  code: string;
  edition: string;
  mode: "debug" | "release";
  crateType: "bin" | "lib";
  tests: boolean;
}
export interface RunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitDetail?: string;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${PLAYGROUND}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Rust Playground: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const execute = (r: RunRequest, signal?: AbortSignal) =>
  post<RunResult>("/execute", { channel: "stable", backtrace: false, ...r }, signal);

export const clippy = (r: Pick<RunRequest, "code" | "edition" | "crateType">, signal?: AbortSignal) =>
  post<RunResult>("/clippy", { channel: "stable", ...r }, signal);

export const format = (code: string, edition: string) =>
  post<{ success: boolean; code: string; stderr: string }>("/format", { channel: "stable", edition, code });

let crates: Promise<Set<string>> | null = null;
/** Crates disponibles en el Playground (las ~100 más usadas), con `_` en lugar de `-`. */
export function availableCrates(): Promise<Set<string>> {
  crates ??= fetch(`${PLAYGROUND}/meta/crates`)
    .then((r) => r.json() as Promise<{ crates: { id: string; name: string }[] }>)
    .then((d) => new Set(d.crates.flatMap((c) => [c.id, c.name.replace(/-/g, "_")])))
    .catch(() => {
      crates = null;
      return new Set<string>();
    });
  return crates;
}

/** Dependencias y edición de un Cargo.toml (lo justo para el Playground). */
export function manifestInfo(toml: string): { edition: string; deps: string[]; hasLib: boolean } {
  const edition = toml.match(/^\s*edition\s*=\s*"(\d{4})"/m)?.[1] ?? "2021";
  const deps: string[] = [];
  let section = "";
  for (const line of toml.split("\n")) {
    const s = line.match(/^\s*\[([^\]]+)\]/);
    if (s) {
      section = s[1].trim();
      continue;
    }
    if (section === "dependencies") {
      const d = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      if (d) deps.push(d[1]);
    } else if (section.startsWith("dependencies.")) {
      const name = section.slice("dependencies.".length);
      if (!deps.includes(name)) deps.push(name);
    }
  }
  return { edition, deps, hasLib: /^\s*\[lib\]/m.test(toml) };
}
