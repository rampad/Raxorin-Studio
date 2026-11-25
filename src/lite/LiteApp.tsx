// Raxorin Studio Lite: la versión de navegador. Editor (Monaco), diseñador visual de Slint con la
// vista previa real (Slint en WebAssembly), ejemplos, compilar y ejecutar en el Rust Playground, y
// descargar el proyecto para abrirlo en la app de escritorio. Los proyectos se guardan en el navegador.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as monaco from "monaco-editor";
import EditorArea, { type Tab } from "../components/EditorArea";
import { Codicon, FileIcon } from "../components/Icon";
import type { DesignerHost } from "../designer/SlintDesigner";
import { languageFor } from "../util";
import { lang, setLangPref, t } from "../i18n/index.ts";
import { toggleTheme, useTheme } from "../theme";
import plantillas from "./plantillas.json";
import { availableCrates, bundle, clippy, execute, format, manifestInfo, parseDiagnostics, readsStdin, remapText, withStdin, type Diagnostic } from "./playground";
import { downloadSample, loadSamples, type LiteSample } from "./samples";
import SlintPreview from "./SlintPreview";
import * as store from "./store";
import { deleteProject, getProject as loadProject, isImage, listProjects, newProjectId, saveProject, type LiteProject } from "./vfs";
import { fileBytes, makeZip } from "./zip";
import raxorinMark from "../assets/brand/raxorin-mark.svg";

type OutLine = { text: string; kind: "info" | "stdout" | "stderr" | "error" | "success" | "warning" };
const DESKTOP_URL = "https://raxorin.com/";
const LAST_KEY = "raxorinstudio.lite.last";

const useProject = () => useSyncExternalStore(store.subscribe, store.getProject, store.getProject);

const validName = (n: string) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(n);

/** Un proyecto nuevo con las mismas plantillas que la app de escritorio. */
function template(name: string, kind: "bin" | "slint"): Record<string, string> {
  const tpl = lang === "en" ? plantillas.en : plantillas.es;
  const pkg = name.replace(/-/g, "_");
  let toml = `[package]\nname = "${pkg}"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\n`;
  const files: Record<string, string> = { ".gitignore": "/target\n" };
  if (kind === "slint") {
    toml += `slint = "${plantillas.slintVersion}"\n\n[build-dependencies]\nslint-build = "${plantillas.slintVersion}"\n`;
    files["build.rs"] = plantillas.slintBuild;
    files["ui/app-window.slint"] = tpl.slintUi;
    files["src/main.rs"] = tpl.slintMain;
  } else {
    files["src/main.rs"] = tpl.console;
  }
  files["Cargo.toml"] = toml;
  return files;
}

function sortedPaths(files: Record<string, string>) {
  return Object.keys(files).sort((a, b) => {
    const da = a.split("/").length, db = b.split("/").length;
    const [pa, pb] = [a.split("/").slice(0, -1).join("/"), b.split("/").slice(0, -1).join("/")];
    return pa === pb ? a.localeCompare(b) : pa.localeCompare(pb) || da - db;
  });
}

function download(name: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function LiteApp() {
  const project = useProject();
  const [projects, setProjects] = useState<LiteProject[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [output, setOutput] = useState<OutLine[]>([]);
  const [diags, setDiags] = useState<Diagnostic[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<"debug" | "release">("debug");
  const [samplesOpen, setSamplesOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [stdinOpen, setStdinOpen] = useState(false);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const abort = useRef<AbortController | null>(null);
  const { theme } = useTheme();

  const log = useCallback((text: string, kind: OutLine["kind"] = "info") => setOutput((o) => [...o, { text, kind }]), []);
  const refreshProjects = useCallback(() => void listProjects().then(setProjects), []);

  // ---------- Abrir un proyecto: modelos de Monaco por archivo, sincronizados con el store ----------
  const open = useCallback(async (p: LiteProject) => {
    store.setProject(p);
    monaco.editor.getModels().forEach((m) => m.dispose());
    for (const [rel, content] of Object.entries(p.files)) {
      if (isImage(rel)) continue;
      const model = monaco.editor.createModel(content, languageFor(rel), monaco.Uri.file(store.absPath(rel)));
      model.onDidChangeContent(() => store.writeFile(rel, model.getValue()));
    }
    const first = p.sample ? undefined : "src/main.rs";
    const main = [first, "ui/app-window.slint", "src/main.rs", "src/lib.rs"].find((f) => f && f in p.files);
    const openRels = main ? [main] : [];
    setTabs(openRels.map((r) => ({ path: store.absPath(r), name: r.split("/").pop()!, content: p.files[r], saved: p.files[r] })));
    setActive(main ? store.absPath(main) : null);
    setPreviewPath(Object.keys(p.files).find((f) => f.endsWith(".slint")) ?? null);
    setOutput([]);
    setDiags([]);
    try {
      localStorage.setItem(LAST_KEY, p.id);
    } catch {
      /* sin almacenamiento */
    }
    refreshProjects();
  }, [refreshProjects]);

  // Al entrar: el último proyecto abierto.
  useEffect(() => {
    refreshProjects();
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_KEY);
    } catch {
      /* sin almacenamiento */
    }
    if (last) void loadProject(last).then((p) => p && open(p));
  }, [open, refreshProjects]);

  const openFile = useCallback((rel: string, line?: number) => {
    const p = store.getProject();
    if (!p || !(rel in p.files)) return;
    const abs = store.absPath(rel);
    if (isImage(rel)) return;
    setTabs((ts) => (ts.some((x) => x.path === abs) ? ts : [...ts, { path: abs, name: rel.split("/").pop()!, content: p.files[rel], saved: p.files[rel] }]));
    setActive(abs);
    if (rel.endsWith(".slint")) setPreviewPath(rel);
    if (line) {
      setTimeout(() => {
        const ed = editorRef.current;
        if (ed?.getModel()?.uri.path === monaco.Uri.file(abs).path) {
          ed.revealLineInCenter(line);
          ed.setPosition({ lineNumber: line, column: 1 });
          ed.focus();
        }
      }, 60);
    }
  }, []);

  const createProject = async (name: string, files: Record<string, string>, sample?: string) => {
    const existing = new Set(projects.map((p) => p.name));
    let unique = name;
    for (let n = 2; existing.has(unique); n++) unique = `${name}_${n}`;
    const p: LiteProject = { id: newProjectId(), name: unique, files, updated: Date.now(), sample };
    await saveProject(p);
    await open(p);
  };

  // ---------- Compilar y ejecutar en el Playground ----------
  const playgroundInput = async () => {
    const p = store.getProject();
    if (!p) return null;
    store.flush();
    const entry = "src/main.rs" in p.files ? "src/main.rs" : "src/lib.rs" in p.files ? "src/lib.rs" : null;
    if (!entry) {
      log(t("El proyecto no tiene src/main.rs ni src/lib.rs."), "error");
      return null;
    }
    const info = manifestInfo(p.files["Cargo.toml"] ?? "");
    const b = bundle(p.files, entry);
    return { p, entry, info, b, crateType: entry.endsWith("lib.rs") ? ("lib" as const) : ("bin" as const) };
  };

  const showDiagnostics = (stderr: string, b: ReturnType<typeof bundle>) => {
    const d = parseDiagnostics(stderr, b.map);
    setDiags(d);
    // Marcas en el editor.
    const byFile = new Map<string, monaco.editor.IMarkerData[]>();
    for (const x of d) {
      if (!x.file) continue;
      const list = byFile.get(x.file) ?? [];
      list.push({ severity: x.level === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning, message: x.message + (x.code ? ` [${x.code}]` : ""), startLineNumber: x.line, startColumn: x.column || 1, endLineNumber: x.line, endColumn: (x.column || 1) + 1 });
      byFile.set(x.file, list);
    }
    for (const model of monaco.editor.getModels()) {
      const rel = store.relPath(model.uri.path);
      monaco.editor.setModelMarkers(model, "playground", rel ? byFile.get(rel) ?? [] : []);
    }
    return d;
  };

  const run = async (kind: "run" | "test" | "check") => {
    const prepared = await playgroundInput();
    if (!prepared) return;
    const { info, b, crateType, entry } = prepared;
    setOutput([]);
    // Las ventanas de Slint no se ejecutan en el Playground: se ven en la vista previa.
    if (info.deps.includes("slint") && kind === "run") {
      const ui = previewPath ?? Object.keys(prepared.p.files).find((f) => f.endsWith(".slint"));
      if (ui) {
        setPreviewPath(ui);
        setPreviewOpen(true);
      }
      log(t("Esta es una aplicación con ventana (Slint): se muestra en la vista previa real de la derecha. La lógica de Rust (lo que hacen los botones) solo se ejecuta en la app de escritorio."), "info");
      return;
    }
    const available = await availableCrates();
    const missing = info.deps.filter((d) => available.size && !available.has(d.replace(/-/g, "_")));
    if (missing.length) log(t("El Playground no tiene estas dependencias: {0}. Solo ofrece las ~100 crates más usadas; para las demás, usa la app de escritorio.", missing.join(", ")), "warning");
    if (b.missing.length) log(t("No se encontraron estos módulos: {0}", b.missing.join(", ")), "warning");
    // Entrada del programa: la escrita en «Entrada» llega como stdin (el Playground no es interactivo).
    let code = b.code;
    let map = b.map;
    const stdin = prepared.p.stdin ?? "";
    // Las pruebas (cargo test) no leen la entrada: solo al ejecutar el programa.
    if (kind === "run" && crateType === "bin" && readsStdin(b.code)) {
      if (!stdin) {
        setStdinOpen(true);
        log(t("Este programa lee lo que escribe el usuario: escríbelo en «Entrada» (una línea por respuesta) y vuelve a ejecutar. Sin entrada, lo que lea llegará vacío."), "warning");
      } else {
        const w = withStdin(b, entry, stdin);
        if (typeof w === "string") log(w === "async" ? t("Con un main asíncrono (async fn main) no se puede dar la entrada en el navegador.") : t("No se encontró fn main en {0}.", entry), "warning");
        else {
          code = w.code;
          map = w.map;
        }
      }
    }
    log(kind === "check" ? t("Revisando con Clippy en el Rust Playground…") : kind === "test" ? t("Ejecutando las pruebas en el Rust Playground…") : t("Compilando y ejecutando en el Rust Playground ({0})…", mode === "release" ? "Release" : "Debug"), "info");
    setBusy(kind);
    abort.current = new AbortController();
    try {
      const r = kind === "check"
        ? await clippy({ code: b.code, edition: info.edition, crateType }, abort.current.signal)
        : await execute({ code, edition: info.edition, mode, crateType: kind === "test" ? "bin" : crateType, tests: kind === "test" || crateType === "lib" }, abort.current.signal);
      const d = showDiagnostics(r.stderr, kind === "check" ? b : { ...b, code, map });
      const stderr = remapText(r.stderr, kind === "check" ? b.map : map).replace(/^\s*Compiling playground .*\n/m, "").replace(/^\s*(Finished|Running) .*\n/gm, "");
      if (stderr.trim()) log(stderr.trimEnd(), r.success ? "stderr" : "error");
      if (r.stdout) log(r.stdout.trimEnd(), "stdout");
      const errors = d.filter((x) => x.level === "error").length, warnings = d.length - errors;
      if (r.success) log(kind === "check" ? t("✔ Sin errores ({0} advertencias).", warnings) : t("✔ Terminó correctamente."), "success");
      else log(errors ? t("✖ {0} error(es), {1} advertencia(s).", errors, warnings) : t("✖ El programa terminó con un error ({0}).", r.exitDetail ?? ""), "error");
    } catch (e) {
      if ((e as Error).name !== "AbortError") log(t("No se pudo usar el Rust Playground: {0}", String(e)), "error");
      else log(t("■ Detenido."), "warning");
    } finally {
      setBusy(null);
    }
  };

  const formatActive = async () => {
    const rel = active ? store.relPath(active) : null;
    if (!rel?.endsWith(".rs")) return;
    const model = monaco.editor.getModel(monaco.Uri.file(active!));
    if (!model) return;
    setBusy("format");
    try {
      const r = await format(model.getValue(), manifestInfo(store.readFile("Cargo.toml") ?? "").edition);
      if (r.success) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: r.code }], () => null);
      else log(r.stderr, "error");
    } catch (e) {
      log(t("No se pudo usar el Rust Playground: {0}", String(e)), "error");
    } finally {
      setBusy(null);
    }
  };

  const exportZip = () => {
    const p = store.getProject();
    if (!p) return;
    store.flush();
    const bytes = Object.fromEntries(Object.entries(p.files).map(([k, v]) => [k, fileBytes(v)]));
    download(`${p.name}.zip`, makeZip(p.name, bytes));
    log(t("Descargado {0}.zip. Descomprímelo y ábrelo en Raxorin Studio con Archivo → Abrir carpeta…", p.name), "success");
  };

  // ---------- Archivos ----------
  const newFile = () => {
    const name = prompt(t("Nombre del archivo nuevo (por ejemplo src/utilidades.rs o ui/ventana.slint):"));
    if (!name) return;
    const rel = name.replace(/^\/+/, "");
    if (store.readFile(rel) !== undefined) return openFile(rel);
    store.writeFile(rel, "");
    const model = monaco.editor.createModel("", languageFor(rel), monaco.Uri.file(store.absPath(rel)));
    model.onDidChangeContent(() => store.writeFile(rel, model.getValue()));
    openFile(rel);
  };

  const removeFile = (rel: string) => {
    if (!confirm(t("¿Eliminar {0}?", rel))) return;
    const abs = store.absPath(rel);
    monaco.editor.getModel(monaco.Uri.file(abs))?.dispose();
    store.deleteFile(rel);
    setTabs((ts) => ts.filter((x) => x.path !== abs));
    if (active === abs) setActive(null);
  };

  const closeTab = (path: string) => {
    setTabs((ts) => {
      const next = ts.filter((x) => x.path !== path);
      if (active === path) setActive(next[next.length - 1]?.path ?? null);
      return next;
    });
  };

  // ---------- Diseñador: eventos de Slint en main.rs ----------
  const designerHost = useMemo<DesignerHost>(() => {
    const mainModel = () => {
      openFile("src/main.rs");
      return monaco.editor.getModel(monaco.Uri.file(store.absPath("src/main.rs")));
    };
    const gotoHandler = (_slint: string, callback: string) => {
      const model = mainModel();
      if (!model) return;
      const i = model.getLinesContent().findIndex((l) => l.includes(`on_${callback}(`));
      if (i >= 0) openFile("src/main.rs", i + 1);
    };
    return {
      openRustFile: () => void mainModel(),
      gotoHandler,
      createHandler: (slint, callback, params, label) => {
        const model = mainModel();
        if (!model) return;
        const lines = model.getLinesContent();
        if (lines.some((l) => l.includes(`on_${callback}(`))) return gotoHandler(slint, callback);
        let runIdx = -1;
        lines.forEach((l, j) => {
          if (/^\s*ui\.run\(\)/.test(l)) runIdx = j;
        });
        if (runIdx < 0) return log(t("No encontré `ui.run()` en main.rs."), "warning");
        const ind = lines[runIdx].match(/^\s*/)![0];
        const args = params.map((x) => x.name).join(", ");
        const print = params.length ? `println!("${callback}: ${params.map(() => "{:?}").join(", ")}", ${args});` : `println!("${callback}");`;
        const snippet = [`${ind}// ${label}`, `${ind}ui.on_${callback}({`, `${ind}    let ui_handle = ui.as_weak();`, `${ind}    move |${args}| {`, `${ind}        let ui = ui_handle.unwrap();`, `${ind}        // ${t("Escribe aquí lo que debe pasar. Por ejemplo: ui.set_…(…);")}`, `${ind}        ${print}`, `${ind}        let _ = ui;`, `${ind}    }`, `${ind}});`, ""].join("\n");
        model.pushEditOperations([], [{ range: new monaco.Range(runIdx + 1, 1, runIdx + 1, 1), text: snippet + "\n" }], () => null);
        openFile("src/main.rs", runIdx + 6);
      },
    };
  }, [openFile, log]);

  const files = project?.files ?? {};
  const paths = sortedPaths(files);
  const activeRel = active ? store.relPath(active) : null;
  const hasSlint = paths.some((f) => f.endsWith(".slint"));

  return (
    <div className={"lite-app" + (theme === "light" ? " light" : "")}>
      <header className="toolbar lite-toolbar">
        <span className="brand">
          <img src={raxorinMark} height={18} alt="" />
          <span className="brand-name"><span className="brand-accent">Raxorin</span> Studio <span className="lite-badge">Lite</span></span>
        </span>
        <div className="split-btn">
          <button className="tb-btn" onClick={() => setNewOpen((o) => !o)} title={t("Proyecto nuevo")}>
            <Codicon name="new-file" /> <span>{t("Nuevo")}</span> <Codicon name="chevron-down" className="muted" />
          </button>
          {newOpen && (
            <div className="context-menu dropdown" onMouseLeave={() => setNewOpen(false)}>
              {(["bin", "slint"] as const).map((k) => (
                <button key={k} className="menu-item" onClick={() => {
                  setNewOpen(false);
                  const name = prompt(t("Nombre del proyecto (letras, números, _ o -):"), k === "slint" ? "mi_ventana" : "mi_programa");
                  if (!name) return;
                  if (!validName(name)) return alert(t("Nombre inválido: “{0}”", name));
                  void createProject(name, template(name, k));
                }}>
                  <span className="menu-label"><Codicon name={k === "slint" ? "window" : "terminal"} /> {k === "slint" ? t("Aplicación con ventana (Slint)") : t("Aplicación de consola")}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="tb-btn" onClick={() => setSamplesOpen(true)}><Codicon name="library" /> <span>{t("Ejemplos")}</span></button>
        <select className="tb-select lite-projects" value={project?.id ?? ""} onChange={(e) => void loadProject(e.target.value).then((p) => p && open(p))} title={t("Tus proyectos (guardados en este navegador)")}>
          {!project && <option value="">{t("Sin proyecto")}</option>}
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="tb-sep" />
        <select className="tb-select" value={mode} onChange={(e) => setMode(e.target.value as "debug" | "release")} title={t("Debug compila rápido; Release optimiza")}>
          <option value="debug">Debug</option>
          <option value="release">Release</option>
        </select>
        <button className="tb-btn run" disabled={!project || !!busy} onClick={() => void run("run")} title={t("Compilar y ejecutar en el Rust Playground")}>
          <Codicon name={busy === "run" ? "loading" : "play-circle"} spin={busy === "run"} /> <span>{t("Ejecutar")}</span>
        </button>
        <button className="tb-btn" disabled={!project || !!busy} onClick={() => void run("test")} title={t("Ejecutar las pruebas (cargo test)")}>
          <Codicon name="beaker" /> <span>{t("Probar")}</span>
        </button>
        <button className="tb-btn" disabled={!project || !!busy} onClick={() => void run("check")} title={t("Revisar el código con Clippy")}>
          <Codicon name="check-all" /> <span>{t("Revisar")}</span>
        </button>
        <button className="tb-btn" disabled={!activeRel?.endsWith(".rs") || !!busy} onClick={() => void formatActive()} title={t("Formatear el archivo con rustfmt")}>
          <Codicon name="wand" />
        </button>
        {busy && busy !== "format" && (
          <button className="tb-btn stop" onClick={() => abort.current?.abort()}><Codicon name="debug-stop" /> <span>{t("Detener")}</span></button>
        )}
        <span className="spacer" />
        <button className="tb-btn" disabled={!project} onClick={exportZip} title={t("Descargar el proyecto (.zip) para abrirlo en la app de escritorio")}>
          <Codicon name="desktop-download" /> <span>{t("Descargar .zip")}</span>
        </button>
        <a className="tb-btn" href={DESKTOP_URL} target="_blank" rel="noopener" title={t("Raxorin Studio para Windows, macOS y Linux: depurador, Git, terminal, chat con IA y cualquier crate")}>
          <Codicon name="device-desktop" /> <span>{t("App de escritorio")}</span>
        </a>
        <select className="tb-select" value={lang} onChange={(e) => setLangPref(e.target.value as "es" | "en")} title={t("Idioma")}>
          <option value="es">ES</option>
          <option value="en">EN</option>
        </select>
        <button className="tb-btn" onClick={toggleTheme} title={t("Tema claro u oscuro")}><Codicon name={theme === "dark" ? "lightbulb" : "color-mode"} /></button>
      </header>

      {!project ? (
        <div className="lite-welcome">
          <img src={raxorinMark} width={56} alt="" />
          <h1>Raxorin Studio <span className="lite-badge">Lite</span></h1>
          <p className="muted">{t("Rust en el navegador: escribe, compila y ejecuta (en el Rust Playground), y diseña ventanas con Slint con su vista previa real. Tus proyectos se guardan en este navegador.")}</p>
          <div className="lite-welcome-actions">
            <button className="btn primary" onClick={() => void createProject("mi_programa", template("mi_programa", "bin"))}><Codicon name="terminal" /> {t("Aplicación de consola")}</button>
            <button className="btn primary" onClick={() => void createProject("mi_ventana", template("mi_ventana", "slint"))}><Codicon name="window" /> {t("Aplicación con ventana (Slint)")}</button>
            <button className="btn" onClick={() => setSamplesOpen(true)}><Codicon name="library" /> {t("Ver ejemplos")}</button>
          </div>
          {projects.length > 0 && (
            <div className="lite-recent">
              <h3>{t("Tus proyectos")}</h3>
              {projects.map((p) => (
                <button key={p.id} className="lite-recent-item" onClick={() => void open(p)}>
                  <FileIcon name={p.name} project="bin" /> {p.name}
                  <span className="muted small">{new Date(p.updated).toLocaleString(lang)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="lite-main">
          <aside className="lite-files">
            <div className="lite-files-head">
              <span>{project.name}</span>
              <button className="icon-btn" title={t("Archivo nuevo")} onClick={newFile}><Codicon name="new-file" /></button>
              <button className="icon-btn" title={t("Eliminar el proyecto de este navegador")} onClick={() => {
                if (!confirm(t("¿Eliminar el proyecto {0} de este navegador? Descárgalo antes si quieres conservarlo.", project.name))) return;
                void deleteProject(project.id).then(() => {
                  store.setProject(null);
                  setTabs([]);
                  setActive(null);
                  refreshProjects();
                });
              }}><Codicon name="trash" /></button>
            </div>
            {paths.map((rel) => {
              const depth = rel.split("/").length - 1;
              return (
                <div key={rel} className={"lite-file" + (rel === activeRel ? " active" : "")} style={{ paddingLeft: 10 + depth * 12 }} onClick={() => openFile(rel)} title={rel}>
                  <FileIcon name={rel.split("/").pop()!} />
                  <span className="lite-file-name">{depth ? <span className="muted">{rel.split("/").slice(0, -1).join("/")}/</span> : null}{rel.split("/").pop()}</span>
                  <button className="icon-btn lite-file-del" title={t("Eliminar")} onClick={(e) => { e.stopPropagation(); removeFile(rel); }}><Codicon name="close" /></button>
                </div>
              );
            })}
          </aside>
          <div className="lite-center">
            <div className="lite-editor">
              <EditorArea
                tabs={tabs}
                active={active}
                onSelect={setActive}
                onClose={closeTab}
                onReorder={(from, to) => setTabs((ts) => { const n = [...ts]; const [m] = n.splice(from, 1); n.splice(to, 0, m); return n; })}
                onNewFile={newFile}
                onMount={(ed) => { editorRef.current = ed; }}
                designer={designerHost}
              />
            </div>
            <div className="lite-output">
              <div className="lite-output-head">
                <Codicon name="output" /> {t("Salida")}
                {diags.length > 0 && <span className="muted small">{t("{0} error(es), {1} advertencia(s)", diags.filter((d) => d.level === "error").length, diags.filter((d) => d.level === "warning").length)}</span>}
                <span className="spacer" />
                <button className={"link-btn small" + (stdinOpen ? " active" : "")} onClick={() => setStdinOpen((o) => !o)} title={t("Lo que el programa leerá del teclado (stdin)")}>
                  <Codicon name="keyboard" /> {t("Entrada")}{project.stdin ? ` (${project.stdin.split("\n").filter(Boolean).length})` : ""}
                </button>
                <span className="muted small">{t("Se compila en play.rust-lang.org")}</span>
                <button className="icon-btn" title={t("Limpiar")} onClick={() => { setOutput([]); setDiags([]); }}><Codicon name="clear-all" /></button>
              </div>
              {stdinOpen && (
                <div className="lite-stdin">
                  <textarea
                    value={project.stdin ?? ""}
                    onChange={(e) => store.setStdin(e.target.value)}
                    placeholder={t("Escribe lo que el programa leerá, una línea por cada vez que pide algo. Por ejemplo:\nAna\n25")}
                    spellCheck={false}
                  />
                  <span className="muted small">{t("El Playground no es interactivo: la entrada se escribe antes de ejecutar y el programa la lee línea por línea.")}</span>
                </div>
              )}
              <div className="lite-output-body">
                {diags.map((d, i) => (
                  <button key={`d${i}`} className={`lite-diag ${d.level}`} onClick={() => d.file && openFile(d.file, d.line)}>
                    <Codicon name={d.level === "error" ? "error" : "warning"} />
                    <span>{d.code ? `[${d.code}] ` : ""}{d.message}</span>
                    {d.file && <span className="muted">{d.file}:{d.line}</span>}
                  </button>
                ))}
                {output.map((o, i) => <pre key={i} className={`lite-out ${o.kind}`}>{o.text}</pre>)}
                {!output.length && !diags.length && <div className="muted small">{t("Pulsa Ejecutar para compilar y ejecutar el programa.")}</div>}
              </div>
            </div>
          </div>
          {hasSlint && (
            previewOpen && previewPath ? (
              <aside className="lite-side">
                <div className="lite-side-head">
                  <select className="tb-select" value={previewPath} onChange={(e) => setPreviewPath(e.target.value)}>
                    {paths.filter((f) => f.endsWith(".slint")).map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <span className="spacer" />
                  <button className="icon-btn" title={t("Ocultar la vista previa")} onClick={() => setPreviewOpen(false)}><Codicon name="close" /></button>
                </div>
                <SlintPreview files={files} path={previewPath} onGoto={(f, line) => openFile(f, line)} />
              </aside>
            ) : (
              <button className="lite-side-show" onClick={() => setPreviewOpen(true)} title={t("Mostrar la vista previa real")}><Codicon name="eye" /></button>
            )
          )}
        </div>
      )}

      {samplesOpen && (
        <SamplesPicker
          onClose={() => setSamplesOpen(false)}
          onPick={async (s) => {
            const files = await downloadSample(s);
            setSamplesOpen(false);
            await createProject(s.id, files, s.id);
            const p = store.getProject();
            if (p && s.open in p.files) openFile(s.open);
          }}
        />
      )}
    </div>
  );
}

function SamplesPicker({ onClose, onPick }: { onClose: () => void; onPick: (s: LiteSample) => Promise<void> }) {
  const [samples, setSamples] = useState<LiteSample[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    loadSamples().then(setSamples).catch((e) => setError(String(e)));
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal lite-samples" onMouseDown={(e) => e.stopPropagation()}>
        <h2><Codicon name="library" /> {t("Ejemplos")}</h2>
        <p className="muted small">{t("Ábrelos, ejecútalos y modifícalos. Las ventanas de Slint se ven en la vista previa real; su lógica de Rust se ejecuta en la app de escritorio.")}</p>
        {error && <pre className="hint err">{error}</pre>}
        {!samples && !error && <p className="muted"><Codicon name="loading" spin /> {t("Cargando…")}</p>}
        <div className="lite-samples-grid">
          {samples?.filter((s) => s.kind !== "solucion").map((s) => (
            <button key={s.id} className="lite-sample" disabled={!!busy} onClick={async () => {
              setBusy(s.id);
              try {
                await onPick(s);
              } catch (e) {
                setError(String(e));
              }
              setBusy(null);
            }}>
              <div className="lite-sample-head">
                <Codicon name={busy === s.id ? "loading" : s.icon} spin={busy === s.id} />
                <strong>{s.name}</strong>
                <span className="lite-tag">{s.level}</span>
              </div>
              <span className="muted small">{s.description}</span>
              <span className="lite-sample-cat small">{s.category}</span>
            </button>
          ))}
        </div>
        <div className="actions"><button className="btn" onClick={onClose}>{t("Cerrar")}</button></div>
      </div>
    </div>
  );
}
