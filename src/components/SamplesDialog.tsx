import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { api, type Sample, type SampleCatalog } from "../api";
import { Codicon } from "./Icon";
import { t, tErr } from "../i18n/index.ts";

interface Props {
  onCancel: () => void;
  /** Abre lo creado: la carpeta del proyecto o el .rxsln, y el archivo a mostrar. */
  onCreated: (sample: Sample, created: { open: string; file: string }) => Promise<void>;
}

const TIPO: Record<Sample["tipo"], string> = {
  ventana: t("Aplicación de ventana"),
  consola: t("Aplicación de consola"),
  biblioteca: "Biblioteca",
  solucion: t("Solución"),
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
    api.samplesList().then(setCatalog).catch((e) => setError(tErr(e)));
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
      setError(tErr(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div className="modal samples-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Codicon name="beaker" /> {" "}{t("Ejemplos")}
        </h2>
        <p className="muted small">
          
          {t("Aplicaciones de muestra listas para ejecutar. Crea una copia, pulsa")}{" "}<kbd>F5</kbd> {" "}{t("y lee el código: cada ejemplo explica lo que hace.")}
        </p>

        <div className="samples-filters">
          <div className="samples-search">
            <Codicon name="search" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Buscar (p. ej. lista, depurar, trait)…")}
              spellCheck={false}
              autoFocus
            />
          </div>
          <div className="chips">
            <button className={"chip" + (!category ? " active" : "")} onClick={() => setCategory(null)}>
              
              {t("Todos")}
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
                <Codicon name="loading" spin /> {" "}{t("Cargando ejemplos…")}
              </p>
            )}
            {catalog && visible.length === 0 && <p className="muted">{t("Ningún ejemplo coincide con la búsqueda.")}</p>}
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
                    <span className={"tag level" + (s.nivel === "Principiante" || s.nivel === "Beginner" ? " easy" : "")}>{s.nivel}</span>
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
                    <div className="sample-section">{t("Aprenderás")}</div>
                    <ul className="sample-learn small">
                      {selected.aprenderas.map((a) => (
                        <li key={a}>
                          <Codicon name="check" /> {a}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="sample-section">{t("Archivos")}</div>
                <div className="sample-files small">
                  {selected.archivos.filter((f) => !f.endsWith(".gitignore")).map((f) => (
                    <code key={f}>{f}</code>
                  ))}
                </div>
                <label>
                  {isSolution ? t("Nombre de la solución") : t("Nombre del proyecto")}
                  <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
                </label>
                {!nameOk && name.length > 0 && (
                  <div className="hint err">
                    {isSolution ? t("El nombre no puede tener / \\ : * ? \" < > |") : t("Usa letras, números, “_” o “-”, sin empezar con número.")}
                  </div>
                )}
                <label>
                  
                  {t("Ubicación")}
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
                      
                      {t("Examinar…")}
                    </button>
                  </div>
                </label>
              </>
            ) : (
              <div className="sample-empty muted">
                <Codicon name="arrow-left" /> {" "}{t("Elige un ejemplo para ver qué incluye.")}
              </div>
            )}
          </div>
        </div>

        {error && <pre className="hint err">{error}</pre>}

        <div className="actions">
          <span className="muted small samples-source">
            {catalog && (catalog.online ? (
              <><Codicon name="cloud" /> {" "}{t("Catálogo actualizado desde GitHub")}</>
            ) : (
              <><Codicon name="package" /> {" "}{t("Ejemplos incluidos en Raxorin Studio")}</>
            ))}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onCancel} disabled={busy}>
            
            {t("Cancelar")}
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={!selected || !nameOk || !location || busy}>
            {busy ? t("Creando…") : t("Crear y abrir")}
          </button>
        </div>
      </div>
    </div>
  );
}
