import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { Codicon } from "./Icon";

type Kind = "bin" | "lib";

interface Props {
  /** Carpeta abierta actualmente (para "agregar a la carpeta actual"). */
  currentRoot: string | null;
  onCancel: () => void;
  onCreate: (parent: string, name: string, kind: Kind, addToCurrent: boolean) => Promise<void>;
}

const TEMPLATES: { kind: Kind | null; icon: string; title: string; desc: string }[] = [
  { kind: "bin", icon: "terminal", title: "Aplicación de consola", desc: "Un programa que se ejecuta en la terminal." },
  { kind: "lib", icon: "library", title: "Biblioteca", desc: "Código reutilizable para otros proyectos." },
  { kind: null, icon: "window", title: "Aplicación de ventana", desc: "Diseñador visual con Slint · Próximamente" },
];

export default function NewProjectDialog({ currentRoot, onCancel, onCreate }: Props) {
  const [kind, setKind] = useState<Kind>("bin");
  const [name, setName] = useState("mi_app");
  const [location, setLocation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [addToCurrent, setAddToCurrent] = useState(!!currentRoot);
  const [defaultLocation, setDefaultLocation] = useState("");

  useEffect(() => {
    homeDir()
      .then((h) => join(h, "RustProjects"))
      .then((d) => {
        setDefaultLocation(d);
        if (!currentRoot) setLocation(d);
      })
      .catch(() => {});
  }, [currentRoot]);

  useEffect(() => {
    if (addToCurrent && currentRoot) setLocation(currentRoot);
    else if (defaultLocation) setLocation(defaultLocation);
  }, [addToCurrent, currentRoot, defaultLocation]);

  const valid = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) && location.length > 0;

  const browse = async () => {
    const dir = await open({ directory: true, defaultPath: location || undefined });
    if (typeof dir === "string") setLocation(dir);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(location, name, kind, addToCurrent && !!currentRoot);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Nuevo proyecto</h2>
        <div className="templates">
          {TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.title}
              disabled={t.kind === null}
              className={"template" + (t.kind === kind ? " selected" : "")}
              onClick={() => t.kind && setKind(t.kind)}
            >
              <Codicon name={t.icon} className="template-icon" />
              <span>
                <strong>{t.title}</strong>
                <small>{t.desc}</small>
              </span>
            </button>
          ))}
        </div>
        <label>
          Nombre del proyecto
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} />
        </label>
        {!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) && name.length > 0 && (
          <div className="hint err">Usa letras, números, “_” o “-”, sin empezar con número.</div>
        )}
        {currentRoot && (
          <div className="segmented">
            <button type="button" className={addToCurrent ? "active" : ""} onClick={() => setAddToCurrent(true)}>
              <Codicon name="add" /> Agregar a la carpeta actual
            </button>
            <button type="button" className={!addToCurrent ? "active" : ""} onClick={() => setAddToCurrent(false)}>
              <Codicon name="folder-opened" /> Crear en otra ubicación
            </button>
          </div>
        )}
        <label>
          Ubicación
          <div className="row">
            <input value={location} onChange={(e) => setLocation(e.target.value)} spellCheck={false} />
            <button type="button" className="btn" onClick={browse}>Examinar…</button>
          </div>
        </label>
        {error && <pre className="hint err">{error}</pre>}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={!valid || busy}>
            {busy ? "Creando…" : addToCurrent && currentRoot ? "Agregar" : "Crear"}
          </button>
        </div>
      </form>
    </div>
  );
}
