import { useRef } from "react";
import { clampSize, type PanelSpec } from "../layout";

interface Props {
  spec: PanelSpec;
  size: number;
  onResize: (size: number) => void;
  onReset: () => void;
  /** Dónde está el panel respecto del divisor: antes (izquierda/arriba) o después (derecha/abajo). */
  panel: "before" | "after";
  title?: string;
}

/**
 * Divisor arrastrable entre un panel y el área central. Mientras se arrastra cambia
 * el tamaño del panel directamente en el DOM (sin re-renderizar la app) y al soltar
 * lo guarda. Doble clic: tamaño inicial.
 */
export default function Splitter({ spec, size, onResize, onReset, panel, title }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; size: number; el: HTMLElement; last: number } | null>(null);
  const prop = spec.axis === "x" ? "width" : "height";

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = (panel === "before" ? ref.current?.previousElementSibling : ref.current?.nextElementSibling) as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    drag.current = { start: spec.axis === "x" ? e.clientX : e.clientY, size, el, last: size };
    document.body.classList.add("resizing", spec.axis === "x" ? "resizing-x" : "resizing-y");
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = (spec.axis === "x" ? e.clientX : e.clientY) - d.start;
    d.last = clampSize(spec, d.size + (panel === "before" ? delta : -delta));
    d.el.style[prop] = d.last + "px";
  };

  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove("resizing", "resizing-x", "resizing-y");
    onResize(d.last);
  };

  return (
    <div
      ref={ref}
      className={"splitter " + spec.axis}
      role="separator"
      aria-orientation={spec.axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={size}
      title={title ?? "Arrastra para cambiar el tamaño · doble clic para restablecer"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
    />
  );
}
