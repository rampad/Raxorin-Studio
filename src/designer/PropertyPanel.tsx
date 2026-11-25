import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Codicon } from "../components/Icon";
import {
  formatDuration, formatImage, formatItems, formatLength, formatString, formatStringArray, getProp, parseBool,
  parseColor, parseDuration, parseImage, parseItems, parseLength, parseNumber, parseString, parseStringArray,
  type Element,
} from "./slintDoc";
import { RUST_TYPE, type Bindable, type EventDef, type PropDef, type WidgetDef } from "./widgets";
import { t } from "../i18n/index.ts";

interface Props {
  el: Element;
  def: WidgetDef | undefined;
  isRoot: boolean;
  slintDir: string;
  /** Cambia una propiedad del elemento seleccionado (undefined = quitar). */
  setProp: (name: string, value: string | undefined) => void;
  rename: (newId: string) => string | null;
  eventCallback: (ev: EventDef) => string | null;
  onEvent: (ev: EventDef) => void;
  exposedName: (b: Bindable) => string | null;
  toggleExpose: (b: Bindable) => void;
  onDelete: () => void;
  /** Contenido adicional al inicio de las propiedades (p. ej. "Agregar pestaña"). */
  extra?: React.ReactNode;
}

const GROUPS = [t("Diseño"), "Contenido", "Apariencia", "Comportamiento"] as const;

export default function PropertyPanel(p: Props) {
  const [tab, setTab] = useState<"props" | "events">("props");
  const def = p.def;

  return (
    <div className="prop-panel">
      <div className="prop-head">
        <Codicon name={def?.icon ?? "symbol-misc"} className="prop-head-icon" />
        <div className="prop-head-text">
          {p.isRoot ? <strong>{t("Ventana")}</strong> : <IdField id={p.el.id} rename={p.rename} />}
          <span className="muted small">{p.el.type}</span>
        </div>
        {!p.isRoot && (
          <button className="icon-btn" title={t("Eliminar (Supr)")} onClick={p.onDelete}><Codicon name="trash" /></button>
        )}
      </div>

      <div className="prop-tabs">
        <button className={tab === "props" ? "active" : ""} onClick={() => setTab("props")}>
          <Codicon name="symbol-property" /> {" "}{t("Propiedades")}
        </button>
        <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")} disabled={!def?.events.length}>
          <Codicon name="symbol-event" /> {" "}{t("Eventos")}{" "}{def?.events.length ? `(${def.events.length})` : ""}
        </button>
      </div>

      <div className="prop-body">
        {!def && <p className="muted small pad">{t("Este elemento (")}{p.el.type}{t(") se edita en la vista de código.")}</p>}

        {def && tab === "props" && (
          <>
            {p.extra}
            {GROUPS.map((g) => {
              const props = def.props.filter((x) => x.group === g);
              if (!props.length) return null;
              return (
                <section key={g}>
                  <h5>{t(g)}</h5>
                  {props.map((pd) => (
                    <PropField key={pd.name} pd={pd} value={getProp(p.el, pd.name)} slintDir={p.slintDir}
                      onChange={(v) => p.setProp(pd.name, v)} />
                  ))}
                </section>
              );
            })}

            {def.bindable && !p.isRoot && (
              <section>
                <h5>{t("Usar desde Rust")}</h5>
                {!p.el.id && <p className="muted small">{t("Ponle un nombre al control para usarlo desde Rust.")}</p>}
                {p.el.id && def.bindable.map((b) => {
                  const name = p.exposedName(b);
                  return (
                    <div key={b.prop} className="expose">
                      <label className="check-line">
                        <input type="checkbox" checked={!!name} onChange={() => p.toggleExpose(b)} />
                        
                        {t("Leer y cambiar")}{" "}<code>{b.prop}</code> {" "}{t("desde Rust")}
                      </label>
                      {name && (
                        <pre className="snippet">{`let v = ui.get_${name}();  // ${RUST_TYPE[b.slint]}\nui.set_${name}(${example(b.slint)});`}</pre>
                      )}
                    </div>
                  );
                })}
              </section>
            )}
          </>
        )}

        {def && tab === "events" && (
          <section>
            <p className="muted small">
              
              {t("Como en WPF: al conectar un evento se crea la función en")}{" "}<code>main.rs</code>{t(", donde escribes qué pasa.")}
            </p>
            {def.events.map((ev) => {
              const cb = p.eventCallback(ev);
              return (
                <div key={ev.name} className="event-row">
                  <div>
                    <strong>{ev.label}</strong>
                    <div className="muted small"><code>{ev.name}{ev.params.length ? `(${ev.params.map((x) => x.name).join(", ")})` : ""}</code></div>
                    {cb && <div className="small ok"><Codicon name="arrow-right" /> ui.on_{cb}(…)</div>}
                  </div>
                  <button className={"btn small" + (cb ? "" : " primary")} onClick={() => p.onEvent(ev)} disabled={!p.el.id}>
                    {cb ? <><Codicon name="go-to-file" /> {" "}{t("Ir al código")}</> : <><Codicon name="add" /> {" "}{t("Crear")}</>}
                  </button>
                </div>
              );
            })}
            {!p.el.id && <p className="small warn-text">{t("Ponle un nombre al control para conectar eventos.")}</p>}
          </section>
        )}
      </div>
    </div>
  );
}

function example(t: Bindable["slint"]) {
  return t === "string" ? '"Hola".into()' : t === "bool" ? "true" : t === "float" ? "0.5" : "1";
}

function IdField({ id, rename }: { id: string | null; rename: (v: string) => string | null }) {
  const [value, setValue] = useState(id ?? "");
  const [error, setError] = useState("");
  useEffect(() => {
    setValue(id ?? "");
    setError("");
  }, [id]);
  const commit = () => {
    if (value === (id ?? "")) return;
    const err = rename(value);
    setError(err ?? "");
    if (err) setValue(id ?? "");
  };
  return (
    <>
      <input
        className="id-input"
        value={value}
        placeholder={t("sin nombre")}
        spellCheck={false}
        title={t("Nombre del control (para usarlo desde Rust y en eventos)")}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {error && <span className="small err">{error}</span>}
    </>
  );
}

// ---------- Campos ----------

function PropField({ pd, value, onChange, slintDir }: {
  pd: PropDef; value: string | undefined; onChange: (v: string | undefined) => void; slintDir: string;
}) {
  const literal = isLiteral(pd, value);
  const [expr, setExpr] = useState(!literal);
  useEffect(() => setExpr(!isLiteral(pd, value)), [pd, value]);

  return (
    <div className="prop-row">
      <label title={pd.name}>{pd.label}</label>
      <div className="prop-control">
        {expr ? (
          <TextInput mono value={value ?? ""} onCommit={(v) => onChange(v.trim() || undefined)} placeholder={t("expresión de Slint")} />
        ) : (
          <Editor pd={pd} value={value} onChange={onChange} slintDir={slintDir} />
        )}
        <button
          className={"icon-btn fx" + (expr ? " on" : "")}
          title={expr ? t("Usar editor simple") : t("Escribir una expresión (p. ej. root.width - 20px)")}
          onClick={() => setExpr((x) => !x)}
        >
          fx
        </button>
        {value !== undefined && (
          <button className="icon-btn" title={t("Restablecer al valor por defecto")} onClick={() => onChange(undefined)}>
            <Codicon name="discard" />
          </button>
        )}
      </div>
    </div>
  );
}

function isLiteral(pd: PropDef, v: string | undefined): boolean {
  if (v === undefined) return true;
  switch (pd.kind) {
    case "length": return parseLength(v) !== null;
    case "string": case "text": return parseString(v) !== null;
    case "bool": return parseBool(v) !== null;
    case "color": return parseColor(v) !== null;
    case "number": case "int": case "percent": return parseNumber(v) !== null;
    case "enum": return pd.options?.includes(v.trim()) ?? false;
    case "strings": return parseStringArray(v) !== null;
    case "image": return parseImage(v) !== null;
    case "duration": return parseDuration(v) !== null;
    case "items": return parseItems(v) !== null;
  }
}

function Editor({ pd, value, onChange, slintDir }: {
  pd: PropDef; value: string | undefined; onChange: (v: string | undefined) => void; slintDir: string;
}) {
  switch (pd.kind) {
    case "length":
      return <NumberInput value={parseLength(value)} placeholder={pd.fallback ?? "auto"} suffix="px"
        onCommit={(n) => onChange(n === null ? undefined : formatLength(n))} />;
    case "number":
    case "int":
      return <NumberInput value={parseNumber(value)} placeholder={pd.fallback ?? ""} integer={pd.kind === "int"}
        onCommit={(n) => onChange(n === null ? undefined : String(pd.kind === "int" ? Math.round(n) : n))} />;
    case "percent": {
      const n = parseNumber(value) ?? parseNumber(pd.fallback) ?? 0;
      return (
        <div className="row-inline">
          <input type="range" min={0} max={1} step={0.01} value={n} onChange={(e) => onChange(String(Number(e.target.value)))} />
          <span className="muted small">{Math.round(n * 100)}%</span>
        </div>
      );
    }
    case "string":
      return <TextInput value={parseString(value) ?? ""} placeholder={value === undefined ? t("(vacío)") : ""}
        onCommit={(v) => onChange(formatString(v))} />;
    case "text":
      return <TextInput multiline value={parseString(value) ?? ""} onCommit={(v) => onChange(formatString(v))} />;
    case "bool": {
      const b = parseBool(value) ?? parseBool(pd.fallback) ?? false;
      return (
        <label className="check-line">
          <input type="checkbox" checked={b} onChange={(e) => onChange(String(e.target.checked))} />
          <span className="muted small">{b ? t("sí") : "no"}</span>
        </label>
      );
    }
    case "color": {
      const c = parseColor(value);
      return (
        <div className="row-inline">
          <input type="color" value={c && c.length === 7 ? c : "#ffffff"} onChange={(e) => onChange(e.target.value)} />
          <TextInput mono value={c ?? ""} placeholder="#rrggbb" onCommit={(v) => onChange(parseColor(v) ? v.trim() : undefined)} />
        </div>
      );
    }
    case "enum":
      return (
        <select value={value?.trim() ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{pd.fallback ? t("{0} (por defecto)", pd.fallback) : t("(por defecto)")}</option>
          {pd.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case "strings":
      return (
        <TextInput multiline value={(parseStringArray(value) ?? []).join("\n")} placeholder={t("Una opción por línea")}
          onCommit={(v) => onChange(formatStringArray(v.split("\n").map((x) => x.trim()).filter(Boolean)))} />
      );
    case "duration":
      return <NumberInput value={parseDuration(value)} placeholder={pd.fallback ?? ""} suffix="ms" integer
        onCommit={(n) => onChange(n === null ? undefined : formatDuration(Math.max(0, n)))} />;
    case "items":
      return (
        <TextInput multiline value={(parseItems(value) ?? []).join("\n")} placeholder={t("Un elemento por línea")}
          onCommit={(v) => onChange(formatItems(v.split("\n").map((x) => x.trim()).filter(Boolean)))} />
      );
    case "image": {
      const path = parseImage(value);
      return (
        <div className="row-inline">
          <TextInput mono value={path ?? ""} placeholder={t("ruta/imagen.png")} onCommit={(v) => onChange(v.trim() ? formatImage(v.trim()) : undefined)} />
          <button
            className="btn small"
            onClick={async () => {
              const f = await open({ filters: [{ name: t("Imágenes"), extensions: ["png", "jpg", "jpeg", "svg", "gif", "webp"] }], defaultPath: slintDir });
              if (typeof f === "string") onChange(formatImage(relativePath(slintDir, f)));
            }}
          >
            …
          </button>
        </div>
      );
    }
  }
}

/** Ruta de `to` relativa a la carpeta `fromDir` (las imágenes se buscan junto al .slint). */
function relativePath(fromDir: string, to: string): string {
  const a = fromDir.split(/[\\/]/).filter(Boolean);
  const b = to.split(/[\\/]/).filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === 0) return to.replace(/\\/g, "/");
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

function TextInput({ value, onCommit, placeholder, multiline, mono }: {
  value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onCommit(v);
  const cls = "prop-input" + (mono ? " mono" : "");
  return multiline ? (
    <textarea className={cls} rows={3} value={v} placeholder={placeholder} spellCheck={false}
      onChange={(e) => setV(e.target.value)} onBlur={commit} />
  ) : (
    <input className={cls} value={v} placeholder={placeholder} spellCheck={false}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  );
}

function NumberInput({ value, onCommit, placeholder, suffix, integer }: {
  value: number | null; onCommit: (n: number | null) => void; placeholder?: string; suffix?: string; integer?: boolean;
}) {
  const [v, setV] = useState(value === null ? "" : String(value));
  useEffect(() => setV(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const t = v.trim();
    if (!t) return value !== null && onCommit(null);
    const n = Number(t);
    if (Number.isFinite(n) && n !== value) onCommit(integer ? Math.round(n) : n);
    else setV(value === null ? "" : String(value));
  };
  return (
    <div className="row-inline">
      <input className="prop-input num" value={v} placeholder={placeholder} inputMode="decimal"
        onChange={(e) => setV(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const n = (Number(v) || 0) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
            setV(String(n));
            onCommit(n);
          }
        }} />
      {suffix && <span className="muted small">{suffix}</span>}
    </div>
  );
}
