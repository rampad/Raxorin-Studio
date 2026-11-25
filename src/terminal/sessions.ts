// Sesiones del terminal integrado. Viven fuera de React para que sigan abiertas (con su
// historial en pantalla) aunque se cambie de pestaña o se oculte el panel inferior.
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t, tErr } from "../i18n/index.ts";

export interface Session {
  /** Número local (estable); el del backend llega al abrir el shell. */
  key: number;
  backendId: number | null;
  title: string;
  term: Terminal;
  fit: FitAddon;
  /** Contenedor que se mueve entre montajes del panel (el DOM de xterm no se recrea). */
  host: HTMLDivElement;
  started: boolean;
  exited: boolean;
  cwd: string | null;
}

let sessions: Session[] = [];
let activeKey: number | null = null;
let nextKey = 1;
const listeners = new Set<() => void>();
const byBackend = new Map<number, Session>();
/** Salida que llega antes de saber a qué sesión pertenece. */
const early = new Map<number, string[]>();

const notify = () => listeners.forEach((l) => l());

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const getSessions = () => sessions;
export const getActive = () => sessions.find((s) => s.key === activeKey) ?? null;

let wired = false;
function wireEvents() {
  if (wired) return;
  wired = true;
  void listen<{ id: number; data: string }>("terminal-data", (e) => {
    const s = byBackend.get(e.payload.id);
    if (s) s.term.write(e.payload.data);
    else early.set(e.payload.id, [...(early.get(e.payload.id) ?? []), e.payload.data]);
  });
  void listen<{ id: number }>("terminal-exit", (e) => {
    const s = byBackend.get(e.payload.id);
    if (!s) return;
    s.exited = true;
    s.term.write(t("\r\n\u001b[2m[El proceso terminó. Pulsa una tecla para cerrar esta terminal.]\u001b[0m\r\n"));
    notify();
  });
}

/** Colores del terminal a partir del tema de la app (variables CSS). */
export function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const light = document.documentElement.dataset.theme === "light";
  return {
    background: v("--bg"),
    foreground: v("--text"),
    cursor: v("--text-strong"),
    cursorAccent: v("--bg"),
    selectionBackground: v("--selection"),
    ...(light
      ? { black: "#000000", red: "#cd3131", green: "#107c10", yellow: "#949800", blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555", brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5" }
      : { black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510", blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5", brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5" }),
  };
}

export function applyTheme() {
  const theme = themeFromCss();
  for (const s of sessions) s.term.options.theme = theme;
}

export function setFontSize(size: number) {
  for (const s of sessions) {
    s.term.options.fontSize = size;
    if (s.started) s.fit.fit();
  }
}

/** Crea una sesión; el shell arranca cuando el panel la muestra (ver `attach`). */
export function createSession(cwd: string | null, fontSize = 13): Session {
  wireEvents();
  const host = document.createElement("div");
  host.className = "terminal-host";
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace",
    fontSize,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: themeFromCss(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, url) => void openUrl(url)));
  const s: Session = { key: nextKey++, backendId: null, title: "terminal", term, fit, host, started: false, exited: false, cwd };
  term.onData((data) => {
    if (s.exited) return closeSession(s.key);
    if (s.backendId != null) void invoke("terminal_write", { id: s.backendId, data });
  });
  term.onResize(({ cols, rows }) => {
    if (s.backendId != null) void invoke("terminal_resize", { id: s.backendId, cols, rows });
  });
  sessions = [...sessions, s];
  activeKey = s.key;
  notify();
  return s;
}

/** Pone la sesión en `container` y, la primera vez, abre xterm y arranca el shell. */
export function attach(s: Session, container: HTMLElement) {
  if (s.host.parentElement !== container) container.appendChild(s.host);
  if (!s.started) {
    s.started = true;
    s.term.open(s.host);
    s.fit.fit();
    invoke<{ id: number; shell: string }>("terminal_open", { cwd: s.cwd, cols: s.term.cols, rows: s.term.rows })
      .then(({ id, shell }) => {
        s.backendId = id;
        s.title = shell;
        byBackend.set(id, s);
        for (const d of early.get(id) ?? []) s.term.write(d);
        early.delete(id);
        notify();
      })
      .catch((e) => {
        s.exited = true;
        s.term.write(`\x1b[31m${tErr(e)}\x1b[0m\r\n`);
      });
  } else {
    s.fit.fit();
  }
}

export function setActive(key: number) {
  activeKey = key;
  notify();
}

export function closeSession(key: number) {
  const s = sessions.find((x) => x.key === key);
  if (!s) return;
  if (s.backendId != null) {
    void invoke("terminal_close", { id: s.backendId });
    byBackend.delete(s.backendId);
  }
  s.term.dispose();
  s.host.remove();
  const i = sessions.indexOf(s);
  sessions = sessions.filter((x) => x !== s);
  if (activeKey === key) activeKey = (sessions[i] ?? sessions[i - 1])?.key ?? null;
  notify();
}
