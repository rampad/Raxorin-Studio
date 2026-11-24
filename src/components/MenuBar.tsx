import { useEffect, useRef, useState } from "react";
import { Codicon } from "./Icon";
import { formatShortcut } from "../shortcuts";

export { formatShortcut };

export type MenuItem =
  | "sep"
  | {
      label: string;
      icon?: string;
      /** Atajo con "Mod" = ⌘ en macOS, Ctrl en Windows/Linux. Ej: "Mod+Shift+S". */
      shortcut?: string;
      onClick?: () => void;
      disabled?: boolean;
      checked?: boolean;
      submenu?: MenuItem[];
      /** Texto secundario (p. ej. la ruta de un reciente). */
      hint?: string;
    };

export interface Menu {
  label: string;
  items: MenuItem[];
}

function Items({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  const [sub, setSub] = useState<number | null>(null);
  return (
    <>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div key={i} className="menubar-item-wrap" onMouseEnter={() => setSub(it.submenu ? i : null)}>
            <button
              className="menu-item"
              disabled={it.disabled}
              onClick={() => {
                if (it.submenu) return setSub(i);
                onDone();
                it.onClick?.();
              }}
            >
              <span className="menu-label">
                {it.checked !== undefined ? (
                  <Codicon name="check" className={"menu-check" + (it.checked ? "" : " off")} />
                ) : (
                  <Codicon name={it.icon ?? "blank"} className="menu-icon" />
                )}
                {it.label}
              </span>
              {it.hint && <span className="muted menu-hint">{it.hint}</span>}
              {it.shortcut && <span className="muted menu-shortcut">{formatShortcut(it.shortcut)}</span>}
              {it.submenu && <Codicon name="chevron-right" className="muted" />}
            </button>
            {it.submenu && sub === i && (
              <div className="context-menu submenu">
                {it.submenu.length ? <Items items={it.submenu} onDone={onDone} /> : <div className="menu-header">Vacío</div>}
              </div>
            )}
          </div>
        ),
      )}
    </>
  );
}

/** Barra de menús al estilo de Visual Studio: Archivo, Editar, Ver… */
export default function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      else if (e.key === "ArrowRight") setOpen((o) => (o === null ? o : (o + 1) % menus.length));
      else if (e.key === "ArrowLeft") setOpen((o) => (o === null ? o : (o + menus.length - 1) % menus.length));
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, menus.length]);

  return (
    <div className="menubar" ref={ref} role="menubar">
      {menus.map((m, i) => (
        <div key={m.label} className="menubar-entry">
          <button
            className={"menubar-btn" + (open === i ? " open" : "")}
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen((o) => (o === i ? null : i));
            }}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="context-menu dropdown menubar-menu" role="menu">
              <Items items={m.items} onDone={() => setOpen(null)} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
