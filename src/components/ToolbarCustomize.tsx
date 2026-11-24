import { useState } from "react";
import { Codicon } from "./Icon";
import {
  isSep,
  newSepId,
  resetToolbarConfig,
  setToolbarConfig,
  TOOLS,
  useToolbarConfig,
  type ToolItem,
} from "../toolbarConfig";

/**
 * Personalizar la barra de herramientas: mostrar u ocultar controles, cambiar
 * su orden (flechas o arrastrar) y agregar separadores. Los cambios se ven al instante.
 */
export default function ToolbarCustomize({ onClose }: { onClose: () => void }) {
  const config = useToolbarConfig();
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const items = config.items;

  const update = (next: ToolItem[]) => setToolbarConfig({ ...config, items: next });
  const toggle = (i: number) => update(items.map((it, k) => (k === i ? { ...it, on: !it.on } : it)));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    update(next);
  };
  const sel = items.findIndex((i) => i.id === selected);

  const addSeparator = () => {
    const id = newSepId(items);
    const at = sel >= 0 ? sel + 1 : items.filter((i) => i.on).length;
    const next = [...items];
    next.splice(at, 0, { id, on: true });
    update(next);
    setSelected(id);
  };
  const removeSeparator = (i: number) => {
    update(items.filter((_, k) => k !== i));
    setSelected(null);
  };

  const shown = items.filter((i) => i.on && !isSep(i.id)).length;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal tb-customize" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Codicon name="settings" /> Personalizar barra de herramientas
        </h2>
        <p className="muted small">
          Marca los controles que quieres ver y ordénalos con las flechas o arrastrándolos. Los cambios se aplican al momento.
        </p>

        <div className="tb-list" role="listbox" aria-label="Controles de la barra">
          {items.map((it, i) => {
            const sep = isSep(it.id);
            const def = sep ? null : TOOLS[it.id as keyof typeof TOOLS];
            return (
              <div
                key={it.id}
                role="option"
                aria-selected={selected === it.id}
                className={
                  "tb-item" + (selected === it.id ? " selected" : "") + (it.on ? "" : " off") + (sep ? " sep" : "") +
                  (dragging === i ? " dragging" : "")
                }
                onClick={() => setSelected(it.id)}
                draggable
                onDragStart={(e) => {
                  setDragging(i);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragging !== null && dragging !== i) {
                    move(dragging, i);
                    setDragging(i);
                  }
                }}
                onDragEnd={() => setDragging(null)}
              >
                <Codicon name="gripper" className="tb-grip" />
                {sep ? (
                  <>
                    <span className="tb-sep-preview" />
                    <span className="tb-item-name muted">Separador</span>
                    <button className="icon-btn" title="Quitar separador" onClick={() => removeSeparator(i)}>
                      <Codicon name="close" />
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      type="checkbox"
                      checked={it.on}
                      onChange={() => toggle(i)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={def!.name}
                    />
                    <Codicon name={def!.icon} className="tb-item-icon" />
                    <span className="tb-item-name">{def!.name}</span>
                    <span className="tb-item-desc muted">{def!.desc}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="row tb-tools">
          <button className="btn" disabled={sel <= 0} onClick={() => move(sel, sel - 1)} title="Subir (más a la izquierda)">
            <Codicon name="arrow-up" />
          </button>
          <button className="btn" disabled={sel < 0 || sel >= items.length - 1} onClick={() => move(sel, sel + 1)} title="Bajar (más a la derecha)">
            <Codicon name="arrow-down" />
          </button>
          <button className="btn" onClick={addSeparator}>
            <Codicon name="add" /> Separador
          </button>
          <span className="spacer" />
          <label className="check-line">
            <input type="checkbox" checked={config.labels} onChange={(e) => setToolbarConfig({ ...config, labels: e.target.checked })} />
            Mostrar texto en los botones
          </label>
        </div>

        <div className="actions">
          <button className="btn" onClick={resetToolbarConfig}>
            <Codicon name="discard" /> Restablecer
          </button>
          <span className="muted small">{shown} controles visibles</span>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose} autoFocus>
            Listo
          </button>
        </div>
      </div>
    </div>
  );
}
