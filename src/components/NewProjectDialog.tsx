import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";

type Kind = "bin" | "lib";

interface Props {
  onCancel: () => void;
  onCreate: (parent: string, name: string, kind: Kind) => Promise<void>;
}

const TEMPLATES: { kind: Kind | null; icon: string; title: string; desc: string }[] = [
  { kind: "bin", icon: "🖥️", title: "Aplicación de consola", desc: "Un programa que se ejecuta en la terminal." },
  { kind: "lib", icon: "📦", title: "Biblioteca", desc: "Código reutilizable para otros proyectos." },
  { kind: null, icon: "🪟", title: "Aplicación de ventana", desc: "Diseñador visual con Slint · Próximamente" },
];

export default function NewProjectDialog({ onCancel, onCreate }: Props) {
  const [kind, setKind] = useState<Kind>("bin");
  const [name, setName] = useState("mi_app");
  const [location, setLocation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    homeDir().then((h) => join(h, "RustProjects")).then(setLocation).catch(() => {});
  }, []);

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
      await onCreate(location, name, kind);
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
              <span className="template-icon">{t.icon}</span>
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
            {busy ? "Creando…" : "Crear"}
          </button>
        </div>
      </form>
    </div>
  );
}
