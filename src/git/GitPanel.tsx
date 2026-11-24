import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, type GitBranch, type GitCommit, type GitFile } from "../api";
import { Codicon, FileIcon } from "../components/Icon";
import { basename } from "../util";
import { gitLetter, repoPath, type GitState } from "./useGit";

export type GitIntent = "commit" | "new-branch" | "branches" | null;

interface Props {
  git: GitState;
  onOpenFile: (path: string) => void;
  onDiff: (repo: string, file: GitFile, staged: boolean) => void;
  onClone: () => void;
  onPublishGitHub: () => void;
  intent: GitIntent;
  onIntentDone: () => void;
}

/** URL web de un remoto de GitHub (https o ssh), o null. */
export function githubUrl(remote: string | undefined): string | null {
  if (!remote) return null;
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

const LETTER_TITLE: Record<string, string> = {
  M: "Modificado", A: "Agregado", D: "Borrado", R: "Renombrado", C: "En conflicto", U: "Nuevo (sin seguimiento)",
};

/** Ofrece un solo repositorio para toda la solución (en la carpeta del .rxsln). */
function SolutionBanner({ git }: { git: GitState }) {
  const setup = git.solutionSetup;
  if (!setup) return null;
  const withHistory = setup.nested.filter((n) => n.commits > 0 || n.dirty);
  const convert = async () => {
    const lines = setup.nested.map((n) => `• ${basename(n.path)}${n.commits ? ` (${n.commits} commit${n.commits === 1 ? "" : "s"})` : ""}`).join("\n");
    const yes = await ask(
      (setup.hasRepo ? "La carpeta de la solución ya tiene repositorio, " : `Se creará un repositorio en ${setup.base} con todos los proyectos. `) +
        (setup.nested.length
          ? `Estos proyectos tienen su propio repositorio; su carpeta .git irá a la papelera (se puede recuperar):\n${lines}` +
            (withHistory.length ? "\n\nEl historial de esos repositorios no pasa al nuevo: empezará desde cero." : "")
          : ""),
      { title: "Un solo repositorio para la solución", kind: "warning", okLabel: "Continuar", cancelLabel: "Cancelar" },
    );
    if (yes) await git.ops.initSolution();
  };
  return (
    <div className="git-solution">
      <Codicon name="layers" />
      <div>
        <strong>Subir la solución completa</strong>
        <div className="muted small">
          {setup.nested.length
            ? `Cada proyecto tiene su propio repositorio (${setup.nested.length}). Para subir la solución entera a GitHub, usa uno solo.`
            : "La solución todavía no tiene repositorio. Créalo para guardar y subir todos sus proyectos juntos."}
        </div>
        <button className="btn small primary" disabled={!!git.busy} onClick={convert}>
          <Codicon name="repo" /> Usar un solo repositorio para la solución
        </button>
      </div>
    </div>
  );
}

/** Panel de control de código fuente, como "Cambios de Git" de Visual Studio. */
export default function GitPanel({ git, onOpenFile, onDiff, onClone, onPublishGitHub, intent, onIntentDone }: Props) {
  const { status, repo, busy, ops } = git;
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [commitMenu, setCommitMenu] = useState(false);
  const [branchMenu, setBranchMenu] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [newBranch, setNewBranch] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [log, setLog] = useState<GitCommit[]>([]);
  const [open, setOpen] = useState({ staged: true, changes: true, history: false });
  const [identity, setIdentity] = useState<{ name: string; email: string } | null>(null);
  const [stashCount, setStashCount] = useState(0);
  const msgRef = useRef<HTMLTextAreaElement>(null);

  const files = status?.files ?? [];
  const staged = files.filter((f) => f.index !== "." && f.index !== "?" && !f.conflict);
  const changes = files.filter((f) => f.worktree !== "." || f.index === "?" || f.conflict);
  const ghUrl = githubUrl(status?.remotes.find((r) => r.name === "origin")?.url ?? status?.remotes[0]?.url);

  // Historial, identidad y stash: al cambiar de repositorio o de commit.
  const head = `${status?.branch}|${status?.ahead}|${status?.behind}|${status?.hasCommits}`;
  useEffect(() => {
    if (!repo) return;
    api.gitLog(repo, 50).then(setLog).catch(() => setLog([]));
    api.gitStashCount(repo).then(setStashCount).catch(() => setStashCount(0));
  }, [repo, head]);
  useEffect(() => {
    if (repo) api.gitIdentity(repo).then(setIdentity).catch(() => setIdentity(null));
  }, [repo]);

  // Acciones pedidas desde el menú Git.
  useEffect(() => {
    if (!intent) return;
    if (intent === "commit") msgRef.current?.focus();
    if (intent === "new-branch") {
      setBranchMenu(true);
      setNewBranch("");
    }
    if (intent === "branches") setBranchMenu(true);
    onIntentDone();
  }, [intent, onIntentDone]);

  // Cerrar los menús al hacer clic afuera.
  useEffect(() => {
    if (!branchMenu && !commitMenu) return;
    const close = () => {
      setBranchMenu(false);
      setCommitMenu(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [branchMenu, commitMenu]);

  useEffect(() => {
    if (branchMenu && repo) api.gitBranches(repo).then(setBranches).catch(() => setBranches([]));
    if (!branchMenu) {
      setNewBranch(null);
      setFilter("");
    }
  }, [branchMenu, repo]);

  // Sin repositorio: ofrecer crearlo o clonar.
  if (!repo || !status) {
    const target = git.untrackedRoots[0];
    return (
      <div className="git-panel">
        <div className="panel-title"><span>GIT</span></div>
        <SolutionBanner git={git} />
        {!git.solutionSetup && (
        <div className="git-empty">
          <Codicon name="source-control" className="git-empty-icon" />
          {target ? (
            <>
              <p>Esta carpeta todavía no usa Git (control de versiones).</p>
              <button className="btn primary" disabled={!!busy} onClick={() => ops.init(target)}>
                <Codicon name="repo" /> Inicializar repositorio
              </button>
            </>
          ) : (
            <p className="muted">Abre una carpeta para usar Git.</p>
          )}
          <button className="btn" onClick={onClone}>
            <Codicon name="repo-clone" /> Clonar un repositorio…
          </button>
          <p className="muted small">Git guarda el historial de tus cambios y te permite subirlos a GitHub.</p>
        </div>
        )}
      </div>
    );
  }

  const nothingStaged = staged.length === 0;
  const canCommit = !busy && (amend || (message.trim() !== "" && files.length > 0));
  const doCommit = async (push: boolean) => {
    setCommitMenu(false);
    if (!canCommit) return;
    const res = await ops.commit(message, amend, nothingStaged && !amend);
    if (res !== undefined) {
      setMessage("");
      setAmend(false);
      if (push) await ops.push();
    }
  };

  const discard = async (list: GitFile[]) => {
    if (!list.length) return;
    const yes = await ask(
      list.length === 1
        ? `¿Descartar los cambios de “${basename(list[0].path)}”? ${list[0].index === "?" ? "El archivo nuevo irá a la papelera." : "Volverá a como estaba en el último commit."}`
        : `¿Descartar los cambios de ${list.length} archivos? Los archivos nuevos irán a la papelera.`,
      { title: "Descartar cambios", kind: "warning", okLabel: "Descartar", cancelLabel: "Cancelar" },
    );
    if (!yes) return;
    await ops.discard(
      list.filter((f) => f.index !== "?").map((f) => f.path),
      list.filter((f) => f.index === "?").map((f) => f.path),
    );
  };

  const fileRow = (f: GitFile, isStaged: boolean) => {
    const letter = isStaged ? (f.index === "T" ? "M" : f.index) : gitLetter({ ...f, index: f.index === "?" ? "?" : "." });
    const abs = repoPath(repo, f.path);
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    return (
      <div key={(isStaged ? "s:" : "c:") + f.path} className="git-file" onClick={() => onDiff(repo, f, isStaged)} title={`${f.path} — clic para ver los cambios`}>
        <FileIcon name={basename(f.path)} />
        <span className={"git-name" + (letter === "D" ? " deleted" : "")}>{basename(f.path)}</span>
        <span className="git-dir">{dir}</span>
        <span className="git-actions" onClick={(e) => e.stopPropagation()}>
          {letter !== "D" && (
            <button className="icon-btn" title="Abrir archivo" onClick={() => onOpenFile(abs)}><Codicon name="go-to-file" /></button>
          )}
          {isStaged ? (
            <button className="icon-btn" title="Quitar de los preparados" onClick={() => ops.unstage([f.path])}><Codicon name="remove" /></button>
          ) : (
            <>
              <button className="icon-btn" title="Descartar cambios" onClick={() => discard([f])}><Codicon name="discard" /></button>
              <button className="icon-btn" title="Preparar para el commit" onClick={() => ops.stage([f.path])}><Codicon name="add" /></button>
            </>
          )}
        </span>
        <span className={"git-letter l-" + letter} title={LETTER_TITLE[letter] ?? letter}>{letter}</span>
      </div>
    );
  };

  const local = branches.filter((b) => !b.remote && b.name.toLowerCase().includes(filter.toLowerCase()));
  const remote = branches.filter(
    (b) => b.remote && b.name.toLowerCase().includes(filter.toLowerCase()) && !branches.some((l) => !l.remote && b.name.endsWith("/" + l.name)),
  );

  return (
    <div className="git-panel">
      <div className="panel-title">
        <span>GIT</span>
        <span className="title-actions always">
          {busy && <Codicon name="loading" spin title={busy} />}
          <button className="icon-btn" title="Actualizar" onClick={() => git.refresh()}><Codicon name="refresh" /></button>
          {ghUrl && (
            <button className="icon-btn" title="Abrir en GitHub" onClick={() => openUrl(ghUrl)}><Codicon name="github" /></button>
          )}
        </span>
      </div>

      {git.repos.length > 1 && (
        <select className="git-repo-select" value={repo} onChange={(e) => git.setRepo(e.target.value)} title="Repositorio">
          {git.repos.map((r) => <option key={r} value={r}>{basename(r)}</option>)}
        </select>
      )}

      {/* ----- Rama y sincronización ----- */}
      <div className="git-branch-row" onMouseDown={(e) => e.stopPropagation()}>
        <button className="git-branch-btn" onClick={() => setBranchMenu((o) => !o)} title="Ramas: cambiar, crear, combinar o borrar">
          <Codicon name="git-branch" />
          <span className="git-branch-name">{status.detached ? "(sin rama)" : status.branch ?? "main"}</span>
          <Codicon name="chevron-down" className="muted" />
        </button>
        <button className="icon-btn" title="Traer cambios del servidor (fetch)" disabled={!!busy || !status.remotes.length} onClick={() => ops.fetch()}>
          <Codicon name="cloud-download" />
        </button>
        <button className="git-sync" title="Pull: bajar los cambios del servidor" disabled={!!busy || !status.remotes.length} onClick={() => ops.pull()}>
          <Codicon name="arrow-down" />{status.behind > 0 && <span>{status.behind}</span>}
        </button>
        <button className="git-sync" title={status.upstream ? "Push: subir tus commits" : "Push: publicar esta rama en el servidor"} disabled={!!busy || !status.remotes.length || !status.hasCommits} onClick={() => ops.push()}>
          <Codicon name="arrow-up" />{status.ahead > 0 && <span>{status.ahead}</span>}
        </button>

        {branchMenu && (
          <div className="context-menu dropdown git-branch-menu" onMouseDown={(e) => e.stopPropagation()}>
            {newBranch !== null ? (
              <form
                className="git-new-branch"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const name = newBranch.trim();
                  if (!name) return;
                  setBranchMenu(false);
                  await ops.checkout(name, true);
                }}
              >
                <div className="menu-header">Nueva rama desde “{status.branch}”</div>
                <input autoFocus value={newBranch} onChange={(e) => setNewBranch(e.target.value.replace(/\s/g, "-"))} placeholder="nombre-de-la-rama" spellCheck={false} />
              </form>
            ) : (
              <>
                <input className="git-branch-filter" autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Buscar rama…" spellCheck={false} />
                <button className="menu-item" onClick={() => setNewBranch("")}>
                  <span className="menu-label"><Codicon name="add" /> Nueva rama…</span>
                </button>
                <div className="menu-sep" />
                <div className="menu-header">Ramas locales</div>
                {local.map((b) => (
                  <div key={b.name} className="git-branch-item">
                    <button className="menu-item" disabled={b.current} onClick={() => { setBranchMenu(false); ops.checkout(b.name); }}>
                      <span className="menu-label">
                        <Codicon name="check" className={"menu-check" + (b.current ? "" : " off")} />
                        {b.name}
                      </span>
                      {b.upstream && <span className="muted small">{b.upstream}</span>}
                    </button>
                    {!b.current && (
                      <span className="git-branch-actions">
                        <button className="icon-btn" title={`Combinar “${b.name}” en “${status.branch}” (merge)`} onClick={() => { setBranchMenu(false); ops.merge(b.name); }}>
                          <Codicon name="git-merge" />
                        </button>
                        <button
                          className="icon-btn"
                          title="Borrar rama"
                          onClick={async () => {
                            setBranchMenu(false);
                            if (await ask(`¿Borrar la rama “${b.name}”?`, { title: "Borrar rama", kind: "warning", okLabel: "Borrar", cancelLabel: "Cancelar" })) {
                              const ok = await ops.deleteBranch(b.name);
                              if (ok !== true && (await ask(`“${b.name}” tiene commits que no están en otra rama. ¿Borrarla de todos modos? Esos commits se perderán.`, { title: "Borrar rama", kind: "warning", okLabel: "Borrar", cancelLabel: "Cancelar" }))) {
                                await ops.deleteBranch(b.name, true);
                              }
                            }
                          }}
                        >
                          <Codicon name="trash" />
                        </button>
                      </span>
                    )}
                  </div>
                ))}
                {remote.length > 0 && (
                  <>
                    <div className="menu-sep" />
                    <div className="menu-header">Ramas del servidor</div>
                    {remote.map((b) => (
                      <button key={b.name} className="menu-item" onClick={() => { setBranchMenu(false); ops.checkout(b.name, false, true); }}>
                        <span className="menu-label"><Codicon name="cloud" /> {b.name}</span>
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="git-body">
        <SolutionBanner git={git} />
        {git.error && (
          <div className="git-error">
            <Codicon name="error" />
            <pre>{git.error}</pre>
            <button className="icon-btn" title="Cerrar" onClick={git.clearError}><Codicon name="close" /></button>
          </div>
        )}
        {git.outside.length > 0 && (
          <div className="git-warning" title={git.outside.join("\n")}>
            <Codicon name="warning" />
            {git.outside.length === 1 ? "Un proyecto abierto está" : `${git.outside.length} proyectos abiertos están`} fuera de este repositorio:{" "}
            {git.outside.map((p) => basename(p)).join(", ")}. Sus cambios no aparecen aquí.
          </div>
        )}
        {status.inProgress && (
          <div className="git-warning">
            <Codicon name="warning" /> Hay un {status.inProgress} a medias. Resuelve los conflictos, prepara los archivos y confirma.
          </div>
        )}

        {identity && (!identity.name || !identity.email) && <IdentityForm repo={repo} initial={identity} onSaved={setIdentity} />}

        {/* ----- Commit ----- */}
        <div className="git-commit">
          <textarea
            ref={msgRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={amend ? "Mensaje (vacío = conservar el anterior)" : `Mensaje del commit (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter para confirmar)`}
            rows={3}
            spellCheck
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void doCommit(false);
              }
            }}
          />
          <div className="git-commit-row" onMouseDown={(e) => e.stopPropagation()}>
            <button className="btn primary git-commit-btn" disabled={!canCommit} onClick={() => doCommit(false)}>
              <Codicon name="check" /> {amend ? "Modificar último commit" : nothingStaged && files.length ? "Confirmar todo" : "Confirmar"}
            </button>
            <button className="btn primary git-commit-more" disabled={!canCommit && !status.hasCommits} onClick={() => setCommitMenu((o) => !o)} title="Más opciones">
              <Codicon name="chevron-down" />
            </button>
            {commitMenu && (
              <div className="context-menu dropdown align-right" onMouseDown={(e) => e.stopPropagation()}>
                <button className="menu-item" disabled={!canCommit || !status.remotes.length} onClick={() => doCommit(true)}>
                  <span className="menu-label"><Codicon name="arrow-up" /> Confirmar y hacer push</span>
                </button>
                <button className="menu-item" disabled={!status.hasCommits} onClick={() => { setAmend((a) => !a); setCommitMenu(false); }}>
                  <span className="menu-label"><Codicon name="check" className={"menu-check" + (amend ? "" : " off")} /> Modificar el último commit (amend)</span>
                </button>
                <div className="menu-sep" />
                <button className="menu-item" disabled={!files.length} onClick={() => { setCommitMenu(false); ops.stash(false); }}>
                  <span className="menu-label"><Codicon name="archive" /> Guardar cambios temporalmente (stash)</span>
                </button>
                <button className="menu-item" disabled={!stashCount} onClick={() => { setCommitMenu(false); ops.stash(true); }}>
                  <span className="menu-label"><Codicon name="unarchive" /> Recuperar cambios guardados{stashCount ? ` (${stashCount})` : ""}</span>
                </button>
              </div>
            )}
          </div>
          {nothingStaged && files.length > 0 && !amend && (
            <div className="muted small">No preparaste archivos: se confirmarán todos los cambios.</div>
          )}
        </div>

        {/* ----- Cambios ----- */}
        {staged.length > 0 && (
          <section className="git-section">
            <div className="git-section-head" onClick={() => setOpen((o) => ({ ...o, staged: !o.staged }))}>
              <Codicon name={open.staged ? "chevron-down" : "chevron-right"} />
              <span>Cambios preparados</span>
              <span className="count">{staged.length}</span>
              <span className="git-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="Quitar todos de los preparados" onClick={() => ops.unstage([])}><Codicon name="remove" /></button>
              </span>
            </div>
            {open.staged && staged.map((f) => fileRow(f, true))}
          </section>
        )}
        <section className="git-section">
          <div className="git-section-head" onClick={() => setOpen((o) => ({ ...o, changes: !o.changes }))}>
            <Codicon name={open.changes ? "chevron-down" : "chevron-right"} />
            <span>Cambios</span>
            <span className="count">{changes.length}</span>
            {changes.length > 0 && (
              <span className="git-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="Descartar todos los cambios" onClick={() => discard(changes)}><Codicon name="discard" /></button>
                <button className="icon-btn" title="Preparar todos" onClick={() => ops.stage([])}><Codicon name="add" /></button>
              </span>
            )}
          </div>
          {open.changes && changes.map((f) => fileRow(f, false))}
          {open.changes && !changes.length && <div className="muted small git-clean">No hay cambios sin confirmar.</div>}
        </section>

        {/* ----- GitHub ----- */}
        {!status.remotes.length && (
          <div className="git-github">
            <Codicon name="github" />
            <div>
              <strong>Sin servidor remoto</strong>
              <div className="muted small">Publica el proyecto en GitHub para tener una copia en línea y compartirlo.</div>
              <button className="btn small" onClick={onPublishGitHub} disabled={!status.hasCommits || !!busy} title={status.hasCommits ? "" : "Haz un commit primero"}>
                <Codicon name="cloud-upload" /> Publicar en GitHub…
              </button>
            </div>
          </div>
        )}

        {/* ----- Historial ----- */}
        <section className="git-section">
          <div className="git-section-head" onClick={() => setOpen((o) => ({ ...o, history: !o.history }))}>
            <Codicon name={open.history ? "chevron-down" : "chevron-right"} />
            <span>Historial</span>
            <span className="count">{log.length}{log.length === 50 ? "+" : ""}</span>
          </div>
          {open.history && !log.length && <div className="muted small git-clean">Todavía no hay commits.</div>}
          {open.history &&
            log.map((c) => (
              <div key={c.hash} className="git-commit-item" title={`${c.hash}\n${c.author} · ${c.date}`}>
                <Codicon name="git-commit" />
                <div>
                  <div className="git-commit-subject">
                    {c.subject}
                    {c.refs && c.refs.split(", ").map((r) => (
                      <span key={r} className={"git-ref" + (r.startsWith("HEAD") ? " head" : r.startsWith("tag:") ? " tag" : "")}>{r.replace("HEAD -> ", "")}</span>
                    ))}
                  </div>
                  <div className="muted small">{c.short} · {c.author} · {c.date}</div>
                </div>
              </div>
            ))}
        </section>
      </div>
    </div>
  );
}

function IdentityForm({ repo, initial, onSaved }: { repo: string; initial: { name: string; email: string }; onSaved: (v: { name: string; email: string }) => void }) {
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [err, setErr] = useState("");
  return (
    <form
      className="git-identity"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.gitSetIdentity(repo, name, email);
          onSaved({ name, email });
        } catch (x) {
          setErr(String(x));
        }
      }}
    >
      <strong><Codicon name="account" /> ¿Quién firma los commits?</strong>
      <span className="muted small">Git guarda tu nombre y correo en cada commit. Se configura una sola vez.</span>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" />
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@correo.com" type="email" />
      {err && <span className="hint err">{err}</span>}
      <button className="btn small primary" disabled={!name.trim() || !email.includes("@")}>Guardar</button>
    </form>
  );
}
