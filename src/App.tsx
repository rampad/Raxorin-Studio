import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { ask, open } from "@tauri-apps/plugin-dialog";
import type * as Monaco from "monaco-editor";
import type { OnMount } from "@monaco-editor/react";
import { api, type Diagnostic, type OutputChunk, type Task, type TaskFinished } from "./api";
import Toolbar from "./components/Toolbar";
import Explorer from "./components/Explorer";
import EditorArea, { type Tab } from "./components/EditorArea";
import BottomPanel, { type BottomTab } from "./components/BottomPanel";
import NewProjectDialog from "./components/NewProjectDialog";
import { basename } from "./util";

const LAST_PROJECT_KEY = "ruststudio.lastProject";
const MAX_CHUNKS = 5000;

const TASK_LABEL: Record<Task, string> = {
  build: "Compilando…",
  check: "Revisando…",
  test: "Ejecutando pruebas…",
  run: "Ejecutando…",
};

export default function App() {
  const [project, setProject] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputChunk[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [running, setRunning] = useState<Task | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>("output");
  const [showNew, setShowNew] = useState(false);
  const [cargoVersion, setCargoVersion] = useState("");
  const [treeKey, setTreeKey] = useState(0);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [reveal, setReveal] = useState<{ path: string; line: number; column: number } | null>(null);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const diagRef = useRef(diagnostics);
  diagRef.current = diagnostics;

  const append = useCallback((chunk: OutputChunk) => {
    setOutput((o) => {
      const next = [...o, chunk];
      return next.length > MAX_CHUNKS ? next.slice(-MAX_CHUNKS) : next;
    });
  }, []);
  const log = useCallback(
    (text: string, kind: OutputChunk["kind"] = "info") => append({ text: text + "\n", kind }),
    [append],
  );

  // ---------- Eventos del backend ----------
  useEffect(() => {
    const unlisteners = [
      listen<OutputChunk>("output", (e) => append(e.payload)),
      listen<Diagnostic>("diagnostic", (e) => setDiagnostics((d) => [...d, e.payload])),
      listen<TaskFinished>("task-finished", (e) => {
        setRunning(null);
        // Igual que Visual Studio: si la compilación falla, mostrar la lista de errores.
        if (!e.payload.success && diagRef.current.some((d) => d.level.startsWith("error"))) {
          setBottomTab("errors");
        }
      }),
    ];
    return () => unlisteners.forEach((p) => p.then((f) => f()));
  }, [append]);

  // ---------- Archivos ----------
  const openFile = useCallback(
    async (path: string) => {
      if (!tabsRef.current.some((t) => t.path === path)) {
        try {
          const content = await api.readFile(path);
          setTabs((ts) =>
            ts.some((t) => t.path === path)
              ? ts
              : [...ts, { path, name: basename(path), content, saved: content }],
          );
        } catch (err) {
          log(String(err), "error");
          return;
        }
      }
      setActive(path);
    },
    [log],
  );

  const openProject = useCallback(
    async (path: string) => {
      const entries = await api.listDir(path);
      setProject(path);
      setTabs([]);
      setActive(null);
      setDiagnostics([]);
      setTreeKey((k) => k + 1);
      try {
        localStorage.setItem(LAST_PROJECT_KEY, path);
      } catch {
        /* almacenamiento no disponible */
      }
      log(`Proyecto abierto: ${path}`);
      if (!entries.some((e) => e.name === "Cargo.toml")) {
        log("Aviso: esta carpeta no tiene Cargo.toml; no se podrá compilar.", "warning");
      }
      const src = await api.listDir(await join(path, "src")).catch(() => []);
      const main = src.find((e) => e.name === "main.rs") ?? src.find((e) => e.name === "lib.rs");
      if (main) await openFile(main.path);
    },
    [log, openFile],
  );

  const saveTab = useCallback(
    async (tab: Tab) => {
      try {
        await api.writeFile(tab.path, tab.content);
        setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, saved: tab.content } : t)));
      } catch (err) {
        log(String(err), "error");
        throw err;
      }
    },
    [log],
  );

  const saveAll = useCallback(async () => {
    for (const t of tabsRef.current) if (t.content !== t.saved) await saveTab(t);
  }, [saveTab]);

  const saveActive = useCallback(async () => {
    const t = tabsRef.current.find((x) => x.path === active);
    if (t && t.content !== t.saved) await saveTab(t).catch(() => {});
  }, [active, saveTab]);

  const closeTab = useCallback(
    async (path: string) => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab) return;
      if (tab.content !== tab.saved) {
        const discard = await ask(`“${tab.name}” tiene cambios sin guardar. ¿Cerrar de todos modos?`, {
          title: "Cambios sin guardar",
          kind: "warning",
          okLabel: "Cerrar sin guardar",
          cancelLabel: "Cancelar",
        });
        if (!discard) return;
      }
      const remaining = tabsRef.current.filter((t) => t.path !== path);
      setTabs(remaining);
      setActive((a) => (a === path ? remaining[remaining.length - 1]?.path ?? null : a));
      // Liberar el modelo de Monaco una vez que el editor cambió de archivo.
      setTimeout(() => {
        const m = monacoRef.current;
        m?.editor.getModel(m.Uri.parse(path))?.dispose();
      }, 0);
    },
    [],
  );

  // ---------- Proyecto ----------
  const openFolder = useCallback(async () => {
    const dir = await open({ directory: true, title: "Abrir proyecto de Rust" });
    if (typeof dir === "string") await openProject(dir).catch((e) => log(String(e), "error"));
  }, [openProject, log]);

  const createProject = useCallback(
    async (parent: string, name: string, kind: "bin" | "lib") => {
      const path = await api.createProject(parent, name, kind);
      setShowNew(false);
      log(`Proyecto creado: ${path}`, "success");
      await openProject(path);
    },
    [openProject, log],
  );

  // ---------- Compilar / ejecutar ----------
  const runTask = useCallback(
    async (task: Task) => {
      if (!project) {
        log("Abre o crea un proyecto primero.", "warning");
        return;
      }
      if (running) return;
      try {
        await saveAll(); // como VS: guardar todo antes de compilar
      } catch {
        return;
      }
      setOutput([]);
      setDiagnostics([]);
      setBottomTab("output");
      setRunning(task);
      try {
        await api.startTask(project, task);
      } catch (err) {
        setRunning(null);
        log(String(err), "error");
      }
    },
    [project, running, saveAll, log],
  );

  const stop = useCallback(() => {
    api.stopTask().catch((e) => log(String(e), "error"));
  }, [log]);

  const sendStdin = useCallback(
    (text: string) => {
      append({ text: text + "\n", kind: "input" });
      api.sendStdin(text).catch((e) => log(String(e), "error"));
    },
    [append, log],
  );

  // ---------- Atajos de teclado ----------
  const actions = useRef({ runTask, saveActive, stop });
  actions.current = { runTask, saveActive, stop };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      let handled = true;
      if (e.key === "F5" && e.shiftKey) actions.current.stop();
      else if (e.key === "F5") actions.current.runTask("run");
      else if (mod && e.shiftKey && key === "b") actions.current.runTask("build");
      else if (mod && !e.shiftKey && key === "s") actions.current.saveActive();
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ---------- Inicio ----------
  useEffect(() => {
    api
      .toolchainInfo()
      .then(setCargoVersion)
      .catch((e) => {
        setCargoVersion("cargo no encontrado");
        log(String(e), "error");
      });
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      /* sin almacenamiento */
    }
    if (last) openProject(last).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Integración con Monaco ----------
  const onEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.onDidChangeCursorPosition((e) =>
      setCursor({ line: e.position.lineNumber, column: e.position.column }),
    );
    applyMarkers();
  };

  // Subrayados rojos/amarillos en el editor a partir de los diagnósticos.
  const applyMarkers = useCallback(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    for (const model of monaco.editor.getModels()) {
      const uri = model.uri.toString();
      const markers = diagnostics
        .filter((d) => d.file && monaco.Uri.parse(d.file).toString() === uri)
        .map((d) => ({
          severity: d.level.startsWith("error")
            ? monaco.MarkerSeverity.Error
            : d.level === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
          message: d.code ? `${d.message} [${d.code}]` : d.message,
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.endLine,
          endColumn: d.endColumn,
          source: "cargo",
        }));
      monaco.editor.setModelMarkers(model, "cargo", markers);
    }
  }, [diagnostics]);

  useEffect(() => {
    // Esperar un tick a que Monaco cree el modelo del archivo activo.
    const t = setTimeout(applyMarkers, 0);
    return () => clearTimeout(t);
  }, [applyMarkers, active, tabs.length]);

  // Saltar a la línea de un error.
  useEffect(() => {
    if (!reveal || reveal.path !== active) return;
    const t = setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.revealLineInCenter(reveal.line);
      ed.setPosition({ lineNumber: reveal.line, column: reveal.column });
      ed.focus();
      setReveal(null);
    }, 30);
    return () => clearTimeout(t);
  }, [reveal, active]);

  const gotoDiagnostic = useCallback(
    async (d: Diagnostic) => {
      if (!d.file) return;
      await openFile(d.file);
      setReveal({ path: d.file, line: d.line, column: d.column });
    },
    [openFile],
  );

  // ---------- Interfaz ----------
  const activeTab = tabs.find((t) => t.path === active);

  return (
    <div className="app">
      <Toolbar
        hasProject={!!project}
        running={running}
        canSave={!!activeTab && activeTab.content !== activeTab.saved}
        onNew={() => setShowNew(true)}
        onOpen={openFolder}
        onSave={saveActive}
        onTask={runTask}
        onStop={stop}
      />
      <div className="main">
        <aside className="sidebar">
          <Explorer
            key={treeKey}
            root={project}
            activePath={active}
            onOpenFile={openFile}
            onRefresh={() => setTreeKey((k) => k + 1)}
          />
        </aside>
        <div className="center">
          {project ? (
            <EditorArea
              tabs={tabs}
              active={active}
              onSelect={setActive}
              onClose={closeTab}
              onChange={(path, value) =>
                setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, content: value } : t)))
              }
              onMount={onEditorMount}
            />
          ) : (
            <Welcome onNew={() => setShowNew(true)} onOpen={openFolder} />
          )}
          <BottomPanel
            tab={bottomTab}
            setTab={setBottomTab}
            output={output}
            diagnostics={diagnostics}
            running={running}
            project={project}
            onClear={() => setOutput([])}
            onStdin={sendStdin}
            onGoto={gotoDiagnostic}
          />
        </div>
      </div>
      <footer className={"statusbar" + (running ? " running" : "")}>
        <span>{running ? `⏳ ${TASK_LABEL[running]}` : "✓ Listo"}</span>
        <span className="status-path">{project ?? "Sin proyecto"}</span>
        <span className="spacer" />
        {activeTab && <span>Ln {cursor.line}, Col {cursor.column}</span>}
        <span>{cargoVersion}</span>
      </footer>
      {showNew && <NewProjectDialog onCancel={() => setShowNew(false)} onCreate={createProject} />}
    </div>
  );
}

function Welcome({ onNew, onOpen }: { onNew: () => void; onOpen: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-logo">🦀</div>
      <h1>Rust Studio</h1>
      <p className="muted">Crea programas en Rust de forma fácil.</p>
      <div className="welcome-actions">
        <button className="welcome-card" onClick={onNew}>
          <span>📄</span>
          <strong>Nuevo proyecto</strong>
          <small>Consola o biblioteca</small>
        </button>
        <button className="welcome-card" onClick={onOpen}>
          <span>📂</span>
          <strong>Abrir proyecto</strong>
          <small>Una carpeta con Cargo.toml</small>
        </button>
      </div>
      <div className="shortcuts muted">
        <div><kbd>F5</kbd> Ejecutar</div>
        <div><kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> Compilar</div>
        <div><kbd>Ctrl/⌘</kbd>+<kbd>S</kbd> Guardar</div>
        <div><kbd>Shift</kbd>+<kbd>F5</kbd> Detener</div>
      </div>
    </div>
  );
}
