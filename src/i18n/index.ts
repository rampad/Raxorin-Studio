// Idiomas de Raxorin Studio. El texto en español es la clave: t("Guardar") devuelve "Save" en
// inglés (src/i18n/en.ts). Así el código sigue legible y lo que falte traducir se ve en español.
//
// El idioma se elige al iniciar (Configuración → Idioma); al cambiarlo se recarga la ventana,
// así también se traducen los textos que se calculan una sola vez (catálogos, menús).
import { EN } from "./en.ts";
import { BACKEND_EN } from "./backend-en.ts";

export type Lang = "es" | "en";
export type LangPref = "system" | Lang;

const KEY = "raxorinstudio.language";

export function readLangPref(): LangPref {
  // Scripts y pruebas en Node: RAXORIN_LANG=en|es (por defecto, español).
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env && typeof window === "undefined") return env.RAXORIN_LANG === "en" ? "en" : "es";
  try {
    const v = localStorage.getItem(KEY);
    if (v === "es" || v === "en" || v === "system") return v;
  } catch {
    /* sin almacenamiento */
  }
  return "system";
}

/** Idioma del sistema: español si lo es, inglés en cualquier otro caso. */
export const systemLang = (): Lang =>
  (typeof navigator !== "undefined" ? navigator.language : "es").toLowerCase().startsWith("es") ? "es" : "en";

export const resolveLang = (p: LangPref): Lang => (p === "system" ? systemLang() : p);

/** Idioma activo (fijo hasta recargar). */
export const lang: Lang = resolveLang(readLangPref());
if (typeof document !== "undefined") document.documentElement.lang = lang;

/** Guarda la preferencia y recarga la ventana para aplicarla. */
export function setLangPref(p: LangPref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* sin almacenamiento */
  }
  location.reload();
}

const fill = (s: string, args: unknown[]) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s);

/**
 * Traduce un texto de la interfaz. Los valores van como {0}, {1}…:
 * `t("Proyecto creado: {0}", ruta)`.
 */
export function t(es: string, ...args: unknown[]): string {
  return fill(lang === "en" ? (EN[es] ?? es) : es, args);
}

// ---------- Mensajes que vienen del backend (Rust) ----------
// Rust escribe en español; aquí se traducen al mostrarlos. Cada plantilla tiene {0}, {1}… donde
// van los valores variables (rutas, nombres, errores del sistema).

interface Pattern { re: RegExp; en: string }
let patterns: Pattern[] | null = null;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(): Pattern[] {
  // Las plantillas más largas primero: así gana la más específica.
  return Object.entries(BACKEND_EN)
    .filter(([es, en]) => es !== en) // opciones de comandos, scripts: se dejan como están
    .sort((a, b) => b[0].length - a[0].length)
    .map(([es, en]) => ({
      re: new RegExp(es.split(/\{\d+\}/).map(escapeRe).join("([\\s\\S]*?)") + (/\{\d+\}$/.test(es) ? "$" : ""), "g"),
      en,
    }));
}

/** Traduce un mensaje del backend (también si viene dentro de un texto más largo). */
export function tb(text: string): string {
  if (lang !== "en" || !text) return text;
  patterns ??= compile();
  let out = text;
  for (const p of patterns) {
    p.re.lastIndex = 0;
    if (!p.re.test(out)) continue;
    p.re.lastIndex = 0;
    out = out.replace(p.re, (...m) => fill(p.en, m.slice(1, -2)));
  }
  return out;
}

/** Texto de un error (de un comando del backend o de JavaScript), traducido. */
export const tErr = (e: unknown) => tb(e instanceof Error ? e.message : String(e));
