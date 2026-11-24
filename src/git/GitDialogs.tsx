import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { Codicon } from "../components/Icon";

/** Clonar un repositorio (de GitHub u otro servidor) en una carpeta. */
export function CloneDialog({ defaultParent, onCloned, onClose }: { defaultParent: string; onCloned: (dir: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(defaultParent);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const valid = /^(https?:\/\/|git@|ssh:\/\/)\S+$/.test(url.trim()) && !!parent;
  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          setBusy(true);
          setErr("");
          try {
            const dir = await api.gitClone(url.trim(), parent);
            onCloned(dir);
            onClose();
          } catch (x) {
            setErr(String(x));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2><Codicon name="repo-clone" /> Clonar un repositorio</h2>
        <label>
          Dirección del repositorio
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/usuario/proyecto.git" spellCheck={false} />
        </label>
        <label>
          Carpeta donde se creará
          <div className="row">
            <input className="grow" value={parent} onChange={(e) => setParent(e.target.value)} spellCheck={false} />
            <button type="button" className="btn" onClick={async () => {
              const d = await open({ directory: true, defaultPath: parent });
              if (typeof d === "string") setParent(d);
            }}><Codicon name="folder-opened" /> Elegir…</button>
          </div>
        </label>
        {err && <pre className="hint err git-dialog-err">{err}</pre>}
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="btn primary" disabled={!valid || busy}>
            {busy ? <><Codicon name="loading" spin /> Clonando…</> : <><Codicon name="repo-clone" /> Clonar y abrir</>}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Publicar el repositorio actual en GitHub (crea el repositorio con `gh` y sube la rama). */
export function PublishGitHubDialog({ defaultName, onPublish, onClose }: {
  defaultName: string;
  onPublish: (name: string, priv: boolean, description: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [gh, setGh] = useState<{ installed: boolean; user: string | null } | null>(null);
  const [name, setName] = useState(defaultName.replace(/[^A-Za-z0-9._-]/g, "-"));
  const [description, setDescription] = useState("");
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState(false);

  const check = () => api.ghStatus().then(setGh).catch(() => setGh({ installed: false, user: null }));
  useEffect(() => {
    void check();
    // Tras iniciar sesión en la terminal, volver a revisar al regresar a la ventana.
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  const valid = /^[A-Za-z0-9._-]+$/.test(name);
  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid || !gh?.user) return;
          setBusy(true);
          const res = await onPublish(name, priv, description);
          setBusy(false);
          if (res !== undefined) onClose();
        }}
      >
        <h2><Codicon name="github" /> Publicar en GitHub</h2>
        {!gh ? (
          <div className="muted"><Codicon name="loading" spin /> Revisando GitHub…</div>
        ) : !gh.installed ? (
          <div className="git-github-need">
            <p>Para publicar se necesita <strong>GitHub CLI</strong> (gh).</p>
            <p className="muted small">Instálalo desde cli.github.com (en macOS: <code>brew install gh</code>) y vuelve a abrir este diálogo.</p>
          </div>
        ) : !gh.user ? (
          <div className="git-github-need">
            <p>Inicia sesión en GitHub. Se abrirá una terminal: sigue los pasos (te pedirá un código en el navegador) y luego vuelve aquí.</p>
            <button type="button" className="btn primary" onClick={() => api.ghLogin()}>
              <Codicon name="sign-in" /> Iniciar sesión en GitHub
            </button>
          </div>
        ) : (
          <>
            <div className="muted small"><Codicon name="account" /> Se creará en la cuenta <strong>{gh.user}</strong></div>
            <label>
              Nombre del repositorio
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
              {!valid && <span className="hint err">Usa letras, números, “-”, “_” o “.”, sin espacios.</span>}
            </label>
            <label>
              Descripción (opcional)
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div className="segmented">
              <button type="button" className={priv ? "active" : ""} onClick={() => setPriv(true)}>
                <Codicon name="lock" /> Privado (solo tú y a quien invites)
              </button>
              <button type="button" className={!priv ? "active" : ""} onClick={() => setPriv(false)}>
                <Codicon name="globe" /> Público
              </button>
            </div>
          </>
        )}
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="btn primary" disabled={!gh?.user || !valid || busy}>
            {busy ? <><Codicon name="loading" spin /> Publicando…</> : <><Codicon name="cloud-upload" /> Publicar</>}
          </button>
        </div>
      </form>
    </div>
  );
}
