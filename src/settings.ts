// Configuración general de Raxorin Studio (se guarda en localStorage).

import { useSyncExternalStore } from "react";

export interface Settings {
  /** Editor */
  fontSize: number;
  tabSize: 2 | 4 | 8;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  renderWhitespace: boolean;
  /** Guardar */
  formatOnSave: boolean;
  autoSave: boolean;
  /** Inicio */
  reopenLast: boolean;
  /** Preguntar antes de cerrar la ventana si hay archivos sin guardar. */
  confirmUnsaved: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  tabSize: 4,
  wordWrap: false,
  minimap: true,
  lineNumbers: true,
  renderWhitespace: false,
  formatOnSave: false,
  autoSave: false,
  reopenLast: true,
  confirmUnsaved: true,
};

const KEY = "raxorinstudio.settings";

/** Mezcla lo guardado con los valores por defecto, descartando valores inválidos. */
export function normalizeSettings(raw: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof r[k] === typeof DEFAULT_SETTINGS[k]) (out as Record<string, unknown>)[k] = r[k];
  }
  out.fontSize = Math.min(32, Math.max(8, Math.round(out.fontSize)));
  if (![2, 4, 8].includes(out.tabSize)) out.tabSize = 4;
  return out;
}

function read(): Settings {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let settings = read();
const listeners = new Set<() => void>();

export function getSettings() {
  return settings;
}

export function updateSettings(patch: Partial<Settings>) {
  settings = normalizeSettings({ ...settings, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* sin almacenamiento */
  }
  listeners.forEach((l) => l());
}

export const resetSettings = () => updateSettings(DEFAULT_SETTINGS);

export function useSettings() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => settings,
  );
}
