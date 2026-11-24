// Dibuja cada control en el lienzo del diseñador, imitando el estilo
// "fluent" (claro) que Slint usa por defecto en escritorio.

import type { CSSProperties } from "react";
import { Codicon } from "../components/Icon";
import {
  getProp, parseBool, parseColor, parseImage, parseLength, parseNumber, parseString, parseStringArray,
  type Element,
} from "./slintDoc";

const str = (el: Element, name: string, fallback = "") => {
  const v = getProp(el, name);
  if (v === undefined) return fallback;
  return parseString(v) ?? `{${v}}`; // expresión: se muestra entre llaves
};
const bool = (el: Element, name: string, fallback = false) => parseBool(getProp(el, name)) ?? fallback;
const num = (el: Element, name: string, fallback: number) => parseNumber(getProp(el, name)) ?? fallback;
const len = (el: Element, name: string) => parseLength(getProp(el, name));

export default function WidgetPreview({ el }: { el: Element }) {
  const disabled = !bool(el, "enabled", true);
  const fontSize = len(el, "font-size");
  const base: CSSProperties = { opacity: disabled ? 0.45 : 1, fontSize: fontSize ?? undefined };

  switch (el.type) {
    case "Text": {
      const h = getProp(el, "horizontal-alignment")?.trim() ?? "left";
      const v = getProp(el, "vertical-alignment")?.trim() ?? "top";
      const weight = parseNumber(getProp(el, "font-weight"));
      return (
        <div
          className="w-text"
          style={{
            ...base,
            color: parseColor(getProp(el, "color")) ?? undefined,
            justifyContent: h === "center" ? "center" : h === "right" ? "flex-end" : "flex-start",
            alignItems: v === "center" ? "center" : v === "bottom" ? "flex-end" : "flex-start",
            textAlign: h as CSSProperties["textAlign"],
            fontWeight: weight ?? undefined,
            whiteSpace: getProp(el, "wrap")?.trim() === "word-wrap" ? "pre-wrap" : "pre",
          }}
        >
          {str(el, "text")}
        </div>
      );
    }
    case "Button":
      return (
        <div className={"w-button" + (bool(el, "primary") ? " primary" : "")} style={base}>
          {str(el, "text")}
        </div>
      );
    case "LineEdit": {
      const text = str(el, "text");
      const password = getProp(el, "input-type")?.trim() === "password";
      return (
        <div className="w-lineedit" style={base}>
          {text ? <span>{password ? "•".repeat(text.length) : text}</span> : <span className="w-placeholder">{str(el, "placeholder-text")}</span>}
        </div>
      );
    }
    case "TextEdit": {
      const text = str(el, "text");
      return (
        <div className="w-textedit" style={base}>
          {text || <span className="w-placeholder">{str(el, "placeholder-text")}</span>}
        </div>
      );
    }
    case "CheckBox":
      return (
        <div className="w-check" style={base}>
          <span className={"w-checkbox" + (bool(el, "checked") ? " on" : "")}>{bool(el, "checked") && <Codicon name="check" />}</span>
          {str(el, "text")}
        </div>
      );
    case "Switch":
      return (
        <div className="w-check" style={base}>
          <span className={"w-switch" + (bool(el, "checked") ? " on" : "")}><span /></span>
          {str(el, "text")}
        </div>
      );
    case "Slider": {
      const min = num(el, "minimum", 0), max = num(el, "maximum", 100);
      const pct = Math.min(1, Math.max(0, (num(el, "value", 0) - min) / (max - min || 1)));
      return (
        <div className="w-slider" style={base}>
          <div className="w-slider-track"><div style={{ width: `${pct * 100}%` }} /></div>
          <div className="w-slider-thumb" style={{ left: `calc(${pct * 100}% - 9px)` }} />
        </div>
      );
    }
    case "SpinBox":
      return (
        <div className="w-lineedit w-spin" style={base}>
          <span>{num(el, "value", 0)}</span>
          <span className="w-spin-arrows"><Codicon name="chevron-up" /><Codicon name="chevron-down" /></span>
        </div>
      );
    case "ComboBox": {
      const model = parseStringArray(getProp(el, "model")) ?? [];
      const idx = num(el, "current-index", 0);
      return (
        <div className="w-lineedit w-combo" style={base}>
          <span>{model[idx] ?? model[0] ?? ""}</span>
          <Codicon name="chevron-down" />
        </div>
      );
    }
    case "ProgressIndicator":
      return (
        <div className="w-progress" style={base}>
          <div style={{ width: `${Math.min(1, Math.max(0, num(el, "progress", 0))) * 100}%` }} />
        </div>
      );
    case "Rectangle":
      return (
        <div
          className="w-rect"
          style={{
            background: parseColor(getProp(el, "background")) ?? "transparent",
            borderRadius: len(el, "border-radius") ?? 0,
            border: (len(el, "border-width") ?? 0) > 0
              ? `${len(el, "border-width")}px solid ${parseColor(getProp(el, "border-color")) ?? "#000"}`
              : undefined,
          }}
        />
      );
    case "Spinner": {
      const indeterminate = bool(el, "indeterminate");
      const pct = Math.min(1, Math.max(0, num(el, "progress", 0)));
      return (
        <div className="w-spinner" style={base}>
          <svg viewBox="0 0 32 32" width="100%" height="100%">
            <circle cx="16" cy="16" r="12" fill="none" stroke="#d6d6d6" strokeWidth="3" />
            <circle cx="16" cy="16" r="12" fill="none" stroke="#0067c0" strokeWidth="3" strokeLinecap="round"
              strokeDasharray={`${(indeterminate ? 0.3 : pct) * 75.4} 75.4`} transform="rotate(-90 16 16)" />
          </svg>
        </div>
      );
    }
    case "ScrollView":
      return (
        <div className="w-scrollview">
          <span className="w-scrollbar" />
        </div>
      );
    case "Tab":
      return <div />;
    case "Image": {
      const src = parseImage(getProp(el, "source"));
      return (
        <div className="w-image">
          <Codicon name="file-media" />
          <span>{src ?? "sin imagen"}</span>
        </div>
      );
    }
    default:
      return (
        <div className="w-unknown">
          <span>{el.type}</span>
          <small>se edita como código</small>
        </div>
      );
  }
}
