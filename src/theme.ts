// Tema claro / oscuro de Raxorin Studio.
// La preferencia se guarda en localStorage; "system" sigue al sistema operativo.

import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePref = "dark" | "light" | "system";
export type Theme = "dark" | "light";

const KEY = "raxorinstudio.theme";
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: light)") : null;

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    /* sin almacenamiento */
  }
  return "dark";
}

let pref: ThemePref = readPref();
const listeners = new Set<() => void>();

export const resolve = (p: ThemePref): Theme => (p === "system" ? (media?.matches ? "light" : "dark") : p);

let snapshot = { pref, theme: resolve(pref) };

function apply() {
  const theme = resolve(pref);
  snapshot = { pref, theme };
  document.documentElement.dataset.theme = theme;
  // Barra de título nativa (macOS/Windows). null = seguir al sistema.
  getCurrentWindow()
    .setTheme(pref === "system" ? null : theme)
    .catch(() => {});
  listeners.forEach((l) => l());
}

export function setThemePref(p: ThemePref) {
  pref = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* sin almacenamiento */
  }
  apply();
}

/** Cambia entre claro y oscuro (deja de seguir al sistema). */
export function toggleTheme() {
  setThemePref(resolve(pref) === "dark" ? "light" : "dark");
}

media?.addEventListener("change", () => pref === "system" && apply());

// Aplicar antes del primer render para evitar un destello del otro tema.
if (typeof document !== "undefined") apply();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTheme() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Tema de Monaco que corresponde. */
export const monacoTheme = (t: Theme) => (t === "light" ? "vs" : "vs-dark");
