// Tamaños y visibilidad de los paneles (explorador, panel inferior, diagnóstico,
// columnas del diseñador). Se recuerdan entre sesiones.

import { useCallback, useSyncExternalStore } from "react";

const KEY = "raxorinstudio.layout";

type Store = Record<string, number | boolean>;

function read(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

let store: Store = read();
const listeners = new Set<() => void>();

function write(patch: Store | null) {
  store = patch === null ? {} : { ...store, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* sin almacenamiento */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const useStore = () => useSyncExternalStore(subscribe, () => store);

export interface PanelSpec {
  id: string;
  /** Tamaño inicial en píxeles. */
  initial: number;
  min: number;
  /** Máximo en píxeles, o fracción de la ventana (0–1). */
  max: number;
  axis: "x" | "y";
}

export const PANELS = {
  sidebar: { id: "sidebar", initial: 250, min: 160, max: 0.45, axis: "x" },
  bottom: { id: "bottom", initial: 260, min: 90, max: 0.75, axis: "y" },
  diagnostics: { id: "diagnostics", initial: 320, min: 240, max: 0.45, axis: "x" },
  toolbox: { id: "toolbox", initial: 210, min: 150, max: 0.3, axis: "x" },
  properties: { id: "properties", initial: 300, min: 220, max: 0.4, axis: "x" },
  ai: { id: "ai", initial: 400, min: 300, max: 0.5, axis: "x" },
} satisfies Record<string, PanelSpec>;

export function clampSize(spec: PanelSpec, size: number) {
  const viewport = spec.axis === "x" ? window.innerWidth : window.innerHeight;
  const max = spec.max <= 1 ? Math.max(spec.min, viewport * spec.max) : spec.max;
  return Math.round(Math.min(max, Math.max(spec.min, size)));
}

/** Tamaño de un panel; `set` lo guarda, `reset` vuelve al inicial. */
export function usePanelSize(spec: PanelSpec) {
  const s = useStore();
  const raw = s[spec.id];
  const size = clampSize(spec, typeof raw === "number" ? raw : spec.initial);
  const set = useCallback((v: number) => write({ [spec.id]: clampSize(spec, v) }), [spec]);
  const reset = useCallback(() => write({ [spec.id]: spec.initial }), [spec]);
  return { size, set, reset };
}

/** Panel que se puede mostrar u ocultar. */
export function usePanelVisible(id: string, initial = true) {
  const s = useStore();
  const raw = s["show." + id];
  const visible = typeof raw === "boolean" ? raw : initial;
  const setVisible = useCallback((v: boolean | ((old: boolean) => boolean)) => {
    const cur = store["show." + id];
    const old = typeof cur === "boolean" ? cur : initial;
    write({ ["show." + id]: typeof v === "function" ? v(old) : v });
  }, [id, initial]);
  return [visible, setVisible] as const;
}

/** Vuelve todos los paneles a su tamaño y visibilidad iniciales. */
export function resetLayout() {
  write(null);
}
