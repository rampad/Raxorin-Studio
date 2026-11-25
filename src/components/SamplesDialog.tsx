import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { api, type Sample, type SampleCatalog } from "../api";
import { Codicon } from "./Icon";

interface Props {
  onCancel: () => void;
  /** Abre lo creado: la carpeta del proyecto o el .rxsln, y el archivo a mostrar. */
  onCreated: (sample: Sample, created: { open: string; file: string }) => Promise<void>;
}

const TIPO: Record<Sample["tipo"], string> = {
  ventana: "Aplicación de ventana",
  consola: "Aplicación de consola",
  biblioteca: "Biblioteca",
  solucion: "Solución",
};

/** Hub de ejemplos: aplicaciones de muestra para abrir, ejecutar y estudiar. */
export default function SamplesDialog({ onCancel, onCreated }: Props) {
  const [catalog, setCatalog] = useState<SampleCatalog | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<Sample | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.samplesList().then(setCatalog).catch((e) => setError(String(e)));
    homeDir()
      .then((h) => join(h, "RustProjects"))
      .then(setLocation)
      .catch(() => {});
  }, []);

  const samples = catalog?.samples ?? [];
  const categories = useMemo(() => [...new Set(samples.map((s) => s.categoria))], [samples]);
  const q = query.trim().toLowerCase();
  const visible = samples.filter(
    (s) =>
      (!category || s.categoria === category) &&
      (!q || [s.nombre, s.descripcion, s.categoria, ...s.aprenderas].some((t) => t.toLowerCase().includes(q))),
  );

  const choose = (s: Sample) => {
    setSelected(s);
    setName(s.tipo === "solucion" ? s.nombre.replace(/\s*\(.*\)$/, "") : s.id);
    setError("");
  };

  const isSolution = selected?.tipo === "solucion";
  const nameOk = isSolution ? /^[^/\\:*?"<>|]+$/.test(name.trim()) : /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name);

  const create = async () => {
    if (!selected || !nameOk || !location || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await api.sampleCreate(selected, location, name.trim(), !!catalog?.online);
      await onCreated(selected, created);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div className="modal samples-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Codicon name="beaker" /> Ejemplos
        </h2>
        <p className="muted small">
          Aplicaciones de muestra listas para ejecutar. Crea una copia, pulsa <kbd>F5</kbd> y lee el código: cada ejemplo
          explica lo que hace.
        </p>

        <div className="samples-filters">
          <div className="samples-search">
            <Codicon name="search" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar (p. ej. lista, depurar, trait)…"
              spellCheck={false}
              autoFocus
            />
          </div>
          <div className="chips">
            <button className={"chip" + (!category ? " active" : "")} onClick={() => setCategory(null)}>
              Todos
            </button>
            {categories.map((c) => (
              <button key={c} className={"chip" + (category === c ? " active" : "")} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="samples-body">
          <div className="samples-grid">
            {!catalog && !error && (
              <p className="muted">
                <Codicon name="loading" spin /> Cargando ejemplos…
              </p>
            )}
            {catalog && visible.length === 0 && <p className="muted">Ningún ejemplo coincide con la búsqueda.</p>}
            {visible.map((s) => (
              <button
                key={s.id}
                className={"sample-card" + (selected?.id === s.id ? " selected" : "")}
                onClick={() => choose(s)}
              >
                <Codicon name={s.icono} className="sample-icon" />
                <span className="sample-text">
                  <strong>{s.nombre}</strong>
                  <small>{s.descripcion}</small>
                  <span className="sample-tags">
                    <span className="tag">{s.categoria}</span>
                    <span className={"tag level" + (s.nivel === "Principiante" ? " easy" : "")}>{s.nivel}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="sample-detail">
            {selected ? (
              <>
                <div className="sample-detail-title">
                  <Codicon name={selected.icono} className="sample-icon" />
                  <div>
                    <strong>{selected.nombre}</strong>
                    <div className="muted small">{TIPO[selected.tipo]}</div>
                  </div>
                </div>
                <p className="small">{selected.descripcion}</p>
                {selected.aprenderas.length > 0 && (
                  <>
                    <div className="sample-section">Aprenderás</div>
                    <ul className="sample-learn small">
                      {selected.aprenderas.map((a) => (
                        <li key={a}>
                          <Codicon name="check" /> {a}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="sample-section">Archivos</div>
                <div className="sample-files small">
                  {selected.archivos.filter((f) => !f.endsWith(".gitignore")).map((f) => (
                    <code key={f}>{f}</code>
                  ))}
                </div>
                <label>
                  {isSolution ? "Nombre de la solución" : "Nombre del proyecto"}
                  <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
                </label>
                {!nameOk && name.length > 0 && (
                  <div className="hint err">
                    {isSolution ? "El nombre no puede tener / \\ : * ? \" < > |" : "Usa letras, números, “_” o “-”, sin empezar con número."}
                  </div>
                )}
                <label>
                  Ubicación
                  <div className="row">
                    <input value={location} onChange={(e) => setLocation(e.target.value)} spellCheck={false} />
                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        const dir = await open({ directory: true, defaultPath: location || undefined });
                        if (typeof dir === "string") setLocation(dir);
                      }}
                    >
                      Examinar…
                    </button>
                  </div>
                </label>
              </>
            ) : (
              <div className="sample-empty muted">
                <Codicon name="arrow-left" /> Elige un ejemplo para ver qué incluye.
              </div>
            )}
          </div>
        </div>

        {error && <pre className="hint err">{error}</pre>}

        <div className="actions">
          <span className="muted small samples-source">
            {catalog && (catalog.online ? (
              <><Codicon name="cloud" /> Catálogo actualizado desde GitHub</>
            ) : (
              <><Codicon name="package" /> Ejemplos incluidos en Raxorin Studio</>
            ))}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={!selected || !nameOk || !location || busy}>
            {busy ? "Creando…" : "Crear y abrir"}
          </button>
        </div>
      </div>
    </div>
  );
}
