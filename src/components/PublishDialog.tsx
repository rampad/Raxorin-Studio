import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { api, type CrossStatus, type GithubPublishInfo, type ProjectInfo, type PublishOptions, type RustTargets } from "../api";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Codicon, FileIcon } from "./Icon";

const KEY = "raxorinstudio.publish";
/** Windows de 64 bits, compilable desde macOS/Linux con MinGW-w64. */
const WINDOWS = "x86_64-pc-windows-gnu";

interface Saved { outDir?: Record<string, string>; zip?: boolean; open?: boolean; target?: string; mode?: Mode }

function readSaved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/** Nombre amigable de una plataforma de Rust (triple). */
export function platformName(triple: string): string {
  const os = /windows/.test(triple) ? "Windows" : /apple-darwin/.test(triple) ? "macOS" : /linux/.test(triple) ? "Linux" : /wasm/.test(triple) ? "WebAssembly" : triple;
  const arch = /^aarch64/.test(triple) ? "ARM 64 bits" : /^x86_64/.test(triple) ? "Intel/AMD 64 bits" : /^i686/.test(triple) ? "32 bits" : "";
  return arch ? `${os} (${arch})` : os;
}

interface Props {
  projects: ProjectInfo[];
  startup: ProjectInfo | null;
  onPublish: (dir: string, opts: PublishOptions) => void;
  /** Instala lo que falta para compilar para otra plataforma. */
  onSetupTarget: (dir: string, target: string) => void;
  /** Solución abierta: en GitHub se publican todos sus programas. */
  solution: { name: string; dir: string } | null;
  workspace: string | null;
  onShowGit: () => void;
  log: (text: string, kind?: "info" | "error" | "warning" | "success" | "muted") => void;
  onClose: () => void;
}

type Mode = "local" | "github";

function ModeSwitch({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="segmented">
      <button type="button" className={mode === "local" ? "active" : ""} onClick={() => setMode("local")}>
        <Codicon name="device-desktop" /> En esta computadora
      </button>
      <button type="button" className={mode === "github" ? "active" : ""} onClick={() => setMode("github")}>
        <Codicon name="github" /> En GitHub (Windows, Linux y macOS)
      </button>
    </div>
  );
}

/** Publicar: compila en Release y deja el ejecutable en una carpeta lista para compartir. */
export default function PublishDialog(props: Props) {
  const { projects, startup, onPublish, onSetupTarget, onClose } = props;
  const bins = projects.filter((p) => p.kind === "bin");
  const saved = readSaved();
  const [mode, setModeState] = useState<Mode>(saved.mode ?? "local");
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...readSaved(), mode: m }));
    } catch {
      /* sin almacenamiento */
    }
  };
  const [dir, setDir] = useState(startup?.kind === "bin" ? startup.dir : bins[0]?.dir ?? "");
  const [outDir, setOutDir] = useState("");
  const [targets, setTargets] = useState<RustTargets | null>(null);
  const [target, setTarget] = useState(saved.target ?? "");
  const [zip, setZip] = useState(saved.zip ?? true);
  const [openAfter, setOpenAfter] = useState(saved.open ?? true);

  useEffect(() => {
    api.rustTargets().then(setTargets).catch(() => setTargets({ host: "", installed: [] }));
  }, []);

  // Carpeta de salida: la última usada para este proyecto, o <proyecto>/publicar.
  useEffect(() => {
    if (!dir) return;
    const prev = saved.outDir?.[dir];
    if (prev) setOutDir(prev);
    else join(dir, "publicar").then(setOutDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  // Windows siempre aparece (desde macOS/Linux se compila con MinGW-w64); además, las plataformas instaladas.
  const hostIsWindows = !!targets?.host.includes("windows");
  const others = [
    ...(targets && !hostIsWindows ? [WINDOWS] : []),
    ...(targets?.installed ?? []).filter((t) => t !== targets?.host && t !== WINDOWS),
  ];
  const validTarget = !target || others.includes(target);
  const [cross, setCross] = useState<CrossStatus | null>(null);
  useEffect(() => {
    setCross(null);
    if (target && validTarget) api.crossStatus(target).then(setCross).catch(() => setCross(null));
  }, [target, validTarget]);
  const ready = !target || !cross || (cross.rustTarget && cross.linkerFound);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dir || !outDir) return;
    const s = readSaved();
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...s, zip, open: openAfter, target, outDir: { ...(s.outDir ?? {}), [dir]: outDir } }));
    } catch {
      /* sin almacenamiento */
    }
    onPublish(dir, { outDir, target: validTarget && target ? target : null, zip, open: openAfter });
    onClose();
  };

  if (mode === "github") {
    return <GithubPublish {...props} bins={bins} mode={mode} setMode={setMode} />;
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal publish" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>
          <Codicon name="package" /> Publicar
        </h2>
        <ModeSwitch mode={mode} setMode={setMode} />
        <p className="muted small">
          Compila en modo <strong>Release</strong> (optimizado) y deja el ejecutable en una carpeta lista para copiar o
          compartir. Quien lo use no necesita tener Rust instalado.
        </p>

        {!bins.length ? (
          <div className="hint err">No hay proyectos ejecutables (de consola o ventana) para publicar.</div>
        ) : (
          <>
            <label>
              Proyecto
              <div className="publish-projects">
                {bins.map((p) => (
                  <button type="button" key={p.dir} className={"template" + (dir === p.dir ? " selected" : "")} onClick={() => setDir(p.dir)}>
                    <FileIcon name={p.name} project={p.kind} />
                    <span>
                      <strong>{p.name}</strong>
                    </span>
                  </button>
                ))}
              </div>
            </label>

            <label>
              Carpeta de destino
              <div className="row">
                <input className="grow" value={outDir} onChange={(e) => setOutDir(e.target.value)} spellCheck={false} />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const d = await open({ directory: true, title: "Carpeta de destino", defaultPath: outDir || dir });
                    if (typeof d === "string") setOutDir(d);
                  }}
                >
                  <Codicon name="folder-opened" /> Elegir…
                </button>
              </div>
            </label>

            <label>
              Plataforma
              <select value={validTarget ? target : ""} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Esta computadora{targets?.host ? ` — ${platformName(targets.host)}` : ""}</option>
                {others.map((t) => (
                  <option key={t} value={t}>
                    {platformName(t)} — {t}
                  </option>
                ))}
              </select>
            </label>
            {target && validTarget && (
              <div className={"cross-status" + (ready ? " ok" : "")}>
                {!cross ? (
                  <span className="muted"><Codicon name="loading" spin /> Revisando…</span>
                ) : ready ? (
                  <span><Codicon name="pass" /> Listo para compilar para {platformName(target)}.</span>
                ) : (
                  <>
                    <div>Para compilar para {platformName(target)} desde esta computadora falta:</div>
                    <ul>
                      {!cross.rustTarget && <li>La plataforma de Rust <code>{target}</code></li>}
                      {!cross.linkerFound && cross.linker && <li>El enlazador <code>{cross.linker}</code> (MinGW-w64)</li>}
                    </ul>
                    {cross.manual && <div className="muted small">{cross.manual}</div>}
                    {cross.canInstall && (
                      <button type="button" className="btn" onClick={() => { onSetupTarget(dir, target); onClose(); }}>
                        <Codicon name="cloud-download" /> Instalar soporte para {platformName(target).split(" ")[0]}
                      </button>
                    )}
                    <div className="muted small">Se instala una sola vez (puede tardar unos minutos). Verás el progreso en la Salida.</div>
                  </>
                )}
              </div>
            )}

            <label className="check-line">
              <input type="checkbox" checked={zip} onChange={(e) => setZip(e.target.checked)} />
              Crear también un archivo .zip
            </label>
            <label className="check-line">
              <input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} />
              Mostrar el resultado al terminar
            </label>
          </>
        )}

        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!dir || !outDir || !ready}>
            <Codicon name="package" /> Publicar
          </button>
        </div>
      </form>
    </div>
  );
}

/** Publicar en GitHub: workflow de GitHub Actions + versión (etiqueta) que lo dispara. */
function GithubPublish({ bins, solution, workspace, startup, onShowGit, log, onClose, mode, setMode }: Props & { bins: ProjectInfo[]; mode: Mode; setMode: (m: Mode) => void }) {
  // Una solución publica todos sus programas; si no, el programa elegido.
  const [dir, setDir] = useState(startup?.kind === "bin" ? startup.dir : bins[0]?.dir ?? "");
  const base = solution?.dir ?? workspace ?? dir;
  const name = solution?.name ?? bins.find((b) => b.dir === dir)?.name ?? "app";
  const list = solution ? bins.map((b) => b.dir) : dir ? [dir] : [];
  const [info, setInfo] = useState<GithubPublishInfo | null>(null);
  const [err, setErr] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const listKey = list.join("|");

  useEffect(() => {
    if (!base || !list.length) return;
    setInfo(null);
    api
      .githubPublishInfo(base, name, list)
      .then((i) => {
        setInfo(i);
        // Versión sugerida: la del Cargo.toml, o la siguiente si ya existe.
        let v = `v${i.version}`;
        while (i.tags.includes(v)) v = v.replace(/(\d+)$/, (n) => String(Number(n) + 1));
        setTag(v);
      })
      .catch((e) => setErr(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, name, listKey]);

  const run = async (withTag: boolean) => {
    setBusy(withTag ? "Subiendo la versión…" : "Escribiendo el workflow…");
    setErr("");
    try {
      const res = await api.githubPublish(base, name, list, withTag ? tag.trim() : null);
      if (withTag) {
        log(`Versión ${tag} subida: GitHub está compilando ${name} para Windows, Linux y macOS. Sigue el progreso en ${res}`, "success");
        await openUrl(res);
        onClose();
      } else {
        log(`Workflow escrito en ${res}. Confírmalo y súbelo (panel Git) para usarlo.`, "success");
        onClose();
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const tagOk = /^v\d+(\.\d+)*([-.][0-9A-Za-z.]+)?$/.test(tag.trim()) && !info?.tags.includes(tag.trim());
  const ready = !!info?.repo && !!info.githubUrl && !info.problem;

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal publish" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Codicon name="package" /> Publicar
        </h2>
        <ModeSwitch mode={mode} setMode={setMode} />
        <p className="muted small">
          GitHub compila {solution ? <>todos los programas de la solución <strong>{solution.name}</strong></> : <>el programa</>} en
          sus propias máquinas con Windows, Linux y macOS (Apple Silicon e Intel) y deja un .zip por sistema en una
          versión (Release) del repositorio. Tarda unos minutos.
        </p>

        {!solution && bins.length > 1 && (
          <label>
            Programa
            <select value={dir} onChange={(e) => setDir(e.target.value)}>
              {bins.map((b) => <option key={b.dir} value={b.dir}>{b.name}</option>)}
            </select>
          </label>
        )}

        {!bins.length ? (
          <div className="hint err">No hay programas ejecutables (de consola o ventana) para publicar.</div>
        ) : !info && !err ? (
          <div className="muted"><Codicon name="loading" spin /> Revisando el repositorio…</div>
        ) : info && !info.repo ? (
          <div className="cross-status">
            <div>{solution ? "La solución" : "El proyecto"} todavía no usa Git. Inicializa el repositorio y publícalo en GitHub desde el panel Git.</div>
            <button type="button" className="btn" onClick={onShowGit}><Codicon name="source-control" /> Ir al panel Git</button>
          </div>
        ) : info && !info.githubUrl ? (
          <div className="cross-status">
            <div>El repositorio todavía no está en GitHub. Publícalo desde el panel Git (botón “Publicar en GitHub…”).</div>
            <button type="button" className="btn" onClick={onShowGit}><Codicon name="source-control" /> Ir al panel Git</button>
          </div>
        ) : info?.problem ? (
          <pre className="hint err git-dialog-err">{info.problem}</pre>
        ) : info ? (
          <>
            <div className="cross-status ok">
              <span><Codicon name="github" /> {info.githubUrl!.replace("https://github.com/", "")}</span>
              <span className="muted small">
                Se compilará{info.programs.length > 1 ? "n" : ""}: {info.programs.join(", ")}
              </span>
            </div>
            <label>
              Versión
              <input value={tag} onChange={(e) => setTag(e.target.value)} spellCheck={false} />
              <span className="hint muted">
                {info.tags.includes(tag.trim())
                  ? "Esa versión ya existe: usa un número nuevo."
                  : info.tags.length
                    ? `Versiones anteriores: ${info.tags.slice(-3).join(", ")}`
                    : "Se creará la etiqueta y GitHub empezará a compilar."}
              </span>
            </label>
            <span className="muted small">
              {info.workflowExists ? "Se actualizará" : "Se agregará"} <code>{info.workflow}</code> al repositorio (solo ese archivo se confirma).
            </span>
          </>
        ) : null}

        {err && <pre className="hint err git-dialog-err">{err}</pre>}

        <div className="actions">
          {ready && (
            <button type="button" className="btn" disabled={!!busy} onClick={() => run(false)} title="Solo escribir el archivo del workflow, sin crear la versión">
              Solo agregar el workflow
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={!!busy}>Cancelar</button>
          <button type="button" className="btn primary" disabled={!ready || !tagOk || !!busy} onClick={() => run(true)}>
            {busy ? <><Codicon name="loading" spin /> {busy}</> : <><Codicon name="cloud-upload" /> Crear versión y publicar</>}
          </button>
        </div>
      </div>
    </div>
  );
}
