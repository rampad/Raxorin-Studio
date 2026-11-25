import { useEffect, useState } from "react";
import { api, type Dependency, type ProjectInfo } from "../api";
import { relative } from "../util";
import { Codicon, FileIcon } from "./Icon";
import { t, tErr } from "../i18n/index.ts";

interface Props {
  root: string;
  target: ProjectInfo;
  projects: ProjectInfo[];
  onClose: () => void;
  onAdded: (message: string) => void;
}

/** "Agregar referencia": que un proyecto use una biblioteca de la misma carpeta. */
export default function ReferenceDialog({ root, target, projects, onClose, onAdded }: Props) {
  const [deps, setDeps] = useState<Dependency[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.crateList(target.dir).then(setDeps).catch(() => {});
  }, [target.dir]);

  const candidates = projects.filter((p) => p.dir !== target.dir && p.kind === "lib");
  // Cargo normaliza "-" y "_" en los nombres de crate.
  const norm = (n: string) => n.replace(/-/g, "_");
  const has = (p: ProjectInfo) => deps.some((d) => norm(d.name) === norm(p.name));

  const add = async (p: ProjectInfo) => {
    setBusy(p.name);
    setError("");
    try {
      const msg = await api.addProjectReference(target.dir, p.dir);
      setDeps(await api.crateList(target.dir));
      onAdded(msg || `${target.name} ahora usa ${p.name}`);
    } catch (e) {
      setError(tErr(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t("Agregar referencia a “")}{target.name}”</h2>
        <p className="muted small" style={{ margin: 0 }}>
          
          {t("Elige una biblioteca de esta carpeta. Después podrás usarla en el código con")}{" "}
          <code>use nombre_biblioteca::…;</code>
        </p>
        {candidates.length === 0 ? (
          <div className="muted pad">
            
            {t("No hay otras bibliotecas en la carpeta. Crea una con")}{" "}<strong>{t("Nuevo → Biblioteca → Agregar a la carpeta actual")}</strong>.
          </div>
        ) : (
          <div className="ref-list">
            {candidates.map((p) => (
              <div key={p.dir} className="ref-row">
                <FileIcon name={p.name} project="lib" size={20} />
                <span className="ref-name">
                  <strong>{p.name}</strong>
                  <small className="muted">{relative(root, p.dir) || "."}</small>
                </span>
                <span className="spacer" />
                {has(p) ? (
                  <span className="pkg-check"><Codicon name="check" /> referenciada</span>
                ) : (
                  <button className="btn small primary" disabled={!!busy} onClick={() => add(p)}>
                    {busy === p.name ? t("Agregando…") : t("Agregar")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {error && <pre className="hint err">{error}</pre>}
        <div className="actions">
          <button className="btn" onClick={onClose}>{t("Cerrar")}</button>
        </div>
      </div>
    </div>
  );
}
