import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { ask, open } from "@tauri-apps/plugin-dialog";
import * as monaco from "monaco-editor";
import type { OnMount } from "@monaco-editor/react";
import {
  api,
  type Diagnostic,
  type OutputChunk,
  type ProjectInfo,
  type Task,
  type TaskFinished,
  type ToolchainStatus,
} from "./api";
import Toolbar from "./components/Toolbar";
import Explorer, { type FileProblems } from "./components/Explorer";
import EditorArea, { type Tab } from "./components/EditorArea";
import BottomPanel, { type BottomTab } from "./components/BottomPanel";
import NewProjectDialog from "./components/NewProjectDialog";
import PackagesDialog from "./components/packages/PackagesDialog";
import ReferenceDialog from "./components/ReferenceDialog";
import ToolchainBanner from "./components/ToolchainBanner";
import { LspClient } from "./lsp/client";
import { registerRustProviders } from "./lsp/providers";
import type { DesignerHost } from "./designer/SlintDesigner";
import type { EventParam } from "./designer/widgets";
import type * as L from "./lsp/types";
import { basename, dirname, isInside, languageFor } from "./util";
import { Codicon } from "./components/Icon";
import oxideMark from "./assets/brand/oxide-mark.svg";

const LAST_PROJECT_KEY = "oxidestudio.lastProject";
const RUN_EXTERNAL_KEY = "oxidestudio.runExternal";
const startupKey = (root: string) => `oxidestudio.startup:${root}`;
const MAX_CHUNKS = 5000;

const TASK_LABEL: Record<Task, string> = {
  build: "Compilando…",
  check: "Revisando…",
  test: "Ejecutando pruebas…",
  run: "Ejecutando…",
};

const uriOf = (path: string) => monaco.Uri.file(path).toString();

/** Diagnóstico LSP → formato de la lista de errores. */
function fromLsp(uri: string, d: L.Diagnostic): Diagnostic {
  return {
    level: ["error", "warning", "info", "hint"][(d.severity ?? 1) - 1] ?? "error",
    message: d.message,
    code: d.code === undefined ? null : String(d.code),
    file: monaco.Uri.parse(uri).fsPath,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    endLine: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  };
}

export default function App() {
  const [project, setProject] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputChunk[]>([]);
  const [buildDiagnostics, setBuildDiagnostics] = useState<Diagnostic[]>([]);
  const [lspDiagnostics, setLspDiagnostics] = useState<Record<string, Diagnostic[]>>({});
  const [running, setRunning] = useState<Task | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>("output");
  const [showNew, setShowNew] = useState(false);
  const [packagesFor, setPackagesFor] = useState<string | null>(null);
  const [referenceFor, setReferenceFor] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [startupDir, setStartupDir] = useState<string | null>(null);
  const [toolchain, setToolchain] = useState<ToolchainStatus | null>(null);
  const [lspStatus, setLspStatus] = useState("");
  const [lspReady, setLspReady] = useState(false);
  const [lspGeneration, setLspGeneration] = useState(0);
  const [runExternal, setRunExternal] = useState(() => {
    try {
      return localStorage.getItem(RUN_EXTERNAL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [reveal, setReveal] = useState<{ path: string; line: number; column: number } | null>(null);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const lspRef = useRef<LspClient | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const projectRef = useRef(project);
  projectRef.current = project;
  const startupRef = useRef(startupDir);
  startupRef.current = startupDir;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  // La lista de errores combina el análisis en vivo (rust-analyzer) con la última compilación.
  const diagnostics = useMemo(() => {
    const live = Object.values(lspDiagnostics)
      .flat()
      .filter((d) => d.level === "error" || d.level === "warning");
    const seen = new Set(live.map((d) => `${d.file}:${d.line}:${d.column}:${d.message}`));
    const fromBuild = buildDiagnostics.filter((d) => !seen.has(`${d.file}:${d.line}:${d.column}:${d.message}`));
    return [...live, ...fromBuild];
  }, [lspDiagnostics, buildDiagnostics]);
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

  // ---------- Eventos del backend (compilación) ----------
  useEffect(() => {
    const unlisteners = [
      listen<OutputChunk>("output", (e) => append(e.payload)),
      listen<Diagnostic>("diagnostic", (e) => setBuildDiagnostics((d) => [...d, e.payload])),
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

  // ---------- Pestañas ↔ modelos de Monaco ----------
  // Cualquier cambio en un modelo (tecleo, renombrar, acciones rápidas) actualiza su pestaña.
  useEffect(() => {
    const subs = new Map<string, monaco.IDisposable>();
    const track = (model: monaco.editor.ITextModel) => {
      if (model.uri.scheme !== "file") return;
      const key = model.uri.toString();
      subs.get(key)?.dispose();
      subs.set(
        key,
        model.onDidChangeContent(() => {
          const value = model.getValue();
          setTabs((ts) => ts.map((t) => (uriOf(t.path) === key && t.content !== value ? { ...t, content: value } : t)));
        }),
      );
    };
    monaco.editor.getModels().forEach(track);
    const created = monaco.editor.onDidCreateModel(track);
    const disposed = monaco.editor.onWillDisposeModel((m) => {
      subs.get(m.uri.toString())?.dispose();
      subs.delete(m.uri.toString());
    });
    return () => {
      created.dispose();
      disposed.dispose();
      subs.forEach((s) => s.dispose());
    };
  }, []);

  // ---------- Archivos ----------
  const openFile = useCallback(
    async (path: string, activate = true) => {
      if (!tabsRef.current.some((t) => t.path === path)) {
        try {
          const saved = await api.readFile(path);
          // Si ya existe un modelo (p. ej. con ediciones de un renombrado), su texto manda.
          const content = monaco.editor.getModel(monaco.Uri.file(path))?.getValue() ?? saved;
          const tab = { path, name: basename(path), content, saved };
          tabsRef.current = [...tabsRef.current.filter((t) => t.path !== path), tab];
          setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, tab]));
          if (!monaco.editor.getModel(monaco.Uri.file(path))) {
            monaco.editor.createModel(content, languageFor(path), monaco.Uri.file(path));
          }
        } catch (err) {
          log(String(err), "error");
          return;
        }
      }
      if (activate) setActive(path);
    },
    [log],
  );

  /** Abre src/main.rs (o src/lib.rs) de un proyecto. */
  const openMainFile = useCallback(
    async (dir: string) => {
      const src = await api.listDir(await join(dir, "src")).catch(() => []);
      const main = src.find((e) => e.name === "main.rs") ?? src.find((e) => e.name === "lib.rs");
      if (main) await openFile(main.path);
    },
    [openFile],
  );

  /** Vuelve a buscar los proyectos de la carpeta y elige el de inicio. */
  const refreshProjects = useCallback(async (root: string, prefer?: string) => {
    let list: ProjectInfo[] = [];
    try {
      list = await api.findProjects(root);
    } catch (e) {
      log(String(e), "error");
    }
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(startupKey(root));
    } catch {
      /* sin almacenamiento */
    }
    const byDir = (d?: string | null) => list.find((p) => p.dir === d);
    const startup =
      byDir(prefer) ?? byDir(saved) ?? list.find((p) => p.kind === "bin") ?? list[0] ?? null;
    setProjects(list);
    setStartupDir(startup?.dir ?? null);
    return { list, startup };
  }, [log]);

  const setStartup = useCallback(
    (dir: string) => {
      setStartupDir(dir);
      if (project) {
        try {
          localStorage.setItem(startupKey(project), dir);
        } catch {
          /* sin almacenamiento */
        }
      }
      const p = projects.find((x) => x.dir === dir);
      if (p) log(`Proyecto de inicio: ${p.name}`);
    },
    [project, projects, log],
  );

  const startupProject = projects.find((p) => p.dir === startupDir) ?? null;

  const openProject = useCallback(
    async (path: string) => {
      const entries = await api.listDir(path);
      for (const t of tabsRef.current) monaco.editor.getModel(monaco.Uri.file(t.path))?.dispose();
      tabsRef.current = [];
      setProject(path);
      setTabs([]);
      setActive(null);
      setBuildDiagnostics([]);
      setLspDiagnostics({});
      try {
        localStorage.setItem(LAST_PROJECT_KEY, path);
      } catch {
        /* almacenamiento no disponible */
      }
      void entries;
      log(`Carpeta abierta: ${path}`);
      const found = await refreshProjects(path);
      if (found.list.length === 0) {
        log("No se encontraron proyectos de Rust en esta carpeta. Crea uno con “Nuevo”.", "warning");
      } else if (found.list.length > 1) {
        log(`Se encontraron ${found.list.length} proyectos. Proyecto de inicio: ${found.startup?.name ?? "ninguno"}`);
      }
      if (found.startup) await openMainFile(found.startup.dir);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log, openFile],
  );

  const saveTab = useCallback(
    async (tab: Tab) => {
      try {
        await api.writeFile(tab.path, tab.content);
        setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, saved: tab.content } : t)));
        lspRef.current?.didSave(tab.path); // dispara Clippy en segundo plano
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

  const closeTab = useCallback(async (path: string) => {
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
    tabsRef.current = remaining;
    setTabs(remaining);
    setActive((a) => (a === path ? remaining[remaining.length - 1]?.path ?? null : a));
    // Liberar el modelo una vez que el editor cambió de archivo.
    setTimeout(() => monaco.editor.getModel(monaco.Uri.file(path))?.dispose(), 0);
  }, []);

  // ---------- Integración Monaco ↔ rust-analyzer ----------
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  useEffect(() => {
    registerRustProviders({
      getClient: () => lspRef.current,
      ensureOpen: (path) => openFileRef.current(path, false),
      ensureModel: async (uri) => {
        if (monaco.editor.getModel(uri)) return;
        try {
          const text = await api.readFile(uri.fsPath);
          if (!monaco.editor.getModel(uri)) monaco.editor.createModel(text, languageFor(uri.fsPath), uri);
        } catch {
          /* archivo no legible: Monaco simplemente no mostrará la vista previa */
        }
      },
    });
    // "Ir a definición" en otro archivo: abrirlo en una pestaña y saltar a la línea.
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selection) {
        if (resource.scheme !== "file") return false;
        const path = resource.fsPath;
        const pos = !selection
          ? { line: 1, column: 1 }
          : "startLineNumber" in selection
            ? { line: selection.startLineNumber, column: selection.startColumn }
            : { line: selection.lineNumber, column: selection.column };
        openFileRef.current(path).then(() => setReveal({ path, ...pos }));
        return true;
      },
    });
    return () => opener.dispose();
  }, []);

  // Un Cargo.toml por proyecto suelto o por workspace: rust-analyzer analiza todos.
  const linkedProjects = useMemo(
    () => [...new Set(projects.map((p) => p.workspaceManifest))].sort(),
    [projects],
  );
  const linkedKey = linkedProjects.join("|");

  // Iniciar rust-analyzer al abrir un proyecto (o al terminar de instalarlo).
  useEffect(() => {
    if (!project || !toolchain) return;
    if (linkedProjects.length === 0) {
      setLspStatus("");
      return;
    }
    if (!toolchain.rustAnalyzer) {
      setLspStatus("Sin autocompletado (falta rust-analyzer)");
      return;
    }
    let cancelled = false;
    let client: LspClient | null = null;
    setLspReady(false);
    setLspStatus("rust-analyzer: iniciando…");
    LspClient.start({ root: project, clippy: toolchain.clippy, linkedProjects })
      .then((c) => {
        client = c;
        if (cancelled) {
          c.dispose();
          return;
        }
        lspRef.current = c;
        setLspReady(true);
        setLspStatus(c.statusText() ? `rust-analyzer: ${c.statusText()}` : "rust-analyzer ✓");
        c.on("$/statusText", (text: string) => setLspStatus(text ? `rust-analyzer: ${text}` : "rust-analyzer ✓"));
        c.on("$/exit", () => {
          if (lspRef.current === c) {
            setLspReady(false);
            setLspStatus("rust-analyzer se detuvo (clic para reiniciar)");
          }
        });
        c.on("textDocument/publishDiagnostics", (p: L.PublishDiagnosticsParams) => {
          const key = monaco.Uri.parse(p.uri).toString();
          setLspDiagnostics((m) => ({ ...m, [key]: p.diagnostics.map((d) => fromLsp(p.uri, d)) }));
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setLspStatus("rust-analyzer: error");
        log(`No se pudo iniciar rust-analyzer: ${e}`, "error");
      });
    return () => {
      cancelled = true;
      if (lspRef.current === client) lspRef.current = null;
      client?.dispose();
      setLspReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, toolchain, lspGeneration, log, linkedKey]);

  // Subrayados de la última compilación (solo si rust-analyzer no está activo, para no duplicar).
  useEffect(() => {
    const t = setTimeout(() => {
      for (const model of monaco.editor.getModels()) {
        const uri = model.uri.toString();
        const markers = lspReady
          ? []
          : buildDiagnostics
              .filter((d) => d.file && uriOf(d.file) === uri)
              .map((d) => ({
                severity: d.level.startsWith("error") ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                message: d.code ? `${d.message} [${d.code}]` : d.message,
                startLineNumber: d.line,
                startColumn: d.column,
                endLineNumber: d.endLine,
                endColumn: d.endColumn,
                source: "cargo",
              }));
        monaco.editor.setModelMarkers(model, "cargo", markers);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [buildDiagnostics, lspReady, active, tabs.length]);

  // ---------- Proyecto ----------
  const openFolder = useCallback(async () => {
    const dir = await open({ directory: true, title: "Abrir proyecto de Rust" });
    if (typeof dir === "string") await openProject(dir).catch((e) => log(String(e), "error"));
  }, [openProject, log]);

  const createProject = useCallback(
    async (parent: string, name: string, kind: "bin" | "lib" | "slint", addToCurrent: boolean) => {
      const path = await api.createProject(parent, name, kind);
      const openDesigner = async () => {
        if (kind !== "slint") return;
        await openFile(await join(path, "ui", "app-window.slint"));
        log("Ventana creada: diseña en app-window.slint y escribe el código en main.rs. La primera compilación de Slint tarda un poco.", "muted");
      };
      setShowNew(false);
      if (addToCurrent && project && isInside(path, project)) {
        log(`Proyecto agregado a la carpeta: ${name} (${{ bin: "aplicación de consola", lib: "biblioteca", slint: "aplicación de ventana" }[kind]})`, "success");
        // Si aún no hay un ejecutable de inicio, el nuevo pasa a serlo.
        const prefer = kind !== "lib" && startupProject?.kind !== "bin" ? path : startupDir ?? undefined;
        await refreshProjects(project, kind === "slint" && startupProject?.kind !== "bin" ? path : prefer);
        await openMainFile(path);
        await openDesigner();
        if (kind === "lib") {
          log("Consejo: clic derecho sobre un proyecto → “Agregar referencia a proyecto…” para usar esta biblioteca.", "muted");
        }
      } else {
        log(`Proyecto creado: ${path}`, "success");
        await openProject(path);
        await openDesigner();
      }
    },
    [project, startupProject, startupDir, refreshProjects, openMainFile, openProject, openFile, log],
  );

  const refreshToolchain = useCallback(async () => {
    try {
      setToolchain(await api.toolchainStatus());
    } catch (e) {
      log(String(e), "error");
    }
  }, [log]);

  const installComponents = useCallback(
    async (names: string[]) => {
      log(`> rustup component add ${names.join(" ")}`);
      try {
        const out = await api.installComponents(names);
        if (out.trim()) log(out.trim(), "muted");
        log("✔ Herramientas instaladas", "success");
      } catch (e) {
        log(String(e), "error");
      }
      await refreshToolchain();
    },
    [log, refreshToolchain],
  );

  /** Tras agregar/quitar un crate: recargar Cargo.toml si está abierto y avisar a rust-analyzer. */
  const onPackagesChanged = useCallback(
    async (message: string, projectDir: string) => {
      log(message, "success");
      if (!project) return;
      const manifest = await join(projectDir, "Cargo.toml");
      const tab = tabsRef.current.find((t) => t.path === manifest);
      if (tab && tab.content === tab.saved) {
        const text = await api.readFile(manifest);
        monaco.editor.getModel(monaco.Uri.file(manifest))?.setValue(text);
        setTabs((ts) => ts.map((t) => (t.path === manifest ? { ...t, content: text, saved: text } : t)));
      } else if (tab) {
        log("Cargo.toml tiene cambios sin guardar en el editor; ciérralo y vuelve a abrirlo para ver la nueva dependencia.", "warning");
      }
      lspRef.current?.reloadWorkspace();
    },
    [project, log],
  );

  // ---------- Diseñador Slint ↔ main.rs (el "code-behind") ----------

  /** Abre el main.rs del proyecto que contiene el .slint. */
  const rustMainFor = useCallback(
    async (slintPath: string) => {
      const owner = projectsRef.current
        .filter((p) => isInside(slintPath, p.dir))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      if (!owner) {
        log("Este archivo .slint no está dentro de un proyecto de Rust.", "warning");
        return null;
      }
      const main = await join(owner.dir, "src", "main.rs");
      await openFile(main);
      const model = monaco.editor.getModel(monaco.Uri.file(main));
      if (!model) {
        log(`No se encontró ${main}.`, "warning");
        return null;
      }
      return { main, model };
    },
    [openFile, log],
  );

  const gotoHandler = useCallback(
    async (slintPath: string, callback: string) => {
      const r = await rustMainFor(slintPath);
      if (!r) return;
      const lines = r.model.getLinesContent();
      const i = lines.findIndex((l) => l.includes(`on_${callback}(`));
      if (i < 0) {
        log(`No se encontró ui.on_${callback}(…) en main.rs. Puedes escribirlo a mano o volver a crear el evento.`, "warning");
        return;
      }
      const body = lines.findIndex((l, j) => j > i && /move\s*\|/.test(l));
      setReveal({ path: r.main, line: body >= 0 ? body + 2 : i + 1, column: 1 });
    },
    [rustMainFor, log],
  );

  const createHandler = useCallback(
    async (slintPath: string, callback: string, params: EventParam[], label: string) => {
      const r = await rustMainFor(slintPath);
      if (!r) return;
      const lines = r.model.getLinesContent();
      if (lines.some((l) => l.includes(`on_${callback}(`))) return gotoHandler(slintPath, callback);
      let runIdx = -1;
      lines.forEach((l, j) => {
        if (/^\s*ui\.run\(\)/.test(l)) runIdx = j;
      });
      const ind = runIdx >= 0 ? lines[runIdx].match(/^\s*/)![0] : "    ";
      const args = params.map((x) => x.name).join(", ");
      const print = params.length
        ? `println!("${callback}: ${params.map(() => "{:?}").join(", ")}", ${args});`
        : `println!("${callback}");`;
      const snippet = [
        `${ind}// ${label}`,
        `${ind}ui.on_${callback}({`,
        `${ind}    let ui_handle = ui.as_weak();`,
        `${ind}    move |${args}| {`,
        `${ind}        let ui = ui_handle.unwrap();`,
        `${ind}        // Escribe aquí lo que debe pasar. Por ejemplo: ui.set_…(…);`,
        `${ind}        ${print}`,
        `${ind}        let _ = ui;`,
        `${ind}    }`,
        `${ind}});`,
        "",
      ].join("\n");
      if (runIdx < 0) {
        log("No encontré `ui.run()` en main.rs. Pega este código antes de mostrar la ventana:", "warning");
        log(snippet, "stdout");
        return;
      }
      r.model.pushEditOperations([], [{ range: new monaco.Range(runIdx + 1, 1, runIdx + 1, 1), text: snippet + "\n" }], () => null);
      setReveal({ path: r.main, line: runIdx + 6, column: ind.length + 9 });
      log(`Evento conectado: ui.on_${callback}(…) en main.rs`, "success");
    },
    [rustMainFor, gotoHandler, log],
  );

  const designerHost = useMemo<DesignerHost>(
    () => ({
      createHandler: (path, cb, params, label) => void createHandler(path, cb, params, label),
      gotoHandler: (path, cb) => void gotoHandler(path, cb),
      openRustFile: (path) => void rustMainFor(path),
    }),
    [createHandler, gotoHandler, rustMainFor],
  );

  // ---------- Explorador: crear, renombrar, eliminar ----------

  /** Mueve las pestañas (y sus modelos de Monaco) de `from` a `to`, incluido el contenido de carpetas. */
  const onRenamed = useCallback((from: string, to: string) => {
    const moved = tabsRef.current.map((t) => {
      if (!isInside(t.path, from)) return t;
      const path = to + t.path.slice(from.length);
      const old = monaco.editor.getModel(monaco.Uri.file(t.path));
      const content = old?.getValue() ?? t.content;
      old?.dispose();
      if (!monaco.editor.getModel(monaco.Uri.file(path))) {
        monaco.editor.createModel(content, languageFor(path), monaco.Uri.file(path));
      }
      return { ...t, path, name: basename(path), content };
    });
    tabsRef.current = moved;
    setTabs(moved);
    setActive((a) => (a && isInside(a, from) ? to + a.slice(from.length) : a));
    if (projectRef.current) {
      const prefer = startupRef.current && isInside(startupRef.current, from)
        ? to + startupRef.current.slice(from.length)
        : startupRef.current ?? undefined;
      refreshProjects(projectRef.current, prefer);
    }
  }, [refreshProjects]);

  const onDeleted = useCallback((path: string) => {
    const remaining = tabsRef.current.filter((t) => !isInside(t.path, path));
    for (const t of tabsRef.current) {
      if (isInside(t.path, path)) setTimeout(() => monaco.editor.getModel(monaco.Uri.file(t.path))?.dispose(), 0);
    }
    tabsRef.current = remaining;
    setTabs(remaining);
    setActive((a) => (a && isInside(a, path) ? remaining[remaining.length - 1]?.path ?? null : a));
    if (projectRef.current) refreshProjects(projectRef.current, startupRef.current ?? undefined);
  }, [refreshProjects]);

  /** Al crear `src/algo.rs`, ofrecer agregar `mod algo;` para que el compilador lo incluya. */
  const onCreated = useCallback(
    async (path: string, isDir: boolean) => {
      if (!project) return;
      if (isDir || basename(path) === "Cargo.toml") refreshProjects(project, startupDir ?? undefined);
      if (isDir) return;
      await openFile(path);
      const owner = projectsRef.current
        .filter((p) => isInside(path, p.dir))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      if (!owner) return;
      const src = await join(owner.dir, "src");
      const stem = basename(path).replace(/\.rs$/, "");
      if (dirname(path) !== src || !path.endsWith(".rs") || ["main", "lib"].includes(stem)) return;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(stem)) return;
      const entries = await api.listDir(src).catch(() => []);
      const crateRoot = entries.find((e) => e.name === "main.rs") ?? entries.find((e) => e.name === "lib.rs");
      if (!crateRoot) return;
      const yes = await ask(
        `Para usar “${basename(path)}” hay que declararlo con \`mod ${stem};\` en ${crateRoot.name}. ¿Lo agrego?`,
        { title: "Nuevo módulo", okLabel: "Agregar", cancelLabel: "No" },
      );
      if (!yes) return;
      const insert = (text: string) => {
        const lines = text.split("\n");
        let at = -1;
        lines.forEach((l, i) => {
          if (/^\s*(pub(\([^)]*\))?\s+)?mod\s+\w+\s*;/.test(l)) at = i;
        });
        if (at >= 0) lines.splice(at + 1, 0, `mod ${stem};`);
        else lines.unshift(`mod ${stem};`, "");
        return lines.join("\n");
      };
      const model = monaco.editor.getModel(monaco.Uri.file(crateRoot.path));
      if (model) {
        // Editar en el editor (queda sin guardar, con deshacer disponible).
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: insert(model.getValue()) }], () => null);
      } else {
        const text = await api.readFile(crateRoot.path);
        await api.writeFile(crateRoot.path, insert(text));
      }
      log(`Se agregó \`mod ${stem};\` a ${crateRoot.name}`, "success");
    },
    [project, startupDir, refreshProjects, openFile, log],
  );

  // Errores/advertencias por archivo, para colorear el explorador.
  const problems = useMemo(() => {
    const m = new Map<string, FileProblems>();
    for (const d of diagnostics) {
      if (!d.file) continue;
      const cur = m.get(d.file) ?? { errors: 0, warnings: 0 };
      if (d.level.startsWith("error")) cur.errors++;
      else cur.warnings++;
      m.set(d.file, cur);
    }
    return m;
  }, [diagnostics]);

  // ---------- Compilar / ejecutar ----------
  const runTask = useCallback(
    async (task: Task) => {
      if (!project) {
        log("Abre o crea un proyecto primero.", "warning");
        return;
      }
      if (!startupProject) {
        log("No hay un proyecto de inicio. Crea uno o elígelo en la barra de herramientas.", "warning");
        return;
      }
      if (running) return;
      try {
        await saveAll(); // como VS: guardar todo antes de compilar
      } catch {
        return;
      }
      setOutput([]);
      setBuildDiagnostics([]);
      setBottomTab("output");
      setRunning(task);
      if (projects.length > 1) log(`Proyecto: ${startupProject.name}`, "muted");
      try {
        await api.startTask(startupProject.dir, task, task === "run" && runExternal);
      } catch (err) {
        setRunning(null);
        log(String(err), "error");
      }
    },
    [project, startupProject, projects.length, running, saveAll, log, runExternal],
  );

  const changeRunMode = useCallback((external: boolean) => {
    setRunExternal(external);
    try {
      localStorage.setItem(RUN_EXTERNAL_KEY, external ? "1" : "0");
    } catch {
      /* sin almacenamiento */
    }
  }, []);

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

  const format = useCallback(() => {
    editorRef.current?.getAction("editor.action.formatDocument")?.run();
  }, []);

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
    refreshToolchain();
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      /* sin almacenamiento */
    }
    if (last) openProject(last).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.onDidChangeCursorPosition((e) =>
      setCursor({ line: e.position.lineNumber, column: e.position.column }),
    );
  };

  // Saltar a una línea (lista de errores o "ir a definición").
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
        canFormat={!!activeTab && lspReady && activeTab.path.endsWith(".rs")}
        onNew={() => setShowNew(true)}
        onOpen={openFolder}
        onSave={saveActive}
        onFormat={format}
        onPackages={() => startupDir && setPackagesFor(startupDir)}
        onTask={runTask}
        onStop={stop}
        runExternal={runExternal}
        onRunModeChange={changeRunMode}
        root={project}
        projects={projects}
        startup={startupProject}
        onSetStartup={setStartup}
      />
      <ToolchainBanner status={toolchain} onInstall={installComponents} />
      <div className="main">
        <aside className="sidebar">
          <Explorer
            root={project}
            activePath={active}
            problems={problems}
            onOpenFile={openFile}
            onCreated={onCreated}
            onRenamed={onRenamed}
            onDeleted={onDeleted}
            onError={(msg) => log(msg, "error")}
            projects={projects}
            startupDir={startupDir}
            onSetStartup={setStartup}
            onAddReference={setReferenceFor}
            onManagePackages={setPackagesFor}
          />
        </aside>
        <div className="center">
          {project ? (
            <EditorArea
              tabs={tabs}
              active={active}
              onSelect={setActive}
              onClose={closeTab}
              onMount={onEditorMount}
              designer={designerHost}
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
        <span className="status-item">
          {running ? <Codicon name="loading" spin /> : <Codicon name="check" />}
          {running ? TASK_LABEL[running] : "Listo"}
        </span>
        <span className="status-path">{project ?? "Sin proyecto"}</span>
        <span className="spacer" />
        {project && lspStatus && (
          <button
            className="status-btn"
            title="Reiniciar rust-analyzer"
            onClick={() => setLspGeneration((g) => g + 1)}
          >
            <Codicon
              name={/…|\d+%/.test(lspStatus) ? "sync" : /error|detuvo|Sin /.test(lspStatus) ? "warning" : "check"}
              spin={/…|\d+%/.test(lspStatus)}
            />
            {lspStatus.replace(/ ✓$/, "")}
          </button>
        )}
        {activeTab && <span>Ln {cursor.line}, Col {cursor.column}</span>}
        <span>{toolchain?.cargo ?? ""}</span>
      </footer>
      {showNew && (
        <NewProjectDialog currentRoot={project} onCancel={() => setShowNew(false)} onCreate={createProject} />
      )}
      {packagesFor && (
        <PackagesDialog
          project={packagesFor}
          title={projects.find((p) => p.dir === packagesFor)?.name}
          projectKind={projects.find((p) => p.dir === packagesFor)?.kind ?? "bin"}
          toolchain={toolchain}
          onInstallComponents={installComponents}
          onClose={() => setPackagesFor(null)}
          onChanged={(msg) => onPackagesChanged(msg, packagesFor)}
        />
      )}
      {referenceFor && project && projects.some((p) => p.dir === referenceFor) && (
        <ReferenceDialog
          root={project}
          target={projects.find((p) => p.dir === referenceFor)!}
          projects={projects}
          onClose={() => setReferenceFor(null)}
          onAdded={(msg) => onPackagesChanged(msg, referenceFor)}
        />
      )}
    </div>
  );
}

function Welcome({ onNew, onOpen }: { onNew: () => void; onOpen: () => void }) {
  return (
    <div className="welcome">
      <img className="welcome-logo" src={oxideMark} height={96} alt="" />
      <h1 className="wordmark">
        <span className="brand-oxide">Oxide</span> Studio
      </h1>
      <p className="muted">Crea programas en Rust de forma fácil.</p>
      <div className="welcome-actions">
        <button className="welcome-card" onClick={onNew}>
          <Codicon name="new-file" className="welcome-icon" />
          <strong>Nuevo proyecto</strong>
          <small>Consola o biblioteca</small>
        </button>
        <button className="welcome-card" onClick={onOpen}>
          <Codicon name="folder-opened" className="welcome-icon" />
          <strong>Abrir proyecto</strong>
          <small>Una carpeta con Cargo.toml</small>
        </button>
      </div>
      <div className="shortcuts muted">
        <div><kbd>F5</kbd> Ejecutar</div>
        <div><kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> Compilar</div>
        <div><kbd>Ctrl/⌘</kbd>+<kbd>S</kbd> Guardar</div>
        <div><kbd>Shift</kbd>+<kbd>F5</kbd> Detener</div>
        <div><kbd>F12</kbd> Ir a definición</div>
        <div><kbd>F2</kbd> Renombrar</div>
        <div><kbd>Ctrl/⌘</kbd>+<kbd>.</kbd> Acciones rápidas</div>
        <div><kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> Formatear</div>
      </div>
    </div>
  );
}
