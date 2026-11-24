// Herramientas de diagnóstico (como en Visual Studio): CPU y memoria del
// programa mientras se ejecuta o se depura. Dos gráficos separados (nunca un
// gráfico con dos ejes): cada medida tiene su propia escala.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Codicon } from "../components/Icon";

export interface Sample {
  t: number; // ms desde el inicio
  cpu: number; // % del total de la CPU
  cpuCore: number; // % de un núcleo
  mem: number; // bytes
}
export interface Marker { t: number; label: string }

export interface DiagState {
  pid: number | null;
  name: string;
  mode: "run" | "debug" | null;
  samples: Sample[];
  markers: Marker[];
  running: boolean;
}

const EMPTY: DiagState = { pid: null, name: "", mode: null, samples: [], markers: [], running: false };
const MAX_SAMPLES = 1200; // 10 minutos a 2 muestras por segundo

/** Escucha las mediciones del backend. `stop` marca cada detención del depurador. */
export function useDiagnostics(stop: { n: number; label: string } | null): DiagState {
  const [state, setState] = useState<DiagState>(EMPTY);
  useEffect(() => {
    const uns = [
      listen<{ pid: number; name: string; mode: "run" | "debug" }>("proc-stats-start", (e) =>
        setState({ ...EMPTY, pid: e.payload.pid, name: e.payload.name, mode: e.payload.mode, running: true }),
      ),
      listen<{ pid: number; t: number; cpu: number; cpuCore: number; memory: number }>("proc-stats", (e) =>
        setState((s) =>
          s.pid !== e.payload.pid
            ? s
            : {
                ...s,
                samples: [...s.samples, { t: e.payload.t, cpu: e.payload.cpu, cpuCore: e.payload.cpuCore, mem: e.payload.memory }].slice(-MAX_SAMPLES),
              },
        ),
      ),
      listen<{ pid: number }>("proc-stats-end", (e) => setState((s) => (s.pid === e.payload.pid ? { ...s, running: false } : s))),
    ];
    return () => uns.forEach((u) => u.then((f) => f()));
  }, []);

  // Marca en los gráficos cada vez que el depurador se detiene.
  const prev = useRef<number | null>(null);
  useEffect(() => {
    if (stop && stop.n !== prev.current) {
      setState((s) => {
        const last = s.samples[s.samples.length - 1];
        return last ? { ...s, markers: [...s.markers, { t: last.t, label: stop.label }] } : s;
      });
    }
    prev.current = stop?.n ?? null;
  }, [stop]);

  return state;
}

// ---------- Formato ----------

const num = new Intl.NumberFormat("es", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const fmtPct = (v: number) => `${num.format(v)} %`;
const fmtMB = (bytes: number) => `${num.format(bytes / (1024 * 1024))} MB`;
const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Techo "redondo" para el eje (1, 1,5, 2, 2,5, 3, 4, 5, 6, 8 × 10^k), para no dejar medio gráfico vacío. */
function niceCeil(x: number) {
  if (x <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

// ---------- Gráfico de línea ----------

interface ChartProps {
  title: string;
  points: { t: number; v: number }[];
  window: [number, number];
  yMax: number;
  format: (v: number) => string;
  colorVar: string;
  markers: Marker[];
  extra?: (i: number) => string | null;
}

function LineChart({ title, points, window: [t0, t1], yMax, format, colorVar, markers, extra }: ChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(280);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 96, padL = 44, padR = 8, padT = 8, padB = 18;
  const iw = Math.max(10, width - padL - padR), ih = H - padT - padB;
  const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v: number) => padT + ih - (Math.min(v, yMax) / yMax) * ih;
  const visible = points.filter((p) => p.t >= t0 - 1000);
  const line = visible.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = visible.length ? `${line}L${x(visible[visible.length - 1].t).toFixed(1)},${y(0)}L${x(visible[0].t).toFixed(1)},${y(0)}Z` : "";
  const grid = [0, 0.5, 1].map((f) => yMax * f);
  const h = hover !== null ? visible[hover] : null;
  const last = visible[visible.length - 1];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!visible.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left - padL) / iw) * (t1 - t0);
    let best = 0;
    visible.forEach((p, i) => {
      if (Math.abs(p.t - t) < Math.abs(visible[best].t - t)) best = i;
    });
    setHover(best);
  };

  return (
    <div className="chart" ref={wrap}>
      <div className="chart-head">
        <span className="chart-title"><i className="chart-swatch" style={{ background: `var(${colorVar})` }} />{title}</span>
        <span className="chart-value">{last ? format(last.v) : "—"}</span>
      </div>
      <svg width={width} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
        {grid.map((g) => (
          <g key={g}>
            <line x1={padL} x2={padL + iw} y1={y(g)} y2={y(g)} className="chart-grid" />
            <text x={padL - 6} y={y(g) + 3} className="chart-axis" textAnchor="end">{format(g).replace(/,0 /, " ")}</text>
          </g>
        ))}
        <text x={padL} y={H - 4} className="chart-axis">{fmtTime(t0)}</text>
        <text x={padL + iw} y={H - 4} className="chart-axis" textAnchor="end">{fmtTime(t1)}</text>
        {markers.filter((m) => m.t >= t0 && m.t <= t1).map((m, i) => (
          <g key={i}>
            <line x1={x(m.t)} x2={x(m.t)} y1={padT} y2={padT + ih} className="chart-marker" />
            <path d={`M${x(m.t) - 4},${padT - 1}L${x(m.t) + 4},${padT - 1}L${x(m.t)},${padT + 5}Z`} className="chart-marker-head">
              <title>{`${m.label} · ${fmtTime(m.t)}`}</title>
            </path>
          </g>
        ))}
        {area && <path d={area} style={{ fill: `var(${colorVar})` }} className="chart-area" />}
        {line && <path d={line} style={{ stroke: `var(${colorVar})` }} className="chart-line" />}
        {h && (
          <g>
            <line x1={x(h.t)} x2={x(h.t)} y1={padT} y2={padT + ih} className="chart-crosshair" />
            <circle cx={x(h.t)} cy={y(h.v)} r={4} style={{ fill: `var(${colorVar})` }} className="chart-dot" />
          </g>
        )}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(x(h.t) - 60, 0), width - 130) }}>
          <strong>{format(h.v)}</strong>
          <span>{fmtTime(h.t)}</span>
          {extra?.(points.indexOf(h)) && <span>{extra(points.indexOf(h))}</span>}
        </div>
      )}
    </div>
  );
}

// ---------- Panel ----------

export default function DiagnosticsPanel({ state, onClose, width }: { state: DiagState; onClose: () => void; width?: number }) {
  const [range, setRange] = useState<"60" | "all">("60");
  const [table, setTable] = useState(false);
  const s = state.samples;
  const last = s[s.length - 1];
  const tEnd = last ? Math.max(last.t, range === "60" ? 60_000 : 1000) : 60_000;
  const window: [number, number] = range === "60" ? [Math.max(0, tEnd - 60_000), tEnd] : [0, tEnd];
  const inWin = s.filter((p) => p.t >= window[0]);

  const cpuMax = Math.min(100, Math.max(5, niceCeil(Math.max(...inWin.map((p) => p.cpu), 0) * 1.25)));
  const memMax = niceCeil(Math.max(...inWin.map((p) => p.mem / (1024 * 1024)), 0) * 1.2) * 1024 * 1024;
  const avgCpu = s.length ? s.reduce((a, p) => a + p.cpu, 0) / s.length : 0;
  const peakMem = s.length ? Math.max(...s.map((p) => p.mem)) : 0;

  return (
    <aside className="diag-panel" style={{ width }}>
      <div className="panel-title">
        <span>HERRAMIENTAS DE DIAGNÓSTICO</span>
        <button className="icon-btn" title="Cerrar" onClick={onClose}><Codicon name="close" /></button>
      </div>
      {!state.pid ? (
        <div className="muted small pad">
          <Codicon name="pulse" /> Ejecuta o depura un programa para ver aquí su uso de CPU y memoria.
        </div>
      ) : (
        <div className="diag-body">
          <div className="diag-session">
            <Codicon name={state.running ? (state.mode === "debug" ? "debug-alt" : "play") : "debug-stop"} />
            <strong>{state.name}</strong>
            <span className="muted">pid {state.pid}</span>
            <span className="spacer" />
            <span className="muted">{state.running ? (state.mode === "debug" ? "Depurando" : "Ejecutando") : "Terminado"} · {fmtTime(last?.t ?? 0)}</span>
          </div>

          <div className="diag-tiles">
            <div className="diag-tile"><span className="muted">CPU actual</span><strong>{last ? fmtPct(last.cpu) : "—"}</strong></div>
            <div className="diag-tile"><span className="muted">CPU promedio</span><strong>{fmtPct(avgCpu)}</strong></div>
            <div className="diag-tile"><span className="muted">Memoria</span><strong>{last ? fmtMB(last.mem) : "—"}</strong></div>
            <div className="diag-tile"><span className="muted">Memoria máx.</span><strong>{fmtMB(peakMem)}</strong></div>
          </div>

          <div className="diag-controls">
            <div className="segmented small">
              <button className={range === "60" ? "active" : ""} onClick={() => setRange("60")}>Últimos 60 s</button>
              <button className={range === "all" ? "active" : ""} onClick={() => setRange("all")}>Toda la sesión</button>
            </div>
            <button className={"icon-btn" + (table ? " on" : "")} title="Ver como tabla" onClick={() => setTable((t) => !t)}>
              <Codicon name="table" />
            </button>
          </div>

          {table ? (
            <div className="diag-table">
              <table>
                <thead><tr><th>Tiempo</th><th>CPU</th><th>Memoria</th></tr></thead>
                <tbody>
                  {[...inWin].reverse().slice(0, 120).map((p) => (
                    <tr key={p.t}><td>{fmtTime(p.t)}</td><td>{fmtPct(p.cpu)}</td><td>{fmtMB(p.mem)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <LineChart
                title="CPU (% del total)"
                points={s.map((p) => ({ t: p.t, v: p.cpu }))}
                window={window}
                yMax={cpuMax}
                format={fmtPct}
                colorVar="--series-cpu"
                markers={state.markers}
                extra={(i) => (s[i] ? `${num.format(s[i].cpuCore)} % de un núcleo` : null)}
              />
              <LineChart
                title="Memoria del proceso"
                points={s.map((p) => ({ t: p.t, v: p.mem }))}
                window={window}
                yMax={memMax}
                format={fmtMB}
                colorVar="--series-mem"
                markers={state.markers}
              />
              {state.markers.length > 0 && (
                <div className="diag-markers muted small">
                  <span className="chart-marker-key" /> Detenciones del depurador ({state.markers.length})
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
