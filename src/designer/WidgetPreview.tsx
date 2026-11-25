// Dibuja cada control en el lienzo del diseñador, imitando el estilo
// "fluent" (claro) que Slint usa por defecto en escritorio.

import type { CSSProperties } from "react";
import { Codicon } from "../components/Icon";
import ImagePreview from "./ImagePreview";
import {
  getProp, parseBool, parseColor, parseImage, parseItems, parseLength, parseNumber, parseString, parseStringArray,
  type Element,
} from "./slintDoc";
import { t } from "../i18n/index.ts";

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
      const wrap = getProp(el, "wrap")?.trim() ?? "no-wrap";
      const elide = getProp(el, "overflow")?.trim() === "elide";
      const stroke = parseColor(getProp(el, "stroke"));
      const strokeW = len(el, "stroke-width") ?? 0;
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
            fontFamily: parseString(getProp(el, "font-family")) || undefined,
            fontStyle: bool(el, "font-italic") ? "italic" : undefined,
            letterSpacing: len(el, "letter-spacing") ?? undefined,
            whiteSpace: wrap === "no-wrap" ? "pre" : "pre-wrap",
            wordBreak: wrap === "char-wrap" ? "break-all" : undefined,
            WebkitTextStroke: stroke && strokeW > 0 ? `${strokeW}px ${stroke}` : undefined,
          }}
        >
          {elide ? <span className="w-elide">{str(el, "text")}</span> : str(el, "text")}
        </div>
      );
    }
    case "Button": {
      const icon = parseImage(getProp(el, "icon"));
      return (
        <div className={"w-button" + (bool(el, "primary") ? " primary" : "") + (bool(el, "checkable") && bool(el, "checked") ? " checked" : "")} style={base}>
          {icon && <span className="w-button-icon"><ImagePreview src={icon} fit="contain" /></span>}
          {str(el, "text")}
        </div>
      );
    }
    case "StandardButton": {
      // Los mismos textos que pone Slint (en inglés, traducibles con @tr).
      const kind = getProp(el, "kind")?.trim() ?? "ok";
      const label: Record<string, string> = {
        ok: "OK", cancel: "Cancel", apply: "Apply", close: "Close", reset: "Reset", help: t("Help"),
        yes: "Yes", no: "No", abort: "Abort", retry: "Retry", ignore: "Ignore",
      };
      return <div className="w-button" style={base}>{label[kind] ?? kind}</div>;
    }
    case "StandardListView": {
      const items = parseItems(getProp(el, "model")) ?? [];
      const current = num(el, "current-item", -1);
      return (
        <div className="w-listview" style={base}>
          {items.map((t, i) => (
            <div key={i} className={"w-listview-row" + (i === current ? " selected" : "")}>{t}</div>
          ))}
          {!items.length && <span className="w-placeholder">{t("(sin elementos)")}</span>}
        </div>
      );
    }
    case "TouchArea":
      return (
        <div className="w-toucharea" title={t("Cursor: {0}", getProp(el, "mouse-cursor")?.trim() ?? "default")}>
          <Codicon name="target" />
        </div>
      );
    case "LineEdit": {
      const text = str(el, "text");
      const password = getProp(el, "input-type")?.trim() === "password";
      const align = getProp(el, "horizontal-alignment")?.trim();
      return (
        <div className="w-lineedit" style={{ ...base, justifyContent: align === "center" ? "center" : align === "right" ? "flex-end" : undefined }}>
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
      if (getProp(el, "orientation")?.trim() === "vertical") {
        return (
          <div className="w-slider vertical" style={base}>
            <div className="w-slider-track"><div style={{ height: `${pct * 100}%` }} /></div>
            <div className="w-slider-thumb" style={{ bottom: `calc(${pct * 100}% - 9px)` }} />
          </div>
        );
      }
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
    case "Rectangle": {
      // Sombra (drop-shadow-*) como en Slint.
      const shadowColor = parseColor(getProp(el, "drop-shadow-color"));
      const shadow = shadowColor
        ? `${len(el, "drop-shadow-offset-x") ?? 0}px ${len(el, "drop-shadow-offset-y") ?? 0}px ${len(el, "drop-shadow-blur") ?? 0}px ${shadowColor}`
        : undefined;
      const corner = (k: string) => len(el, k) ?? len(el, "border-radius") ?? 0;
      return (
        <div
          className="w-rect"
          style={{
            background: parseColor(getProp(el, "background")) ?? "transparent",
            boxShadow: shadow,
            borderTopLeftRadius: corner("border-top-left-radius"),
            borderTopRightRadius: corner("border-top-right-radius"),
            borderBottomRightRadius: corner("border-bottom-right-radius"),
            borderBottomLeftRadius: corner("border-bottom-left-radius"),
            border: (len(el, "border-width") ?? 0) > 0
              ? `${len(el, "border-width")}px solid ${parseColor(getProp(el, "border-color")) ?? "#000"}`
              : undefined,
          }}
        />
      );
    }
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
    case "Image":
      return (
        <ImagePreview
          src={parseImage(getProp(el, "source"))}
          fit={getProp(el, "image-fit")?.trim()}
          colorize={parseColor(getProp(el, "colorize"))}
          pixelated={getProp(el, "image-rendering")?.trim() === "pixelated"}
        />
      );
    default:
      return (
        <div className="w-unknown">
          <span>{el.type}</span>
          <small>{t("se edita como código")}</small>
        </div>
      );
  }
}
