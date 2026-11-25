import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
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
  type DebuggerInfo,
  type SolutionInfo,
  type PublishOptions,
  type Sample,
} from "./api";
import Toolbar from "./components/Toolbar";
import Explorer, { type FileProblems, type SolutionAction } from "./components/Explorer";
import EditorArea, { type Tab } from "./components/EditorArea";
import BottomPanel, { type BottomTab } from "./components/BottomPanel";
import NewProjectDialog from "./components/NewProjectDialog";
import SamplesDialog from "./components/SamplesDialog";
import McpDialog from "./components/McpDialog";
// El chat (y los SDK de Anthropic y Gemini) se carga solo al abrirlo.
const ChatPanel = lazy(() => import("./ai/ChatPanel"));
import type { ChatContext } from "./ai/types";
import TerminalPanel from "./terminal/TerminalPanel";
import { runInTerminal } from "./terminal/sessions";
import PackagesDialog from "./components/packages/PackagesDialog";
import ReferenceDialog from "./components/ReferenceDialog";
import ToolchainBanner from "./components/ToolchainBanner";
import { LspClient } from "./lsp/client";
import { registerRustProviders } from "./lsp/providers";
import type { DesignerHost } from "./designer/SlintDesigner";
import type { EventParam } from "./designer/widgets";
import { BreakpointStore } from "./debug/breakpoints";
import { DebugController, type DebugHost } from "./debug/controller";
import { registerDebugHover } from "./debug/hover";
import { BreakpointsPanel, DebugPanel } from "./debug/DebugPanels";
import BreakpointDialog, { type BreakpointDraft } from "./debug/BreakpointDialog";
import DiagnosticsPanel, { useDiagnostics } from "./debug/Diagnostics";
import DebugConsole, { type ConsoleEntry } from "./debug/DebugConsole";
import type * as L from "./lsp/types";
import { basename, dirname, isInside, joinPath, languageFor } from "./util";
import { Codicon } from "./components/Icon";
import Splitter from "./components/Splitter";
import ToolbarCustomize from "./components/ToolbarCustomize";
import PublishDialog from "./components/PublishDialog";
import SetupDialog from "./components/SetupDialog";
import { useGit } from "./git/useGit";
import { UpdateDialog, useUpdates } from "./updates";
import GitPanel, { githubUrl, type GitIntent } from "./git/GitPanel";
import DiffView, { type DiffRequest } from "./git/DiffView";
import { CloneDialog, PublishGitHubDialog } from "./git/GitDialogs";
import { homeDir } from "@tauri-apps/api/path";
import MenuBar, { type Menu } from "./components/MenuBar";
import SettingsDialog from "./components/SettingsDialog";
import AboutDialog, { GITHUB_URL } from "./components/AboutDialog";
import { getSettings, useSettings } from "./settings";
import { resetLayout } from "./layout";
import { setThemePref, useTheme } from "./theme";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PANELS, usePanelSize, usePanelVisible } from "./layout";
import raxorinMark from "./assets/brand/raxorin-mark.svg";
import { t, tErr, tb, docsUrl } from "./i18n/index.ts";

const LAST_PROJECT_KEY = "raxorinstudio.lastProject";
const RECENT_KEY = "raxorinstudio.recent";

/** Carpetas y soluciones abiertas recientemente (la más nueva primero). */
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}
const RUN_EXTERNAL_KEY = "raxorinstudio.runExternal";
const startupKey = (root: string) => `raxorinstudio.startup:${root}`;
const MAX_CHUNKS = 5000;

const TASK_LABEL: Partial<Record<Task, string>> = {
  build: "Compilando…",
  check: "Revisando…",
  test: "Ejecutando pruebas…",
  run: "Ejecutando…",
  debug: t("Compilando para depurar…"),
  publish: "Publicando (Release)…",
  "setup-target": t("Instalando soporte de plataforma…"),
};

const uriOf = (path: string) => monaco.Uri.file(path).toString();

/** Almacén de puntos y controlador de depuración: uno solo por ventana. */
function debugSingletons() {
  const g = globalThis as unknown as {
    __raxorinDebug?: { breakpoints: BreakpointStore; controller: DebugController; hostRef: { current: DebugHost } };
  };
  if (!g.__raxorinDebug) {
    const breakpoints = new BreakpointStore();
    const hostRef: { current: DebugHost } = {
      current: { output: () => {}, showLocation: () => {}, isUserCode: () => false, onStopped: () => {}, onEnded: () => {} },
    };
    const controller = new DebugController(breakpoints, {
      output: (t, k) => hostRef.current.output(t, k),
      showLocation: (p, l) => hostRef.current.showLocation(p, l),
      isUserCode: (p) => hostRef.current.isUserCode(p),
      onStopped: () => hostRef.current.onStopped(),
      onEnded: () => hostRef.current.onEnded(),
    });
    g.__raxorinDebug = { breakpoints, controller, hostRef };
  }
  return g.__raxorinDebug;
}

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
  const bottomTabRef = useRef(bottomTab);
  bottomTabRef.current = bottomTab;
  // Paneles redimensionables y que se pueden ocultar (se recuerdan entre sesiones).
  const sidebarSize = usePanelSize(PANELS.sidebar);
  const bottomSize = usePanelSize(PANELS.bottom);
  const diagSize = usePanelSize(PANELS.diagnostics);
  const aiSize = usePanelSize(PANELS.ai);
  const [sidebarVisible, setSidebarVisible] = usePanelVisible("sidebar");
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  // Asistente de herramientas (Rust, C/C++, Git…): "first" = se abrió solo porque falta algo imprescindible.
  const [setupOpen, setSetupOpen] = useState<null | "first" | "manual">(null);
  // Configuración de compilación (como Debug/Release de Visual Studio). Depurar siempre usa Debug.
  const [buildConfig, setBuildConfigState] = useState<"debug" | "release">(() => {
    try {
      return localStorage.getItem("raxorinstudio.buildConfig") === "release" ? "release" : "debug";
    } catch {
      return "debug";
    }
  });
  const setBuildConfig = useCallback((c: "debug" | "release") => {
    setBuildConfigState(c);
    try {
      localStorage.setItem("raxorinstudio.buildConfig", c);
    } catch {
      /* sin almacenamiento */
    }
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const settings = useSettings();
  const { pref: themePref } = useTheme();
  const [bottomVisible, setBottomVisible] = usePanelVisible("bottom");
  // Para los atajos de teclado (el manejador se registra una sola vez).
  const bottomVisibleRef = useRef(bottomVisible);
  bottomVisibleRef.current = bottomVisible;
  const [showNew, setShowNew] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [packagesFor, setPackagesFor] = useState<string | null>(null);
  const [referenceFor, setReferenceFor] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [startupDir, setStartupDir] = useState<string | null>(null);
  // Solución abierta (.rxsln); null si se abrió una carpeta suelta.
  const [solution, setSolution] = useState<SolutionInfo | null>(null);
  const solutionRef = useRef<SolutionInfo | null>(null);
  solutionRef.current = solution;
  // Raíces del explorador: la carpeta abierta, o la carpeta de cada proyecto de la solución.
  const roots = useMemo(
    () => (solution ? solution.projects.filter((p) => p.exists).map((p) => p.path) : project ? [project] : []),
    [solution, project],
  );
  const rootsKey = roots.join("|");
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  /** Clave para recordar la configuración: el .rxsln, o la carpeta. */
  const workspaceKey = solution?.file ?? project;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
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

  // ---------- Depuración ----------
  // Instancias únicas (también sobreviven a la recarga en caliente durante el desarrollo:
  // dos controladores a la vez podían dejar una sesión de depuración sin dueño).
  const bpStore = debugSingletons().breakpoints;
  const bpVersion = useSyncExternalStore(bpStore.subscribe, bpStore.getVersion);
  const [debuggerInfo, setDebuggerInfo] = useState<DebuggerInfo | null>(null);
  const [bpDraft, setBpDraft] = useState<BreakpointDraft | null>(null);
  // El controlador llama a la interfaz a través de este objeto (siempre con las funciones más recientes).
  const debugHostRef = debugSingletons().hostRef;
  const debug = debugSingletons().controller;
  const debugSnap = useSyncExternalStore(debug.subscribe, debug.getSnapshot);
  const debugActive = debugSnap.status !== "idle";

  // Herramientas de diagnóstico (CPU/memoria) y consola de depuración.
  const stopInfo = useMemo(
    () => (debugSnap.status === "stopped" ? { n: debugSnap.stopCount, label: debugSnap.description ?? t("Detenido") } : null),
    [debugSnap.status, debugSnap.stopCount, debugSnap.description],
  );
  const diag = useDiagnostics(stopInfo);
  const [diagOpen, setDiagOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(() => {
    try {
      return localStorage.getItem("raxorinstudio.aiOpen") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("raxorinstudio.aiOpen", aiOpen ? "1" : "0");
    } catch {
      /* sin almacenamiento */
    }
  }, [aiOpen]);
  useEffect(() => {
    // Como en Visual Studio: se abre sola al empezar a ejecutar o depurar.
    if (diag.pid !== null) setDiagOpen(true);
  }, [diag.pid]);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  useEffect(() => {
    if (debugSnap.status === "starting") setConsoleEntries([]);
  }, [debugSnap.status]);

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

  const append = useCallback((raw: OutputChunk) => {
    // Los mensajes del IDE (en español en el backend) se traducen; la salida del programa, nunca.
    const chunk = raw.kind === "stdout" || raw.kind === "stderr" ? raw : { ...raw, text: tb(raw.text) };
    setOutput((o) => {
      const next = [...o, chunk];
      return next.length > MAX_CHUNKS ? next.slice(-MAX_CHUNKS) : next;
    });
  }, []);
  const log = useCallback(
    (text: string, kind: OutputChunk["kind"] = "info") => append({ text: text + "\n", kind }),
    [append],
  );

  const updates = useUpdates(log);

  // ---------- Git ----------
  const git = useGit(roots, log, solution?.dir ?? project, !!solution);
  const [sideView, setSideViewState] = useState<"explorer" | "git">(() => {
    try {
      return localStorage.getItem("raxorinstudio.sideView") === "git" ? "git" : "explorer";
    } catch {
      return "explorer";
    }
  });
  const setSideView = useCallback((v: "explorer" | "git") => {
    setSideViewState(v);
    try {
      localStorage.setItem("raxorinstudio.sideView", v);
    } catch {
      /* sin almacenamiento */
    }
  }, []);
  const [gitIntent, setGitIntent] = useState<GitIntent>(null);
  const [diffReq, setDiffReq] = useState<DiffRequest | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [ghPublishOpen, setGhPublishOpen] = useState(false);
  const [homeProjects, setHomeProjects] = useState("");
  useEffect(() => {
    homeDir().then((h) => join(h, "RustProjects")).then(setHomeProjects).catch(() => {});
  }, []);
  /** Abre el panel Git (y una acción en él: escribir el commit, crear rama…). */
  const showGit = useCallback(
    (intent: GitIntent = null) => {
      setSidebarVisible(true);
      setSideView("git");
      setGitIntent(intent);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setSideView],
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
          log(tErr(err), "error");
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
  /** Busca los proyectos en todas las raíces (una carpeta, o cada proyecto de la solución). */
  const refreshProjects = useCallback(async (roots: string[], key: string, prefer?: string) => {
    const list: ProjectInfo[] = [];
    for (const root of roots) {
      try {
        for (const p of await api.findProjects(root)) if (!list.some((x) => x.dir === p.dir)) list.push(p);
      } catch (e) {
        log(tErr(e), "error");
      }
    }
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(startupKey(key));
    } catch {
      /* sin almacenamiento */
    }
    const byDir = (d?: string | null) => list.find((p) => p.dir === d);
    const startup =
      byDir(prefer) ??
      byDir(solutionRef.current?.startup) ??
      byDir(saved) ??
      list.find((p) => p.kind === "bin") ??
      list[0] ??
      null;
    setProjects(list);
    setStartupDir(startup?.dir ?? null);
    return { list, startup };
  }, [log]);

  const setStartup = useCallback(
    (dir: string) => {
      setStartupDir(dir);
      const key = solutionRef.current?.file ?? project;
      if (key) {
        try {
          localStorage.setItem(startupKey(key), dir);
        } catch {
          /* sin almacenamiento */
        }
      }
      // En una solución, el proyecto de inicio se guarda en el .rxsln (se comparte con git).
      const sol = solutionRef.current;
      if (sol) {
        api.solutionSetStartup(sol.file, dir).catch((e) => log(tErr(e), "error"));
        setSolution({ ...sol, startup: dir });
      }
      const p = projects.find((x) => x.dir === dir);
      if (p) log(t("Proyecto de inicio: {0}", p.name));
    },
    [project, projects, log],
  );

  const startupProject = projects.find((p) => p.dir === startupDir) ?? null;

  /** Cierra las pestañas y limpia el estado antes de abrir otra carpeta o solución. */
  const resetWorkspace = useCallback((key: string) => {
    for (const t of tabsRef.current) monaco.editor.getModel(monaco.Uri.file(t.path))?.dispose();
    tabsRef.current = [];
    setTabs([]);
    setActive(null);
    setBuildDiagnostics([]);
    setLspDiagnostics({});
    try {
      localStorage.setItem(LAST_PROJECT_KEY, key);
    } catch {
      /* almacenamiento no disponible */
    }
    setRecent((r) => {
      const next = [key, ...r.filter((x) => x !== key)].slice(0, 10);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* almacenamiento no disponible */
      }
      return next;
    });
  }, []);

  /** Abre una solución .rxsln con todos sus proyectos. */
  const openSolution = useCallback(
    async (file: string) => {
      const info = await api.solutionRead(file);
      resetWorkspace(file);
      solutionRef.current = info;
      setSolution(info);
      setProject(info.dir);
      const roots = info.projects.filter((p) => p.exists).map((p) => p.path);
      log(t("Solución abierta: {0} ({1} {2})", info.name, roots.length, roots.length === 1 ? t("proyecto") : t("proyectos")));
      for (const p of info.projects.filter((x) => !x.exists)) {
        log(t("Aviso: no se encontró el proyecto “{0}” ({1}).", p.ruta, p.path), "warning");
      }
      const found = await refreshProjects(roots, info.file);
      if (found.startup) await openMainFile(found.startup.dir);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log, resetWorkspace],
  );

  const openProject = useCallback(
    async (path: string) => {
      // Si la carpeta tiene una solución, abrir la solución (como Visual Studio).
      const sln = await api.solutionFind(path).catch(() => null);
      if (sln) {
        log(t("Se encontró la solución {0} en la carpeta.", basename(sln)), "muted");
        return openSolution(sln);
      }
      await api.listDir(path);
      resetWorkspace(path);
      solutionRef.current = null;
      setSolution(null);
      setProject(path);
      log(`Carpeta abierta: ${path}`);
      const found = await refreshProjects([path], path);
      if (found.list.length === 0) {
        log(t("No se encontraron proyectos de Rust en esta carpeta. Crea uno con “Nuevo”."), "warning");
      } else if (found.list.length > 1) {
        log(t("Se encontraron {0} proyectos. Proyecto de inicio: {1}", found.list.length, found.startup?.name ?? t("ninguno")));
      }
      if (found.startup) await openMainFile(found.startup.dir);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log, openFile, openSolution, resetWorkspace],
  );

  const saveTab = useCallback(
    async (tab: Tab) => {
      try {
        await api.writeFile(tab.path, tab.content);
        setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, saved: tab.content } : t)));
        lspRef.current?.didSave(tab.path); // dispara Clippy en segundo plano
        // Si se editó el .rxsln a mano, volver a cargar la solución.
        if (solutionRef.current && tab.path === solutionRef.current.file) {
          api
            .solutionRead(tab.path)
            .then((info) => {
              solutionRef.current = info;
              setSolution(info);
              const roots = info.projects.filter((p) => p.exists).map((p) => p.path);
              refreshProjects(roots, info.file);
              log(t("Solución actualizada."), "muted");
            })
            .catch((e) => log(tErr(e), "error"));
        }
      } catch (err) {
        log(tErr(err), "error");
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const discard = await ask(t("“{0}” tiene cambios sin guardar. ¿Cerrar de todos modos?", tab.name), {
        title: t("Cambios sin guardar"),
        kind: "warning",
        okLabel: t("Cerrar sin guardar"),
        cancelLabel: t("Cancelar"),
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
      setLspStatus(t("Sin autocompletado (falta rust-analyzer)"));
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
            setLspStatus(t("rust-analyzer se detuvo (clic para reiniciar)"));
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
        log(t("No se pudo iniciar rust-analyzer: {0}", tErr(e)), "error");
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
    const dir = await open({ directory: true, title: t("Abrir proyecto de Rust") });
    if (typeof dir === "string") await openProject(dir).catch((e) => log(tErr(e), "error"));
  }, [openProject, log]);

  const createProject = useCallback(
    async (
      parent: string,
      name: string,
      kind: "bin" | "lib" | "slint" | "solution",
      addToCurrent: boolean,
      start?: { sample: Sample; online: boolean },
    ) => {
      // Empezar desde un ejemplo: se copia en vez de crear el proyecto vacío.
      const fromSample = start ? await api.sampleCreate(start.sample, parent, name, start.online) : null;
      if (fromSample && kind === "solution") {
        setShowNew(false);
        log(t("Solución creada desde el ejemplo «{0}»: {1}", start!.sample.nombre, fromSample.open), "success");
        await openSolution(fromSample.open);
        await openFile(fromSample.file).catch(() => {});
        return;
      }
      if (kind === "solution") {
        // Solución en blanco: una carpeta con el .rxsln, lista para agregar proyectos.
        const dir = await join(parent, name);
        const file = await api.solutionCreate(dir, name, []);
        setShowNew(false);
        log(t("Solución creada: {0}", file), "success");
        await openSolution(file);
        return;
      }
      const path = fromSample ? fromSample.open : await api.createProject(parent, name, kind);
      const openDesigner = async () => {
        if (fromSample) {
          await openFile(fromSample.file).catch(() => {});
          log(t("Basado en el ejemplo «{0}»: lee los comentarios del código y pulsa F5 para ejecutarlo.", start!.sample.nombre), "muted");
          if (kind === "slint") log(t("La primera compilación de una ventana (Slint) tarda un par de minutos."), "muted");
          return;
        }
        if (kind !== "slint") return;
        await openFile(await join(path, "ui", "app-window.slint"));
        log(t("Ventana creada: diseña en app-window.slint y escribe el código en main.rs. La primera compilación de Slint tarda un poco."), "muted");
      };
      setShowNew(false);
      const sol = solutionRef.current;
      if (addToCurrent && project && (sol || isInside(path, project))) {
        let roots = [project];
        if (sol) {
          // En una solución: registrarlo en el .rxsln.
          const info = await api.solutionAddProject(sol.file, path);
          solutionRef.current = info;
          setSolution(info);
          roots = info.projects.filter((p) => p.exists).map((p) => p.path);
        }
        const kindName = { bin: t("aplicación de consola"), lib: t("biblioteca"), slint: t("aplicación de ventana") }[kind];
        log((sol ? t("Proyecto agregado a la solución: {0} ({1})") : t("Proyecto agregado a la carpeta: {0} ({1})")).replace("{0}", name).replace("{1}", kindName), "success");
        // Si aún no hay un ejecutable de inicio, el nuevo pasa a serlo.
        const prefer = kind !== "lib" && startupProject?.kind !== "bin" ? path : startupDir ?? undefined;
        await refreshProjects(roots, sol?.file ?? project, prefer);
        await openMainFile(path);
        await openDesigner();
        if (kind === "lib") {
          log(t("Consejo: clic derecho sobre un proyecto → “Agregar referencia a proyecto…” para usar esta biblioteca."), "muted");
        }
      } else {
        log(`Proyecto creado: ${path}`, "success");
        await openProject(path);
        await openDesigner();
      }
    },
    [project, startupProject, startupDir, refreshProjects, openMainFile, openProject, openSolution, openFile, log],
  );

  const refreshToolchain = useCallback(async () => {
    try {
      setToolchain(await api.toolchainStatus());
    } catch (e) {
      log(tErr(e), "error");
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
        log(tErr(e), "error");
      }
      await refreshToolchain();
    },
    [log, refreshToolchain],
  );

  /**
   * Recarga desde el disco las pestañas sin cambios pendientes cuyo archivo cambió fuera del editor
   * (otra app, Git, una IA por MCP o el chat). Las que tienen cambios sin guardar no se tocan.
   */
  const reloadFromDisk = useCallback(async (paths?: string[]) => {
    for (const tab of tabsRef.current) {
      if (paths && !paths.includes(tab.path)) continue;
      const model = monaco.editor.getModel(monaco.Uri.file(tab.path));
      if (!model || model.getValue() !== tab.saved) continue;
      let disk: string;
      try {
        disk = await api.readFile(tab.path);
      } catch {
        continue; // borrado o ilegible: se queda como está
      }
      if (disk === tab.saved || model.getValue() !== tab.saved) continue;
      // Como una edición: Deshacer (Ctrl/⌘+Z) vuelve al texto anterior.
      tabsRef.current = tabsRef.current.map((t) => (t.path === tab.path ? { ...t, content: disk, saved: disk } : t));
      setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, content: disk, saved: disk } : t)));
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: disk }], () => null);
    }
  }, []);

  const activeRef = useRef<string | null>(null);
  activeRef.current = active;
  /** Lo que el chat con IA sabe del IDE en cada mensaje. */
  const chatContext = useCallback((): ChatContext => {
    const sol = solutionRef.current;
    const roots = sol ? [sol.dir, ...rootsRef.current.filter((r) => !r.startsWith(sol.dir))] : rootsRef.current;
    const ed = editorRef.current;
    const sel = ed?.getSelection();
    const selection = sel && !sel.isEmpty() ? ed?.getModel()?.getValueInRange(sel) ?? null : null;
    const diags = diagRef.current;
    const summary = diags
      .filter((d) => d.level === "error" || d.level === "warning")
      .slice(0, 30)
      .map((d) => `${d.level}${d.code ? `[${d.code}]` : ""}: ${d.message}${d.file ? ` (${d.file}:${d.line})` : ""}`)
      .join("\n");
    return { roots, cwd: sol?.dir ?? rootsRef.current[0] ?? null, activeFile: activeRef.current, selection, diagnostics: summary };
  }, []);

  useEffect(() => {
    const un = listen<string[]>("fs-changed", (e) => {
      const dirs = new Set(e.payload.map((d) => d.replace(/[\\/]+$/, "")));
      const touched = tabsRef.current.map((t) => t.path).filter((p) => dirs.has(p.replace(/[\\/][^\\/]*$/, "")));
      if (touched.length) void reloadFromDisk(touched);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [reloadFromDisk]);

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
        log(t("Cargo.toml tiene cambios sin guardar en el editor; ciérralo y vuelve a abrirlo para ver la nueva dependencia."), "warning");
      }
      lspRef.current?.reloadWorkspace();
    },
    [project, log],
  );

  debugHostRef.current = {
    output: (text, kind) => {
      if (text) append({ text, kind });
    },
    showLocation: (path, line) => {
      openFile(path).then(() => setReveal({ path, line, column: 1 }));
    },
    isUserCode: (path) => rootsRef.current.some((r) => isInside(path, r)),
    onStopped: () => setBottomTab("debug"),
    onEnded: () => setBottomTab((t) => (t === "debug" ? "output" : t)),
  };

  useEffect(() => {
    registerDebugHover(() => debug);
    api.debuggerInfo().then(setDebuggerInfo).catch(() => {});
  }, [debug]);

  useEffect(() => bpStore.load(workspaceKey), [bpStore, workspaceKey]);

  // Vigilar cambios en disco de la carpeta abierta (para el explorador).
  useEffect(() => {
    if (roots.length) api.watchProject(roots).catch((e) => log(tErr(e), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, log]);

  // La compilación para depurar terminó: lanzar lldb-dap.
  useEffect(() => {
    const un = listen<{ program: string; cwd: string }>("debug-ready", (e) => {
      const info = debuggerInfoRef.current;
      debug.start({
        program: e.payload.program,
        cwd: e.payload.cwd,
        kind: info?.kind ?? null,
        formatters: info?.formatters ?? null,
        formatterGuard: info?.formatterGuard ?? null,
        stdinSupported: info?.stdinSupported ?? false,
        runTo: pendingRunTo.current ?? undefined,
      });
      pendingRunTo.current = null;
    });
    return () => {
      un.then((f) => f());
    };
  }, [debug]);
  const pendingRunTo = useRef<{ path: string; line: number } | null>(null);
  const debuggerInfoRef = useRef(debuggerInfo);
  debuggerInfoRef.current = debuggerInfo;

  const toggleBreakpointAtCursor = useCallback(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const pos = ed?.getPosition();
    if (!model || !pos || model.uri.scheme !== "file") return;
    bpStore.toggle(model.uri.fsPath, pos.lineNumber);
  }, [bpStore]);

  /** Abre el diálogo de punto de interrupción para una línea (editando el existente si hay). */
  const openBreakpointDialog = useCallback(
    (path: string, line: number, kind?: BreakpointDraft["kind"]) => {
      setBpDraft({ path, line, existing: bpStore.get(path, line), kind });
    },
    [bpStore],
  );

  const cursorLocation = () => {
    const model = editorRef.current?.getModel();
    const pos = editorRef.current?.getPosition();
    if (!model || !pos || model.uri.scheme !== "file") return null;
    return { path: model.uri.fsPath, line: pos.lineNumber };
  };

  // ---------- Diseñador Slint ↔ main.rs (el "code-behind") ----------

  /** Abre el main.rs del proyecto que contiene el .slint. */
  const rustMainFor = useCallback(
    async (slintPath: string) => {
      const owner = projectsRef.current
        .filter((p) => isInside(slintPath, p.dir))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
      if (!owner) {
        log(t("Este archivo .slint no está dentro de un proyecto de Rust."), "warning");
        return null;
      }
      const main = await join(owner.dir, "src", "main.rs");
      await openFile(main);
      const model = monaco.editor.getModel(monaco.Uri.file(main));
      if (!model) {
        log(t("No se encontró {0}.", main), "warning");
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
        log(t("No se encontró ui.on_{0}(…) en main.rs. Puedes escribirlo a mano o volver a crear el evento.", callback), "warning");
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
        `${ind}        // ${t("Escribe aquí lo que debe pasar. Por ejemplo: ui.set_…(…);")}`,
        `${ind}        ${print}`,
        `${ind}        let _ = ui;`,
        `${ind}    }`,
        `${ind}});`,
        "",
      ].join("\n");
      if (runIdx < 0) {
        log(t("No encontré `ui.run()` en main.rs. Pega este código antes de mostrar la ventana:"), "warning");
        log(snippet, "stdout");
        return;
      }
      r.model.pushEditOperations([], [{ range: new monaco.Range(runIdx + 1, 1, runIdx + 1, 1), text: snippet + "\n" }], () => null);
      setReveal({ path: r.main, line: runIdx + 6, column: ind.length + 9 });
      log(t("Evento conectado: ui.on_{0}(…) en main.rs", callback), "success");
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
      refreshProjects(rootsRef.current, workspaceKeyRef.current ?? projectRef.current, prefer);
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
    if (projectRef.current) refreshProjects(rootsRef.current, workspaceKeyRef.current ?? projectRef.current, startupRef.current ?? undefined);
  }, [refreshProjects]);

  /** Al crear `src/algo.rs`, ofrecer agregar `mod algo;` para que el compilador lo incluya. */
  const onCreated = useCallback(
    async (path: string, isDir: boolean) => {
      if (!project) return;
      if (isDir || basename(path) === "Cargo.toml") refreshProjects(rootsRef.current, workspaceKeyRef.current ?? project, startupDir ?? undefined);
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
        t("Para usar “{0}” hay que declararlo con `mod {1};` en {2}. ¿Lo agrego?", basename(path), stem, crateRoot.name),
        { title: t("Nuevo módulo"), okLabel: t("Agregar"), cancelLabel: t("No") },
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
      log(t("Se agregó `mod {0};` a {1}", stem, crateRoot.name), "success");
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

  // ---------- Soluciones (.rxsln) ----------

  const applySolution = useCallback(
    (info: SolutionInfo) => {
      solutionRef.current = info;
      setSolution(info);
      const r = info.projects.filter((p) => p.exists).map((p) => p.path);
      return refreshProjects(r, info.file, startupRef.current ?? undefined);
    },
    [refreshProjects],
  );

  const openSolutionDialog = useCallback(async () => {
    const file = await open({ title: t("Abrir solución"), filters: [{ name: t("Solución de Raxorin Studio"), extensions: ["rxsln"] }] });
    if (typeof file === "string") await openSolution(file).catch((e) => log(tErr(e), "error"));
  }, [openSolution, log]);

  const askOpenSolution = useCallback(
    async (file: string) => {
      const yes = await ask(t("¿Abrir “{0}” como solución?", basename(file)), {
        title: t("Solución de Raxorin Studio"),
        okLabel: t("Abrir solución"),
        cancelLabel: t("Editar como texto"),
      });
      if (yes) await openSolution(file).catch((e) => log(tErr(e), "error"));
      else await openFile(file);
    },
    [openSolution, openFile, log],
  );

  const onSolutionAction = useCallback(
    async (action: SolutionAction, path?: string) => {
      const sol = solutionRef.current;
      try {
        if (action === "new-project") {
          setShowNew(true);
        } else if (action === "add-existing" && sol) {
          const dir = await open({ directory: true, title: t("Agregar proyecto existente (carpeta con Cargo.toml)") });
          if (typeof dir !== "string") return;
          await applySolution(await api.solutionAddProject(sol.file, dir));
          log(t("Proyecto agregado a la solución: {0}", basename(dir)), "success");
        } else if (action === "remove" && sol && path) {
          const yes = await ask(t("¿Quitar “{0}” de la solución? Sus archivos no se borran.", basename(path)), {
            title: t("Quitar de la solución"),
            kind: "warning",
            okLabel: t("Quitar"),
            cancelLabel: t("Cancelar"),
          });
          if (!yes) return;
          // Cerrar sus pestañas (sin borrar nada en disco).
          const remaining = tabsRef.current.filter((t) => !isInside(t.path, path));
          tabsRef.current = remaining;
          setTabs(remaining);
          setActive((a) => (a && isInside(a, path) ? remaining[remaining.length - 1]?.path ?? null : a));
          await applySolution(await api.solutionRemoveProject(sol.file, path));
          log(t("Proyecto quitado de la solución: {0}", basename(path)), "muted");
        } else if (action === "edit-file" && sol) {
          await openFile(sol.file);
        } else if (action === "save-as" && project) {
          // Convertir la carpeta abierta en una solución con sus proyectos.
          const file = await save({
            title: t("Guardar como solución"),
            defaultPath: await join(project, `${basename(project)}.rxsln`),
            filters: [{ name: t("Solución de Raxorin Studio"), extensions: ["rxsln"] }],
          });
          if (!file) return;
          const name = basename(file).replace(/\.rxsln$/, "");
          // Un proyecto por workspace de Cargo (sus miembros se detectan solos).
          const dirs = [...new Set(projectsRef.current.map((p) => dirname(p.workspaceManifest)))];
          const created = await api.solutionCreate(dirname(file), name, dirs);
          if (startupRef.current) await api.solutionSetStartup(created, startupRef.current);
          log(t("Solución creada: {0}", created), "success");
          await openSolution(created);
        }
      } catch (e) {
        log(tErr(e), "error");
      }
    },
    [applySolution, openFile, openSolution, project, log],
  );

  // ---------- Compilar / ejecutar ----------
  const runTask = useCallback(
    async (task: Task, publish?: { dir: string; opts: PublishOptions }) => {
      if (!project) {
        log(t("Abre o crea un proyecto primero."), "warning");
        return;
      }
      if (!startupProject) {
        log(t("No hay un proyecto de inicio. Crea uno o elígelo en la barra de herramientas."), "warning");
        return;
      }
      if (running) return;
      if (debugActive) {
        log(t("Hay una sesión de depuración en curso. Detenla primero (Shift+F5)."), "warning");
        return;
      }
      try {
        await saveAll(); // como VS: guardar todo antes de compilar
      } catch {
        return;
      }
      setOutput([]);
      setBuildDiagnostics([]);
      setBottomTab("output");
      setRunning(task);
      const target = publish ? projects.find((p) => p.dir === publish.dir) ?? startupProject : startupProject;
      if (projects.length > 1 || publish) log(`Proyecto: ${target.name}`, "muted");
      if (task === "publish") log(t("Publicando en modo Release (optimizado)…"), "muted");
      else if (buildConfig === "release" && task !== "debug") log(t("Configuración: Release (optimizado)"), "muted");
      // Como en Visual Studio, "sin depurar" no se detiene en los puntos: avisarlo.
      const bps = bpStore.all().filter((b) => b.enabled && isInside(b.path, startupProject.dir)).length;
      if (task === "run" && bps > 0) {
        log(t("Aviso: tienes {0} punto(s) de interrupción, pero “Sin depurar” los ignora. Para que se detenga usa ▶ Depurar (F5).", bps), "warning");
      }
      try {
        await api.startTask(target.dir, task, task === "run" && runExternal, buildConfig === "release", publish?.opts ?? null);
      } catch (err) {
        setRunning(null);
        log(tErr(err), "error");
      }
    },
    [project, startupProject, projects, running, saveAll, log, runExternal, debugActive, bpStore, buildConfig],
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
    api.stopTask().catch((e) => log(tErr(e), "error"));
  }, [log]);

  const sendStdin = useCallback(
    (text: string) => {
      append({ text: text + "\n", kind: "input" });
      const send = debugActive ? api.debugStdinWrite(text) : api.sendStdin(text);
      send.catch((e) => log(tErr(e), "error"));
    },
    [append, log, debugActive],
  );

  /** F5: iniciar depuración (o continuar si está detenido), como en Visual Studio. */
  const startDebug = useCallback(async (target?: { path: string; line: number }) => {
    // Solo aceptar una ubicación real (no, por ejemplo, el evento de un clic).
    const runTo = target && typeof target.path === "string" && Number.isInteger(target.line) ? target : undefined;
    if (debugSnap.status === "stopped") return runTo ? debug.runToCursor(runTo.path, runTo.line) : debug.continue();
    if (debugActive || running) return;
    if (!startupProject) return log(t("No hay un proyecto de inicio para depurar."), "warning");
    if (startupProject.kind !== "bin") return log(t("Solo se pueden depurar aplicaciones, no bibliotecas."), "warning");
    const info = debuggerInfo ?? (await api.debuggerInfo().catch(() => null));
    setDebuggerInfo(info);
    if (!info?.adapter) {
      log(t("No se encontró el depurador (lldb-dap)."), "warning");
      log("  macOS: ejecuta `xcode-select --install` · Linux: instala `lldb` (sudo apt install lldb) · Windows: instala LLVM.", "muted");
      return;
    }
    if (runExternal) log(t("Al depurar, el programa usa el panel de salida (la entrada se escribe abajo)."), "muted");
    pendingRunTo.current = runTo ?? null;
    await runTask("debug");
  }, [debugSnap.status, debug, debugActive, running, startupProject, debuggerInfo, runExternal, runTask, log]);

  const format = useCallback(() => {
    editorRef.current?.getAction("editor.action.formatDocument")?.run();
  }, []);

  // Al compilar, ejecutar o depurar, mostrar el panel inferior si estaba oculto.
  useEffect(() => {
    if (running || debugActive) setBottomVisible(true);
  }, [running, debugActive, setBottomVisible]);

  // ---------- Archivo: nuevo, abrir, guardar como, cerrar ----------

  const curTab = tabs.find((t) => t.path === active) ?? null;

  /** Si hay cambios sin guardar, ofrece guardarlos antes de cerrar o cambiar de carpeta. */
  const offerSaveAll = useCallback(async () => {
    const dirty = tabsRef.current.filter((t) => t.content !== t.saved);
    if (!dirty.length) return;
    const yes = await ask(
      dirty.length === 1
        ? t("“{0}” tiene cambios sin guardar. ¿Guardarlos?", dirty[0].name)
        : t("Hay {0} archivos con cambios sin guardar. ¿Guardarlos?", dirty.length),
      { title: t("Cambios sin guardar"), kind: "warning", okLabel: t("Guardar"), cancelLabel: t("No guardar") },
    );
    if (yes) await saveAll();
  }, [saveAll]);

  /** Carpeta donde proponer un archivo nuevo: la del archivo activo o src del proyecto de inicio. */
  const suggestDir = useCallback(async () => {
    if (active) return dirname(active);
    if (startupProject) return join(startupProject.dir, "src");
    return project ?? undefined;
  }, [active, startupProject, project]);

  const newFile = useCallback(async () => {
    const dir = await suggestDir();
    const path = await save({ title: t("Nuevo archivo"), defaultPath: dir ? await join(dir, "nuevo.rs") : "nuevo.rs" });
    if (!path) return;
    try {
      await api.createFile(path);
      await openFile(path);
      log(`Archivo creado: ${path}`, "success");
    } catch (e) {
      log(tErr(e), "error");
    }
  }, [suggestDir, openFile, log]);

  const openFileDialog = useCallback(async () => {
    const picked = await open({ title: t("Abrir archivo"), multiple: true, defaultPath: (await suggestDir()) ?? undefined });
    const files = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const f of files) {
      if (f.endsWith(".rxsln")) await askOpenSolution(f);
      else await openFile(f);
    }
  }, [suggestDir, openFile, askOpenSolution]);

  /** Guardar como: escribe el archivo nuevo y la pestaña pasa a ser la del archivo nuevo (como en Visual Studio). */
  const saveAs = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.path === active);
    if (!tab) return;
    const target = await save({ title: t("Guardar como"), defaultPath: tab.path });
    if (!target) return;
    if (target === tab.path) return saveTab(tab).catch(() => {});
    const content = monaco.editor.getModel(monaco.Uri.file(tab.path))?.getValue() ?? tab.content;
    try {
      await api.writeFile(target, content);
    } catch (e) {
      return log(tErr(e), "error");
    }
    // Si el destino ya estaba abierto, se reemplaza por el contenido nuevo.
    const drop = [tab.path, target];
    const remaining = tabsRef.current.filter((t) => !drop.includes(t.path));
    tabsRef.current = remaining;
    setTabs(remaining);
    for (const p of drop) monaco.editor.getModel(monaco.Uri.file(p))?.dispose();
    await openFile(target);
    log(t("Guardado como: {0}", target), "success");
  }, [active, saveTab, openFile, log]);

  const closeAllTabs = useCallback(async () => {
    await offerSaveAll();
    for (const t of tabsRef.current) monaco.editor.getModel(monaco.Uri.file(t.path))?.dispose();
    tabsRef.current = [];
    setTabs([]);
    setActive(null);
  }, [offerSaveAll]);

  /** Cierra la carpeta o solución y vuelve a la pantalla de bienvenida. */
  const closeWorkspace = useCallback(async () => {
    if (!project) return;
    await offerSaveAll();
    resetWorkspace("");
    try {
      localStorage.removeItem(LAST_PROJECT_KEY);
    } catch {
      /* sin almacenamiento */
    }
    solutionRef.current = null;
    setSolution(null);
    setProject(null);
    setProjects([]);
    setStartupDir(null);
    log("Carpeta cerrada.", "muted");
  }, [project, offerSaveAll, resetWorkspace, log]);

  const openRecent = useCallback(
    async (path: string) => {
      await offerSaveAll();
      (path.endsWith(".rxsln") ? openSolution(path) : openProject(path)).catch((e) => {
        log(t("No se pudo abrir {0}: {1}", path, tErr(e)), "error");
        setRecent((r) => r.filter((x) => x !== path));
      });
    },
    [offerSaveAll, openSolution, openProject, log],
  );

  const clearRecent = useCallback(() => {
    setRecent([]);
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {
      /* sin almacenamiento */
    }
  }, []);

  /** Ejecuta una acción del editor de Monaco (deshacer, buscar…). */
  const editorAction = (id: string) => () => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    if (id === "undo" || id === "redo") ed.trigger("menu", id, null);
    else ed.getAction(id)?.run();
  };

  // Guardar: si está activado, formatear antes con rustfmt.
  const saveCurrent = useCallback(async () => {
    const t = tabsRef.current.find((x) => x.path === active);
    if (!t) return;
    const ed = editorRef.current;
    if (getSettings().formatOnSave && lspReady && t.path.endsWith(".rs") && ed?.getModel()?.uri.toString() === monaco.Uri.file(t.path).toString()) {
      await ed.getAction("editor.action.formatDocument")?.run().catch(() => {});
      const content = ed.getModel()!.getValue();
      return saveTab({ ...t, content }).catch(() => {});
    }
    if (t.content !== t.saved) await saveTab(t).catch(() => {});
  }, [active, lspReady, saveTab]);

  // Guardado automático: un segundo después del último cambio.
  useEffect(() => {
    if (!settings.autoSave || !tabs.some((t) => t.content !== t.saved)) return;
    const id = setTimeout(() => {
      for (const t of tabsRef.current) if (t.content !== t.saved) saveTab(t).catch(() => {});
    }, 1000);
    return () => clearTimeout(id);
  }, [tabs, settings.autoSave, saveTab]);

  // Avisar al cerrar la ventana con archivos sin guardar.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (e) => {
      const dirty = tabsRef.current.filter((t) => t.content !== t.saved);
      if (!dirty.length || !getSettings().confirmUnsaved) return;
      e.preventDefault();
      const yes = await ask(
        dirty.length === 1
          ? t("Hay cambios sin guardar en “{0}”. ¿Guardar antes de salir?", dirty[0].name)
          : t("Hay {0} archivos sin guardar. ¿Guardar antes de salir?", dirty.length),
        { title: t("Salir de Raxorin Studio"), kind: "warning", okLabel: t("Guardar y salir"), cancelLabel: t("Salir sin guardar") },
      );
      if (yes) {
        for (const t of tabsRef.current) if (t.content !== t.saved) await saveTab(t).catch(() => {});
      }
      await getCurrentWindow().destroy();
    });
    return () => {
      un.then((f) => f());
    };
  }, [saveTab]);

  const recentLabel = (p: string) => (p.endsWith(".rxsln") ? basename(p).replace(/\.rxsln$/, "") : basename(p));
  const noTask = !project || running !== null || !startupProject;
  const hasEditor = !!curTab;

  const menus: Menu[] = [
    {
      label: t("Archivo"),
      items: [
        { label: t("Nuevo proyecto o solución…"), icon: "new-folder", shortcut: "Mod+Shift+N", onClick: () => setShowNew(true) },
        { label: t("Nuevo archivo…"), icon: "new-file", shortcut: "Mod+N", onClick: newFile, disabled: !project },
        { label: t("Ejemplos…"), icon: "beaker", onClick: () => setShowSamples(true) },
        "sep",
        { label: t("Abrir archivo…"), icon: "go-to-file", shortcut: "Mod+O", onClick: openFileDialog },
        { label: t("Abrir carpeta…"), icon: "folder-opened", onClick: () => void offerSaveAll().then(openFolder) },
        { label: t("Abrir solución…"), icon: "layers", onClick: () => void offerSaveAll().then(openSolutionDialog) },
        {
          label: t("Abrir reciente"),
          icon: "history",
          submenu: recent.length
            ? [
                ...recent.map((p) => ({
                  label: recentLabel(p),
                  icon: p.endsWith(".rxsln") ? "layers" : "folder",
                  hint: dirname(p),
                  onClick: () => void openRecent(p),
                })),
                "sep" as const,
                { label: t("Borrar la lista"), icon: "clear-all", onClick: clearRecent },
              ]
            : [],
        },
        "sep",
        { label: t("Guardar"), icon: "save", shortcut: "Mod+S", onClick: saveCurrent, disabled: !curTab || (curTab.content === curTab.saved && !settings.formatOnSave) },
        { label: t("Guardar como…"), icon: "save-as", shortcut: "Mod+Shift+S", onClick: saveAs, disabled: !curTab },
        { label: t("Guardar todo"), icon: "save-all", shortcut: "Mod+Alt+S", onClick: () => void saveAll(), disabled: !tabs.some((t) => t.content !== t.saved) },
        "sep",
        { label: t("Cerrar pestaña"), icon: "close", onClick: () => active && void closeTab(active), disabled: !curTab },
        { label: t("Cerrar todas las pestañas"), icon: "close-all", onClick: () => void closeAllTabs(), disabled: !tabs.length },
        { label: solution ? t("Cerrar solución") : t("Cerrar carpeta"), icon: "folder", onClick: () => void closeWorkspace(), disabled: !project },
        "sep",
        { label: t("Configuración…"), icon: "settings-gear", shortcut: "Mod+,", onClick: () => setSettingsOpen(true) },
        { label: t("Salir"), icon: "sign-out", onClick: () => void getCurrentWindow().close() },
      ],
    },
    {
      label: t("Editar"),
      items: [
        { label: t("Deshacer"), icon: "discard", shortcut: "Mod+Z", onClick: editorAction("undo"), disabled: !hasEditor },
        { label: t("Rehacer"), icon: "redo", shortcut: "Mod+Shift+Z", onClick: editorAction("redo"), disabled: !hasEditor },
        "sep",
        { label: t("Buscar"), icon: "search", shortcut: "Mod+F", onClick: editorAction("actions.find"), disabled: !hasEditor },
        { label: t("Reemplazar"), icon: "replace", onClick: editorAction("editor.action.startFindReplaceAction"), disabled: !hasEditor },
        { label: t("Ir a la línea…"), icon: "go-to-file", shortcut: "Ctrl+G", onClick: editorAction("editor.action.gotoLine"), disabled: !hasEditor },
        "sep",
        { label: t("Comentar / descomentar línea"), icon: "comment", shortcut: "Mod+/", onClick: editorAction("editor.action.commentLine"), disabled: !hasEditor },
        { label: t("Formatear documento"), icon: "wand", shortcut: "Shift+Alt+F", onClick: format, disabled: !curTab || !lspReady || !curTab.path.endsWith(".rs") },
      ],
    },
    {
      label: t("Ver"),
      items: [
        { label: t("Explorador"), checked: sidebarVisible, shortcut: "Mod+B", onClick: () => setSidebarVisible((v) => !v) },
        { label: t("Panel inferior"), checked: bottomVisible, shortcut: "Mod+J", onClick: () => setBottomVisible((v) => !v) },
        { label: t("Herramientas de diagnóstico"), checked: diagOpen, onClick: () => setDiagOpen((o) => !o) },
        { label: t("Chat con IA"), checked: aiOpen, shortcut: "Mod+Shift+I", onClick: () => setAiOpen((o) => !o) },
        "sep",
        { label: t("Salida"), icon: "output", onClick: () => { setBottomVisible(true); setBottomTab("output"); } },
        { label: t("Lista de errores"), icon: "list-unordered", onClick: () => { setBottomVisible(true); setBottomTab("errors"); } },
        { label: t("Terminal"), icon: "terminal", shortcut: "Ctrl+`", onClick: () => { setBottomVisible(true); setBottomTab("terminal"); } },
        { label: t("Puntos de interrupción"), icon: "circle-filled", onClick: () => { setBottomVisible(true); setBottomTab("breakpoints"); } },
        "sep",
        {
          label: t("Tema"),
          icon: "color-mode",
          submenu: [
            { label: t("Oscuro"), checked: themePref === "dark", onClick: () => setThemePref("dark") },
            { label: t("Claro"), checked: themePref === "light", onClick: () => setThemePref("light") },
            { label: t("Según el sistema"), checked: themePref === "system", onClick: () => setThemePref("system") },
          ],
        },
        { label: t("Personalizar barra de herramientas…"), icon: "settings", onClick: () => setCustomizeOpen(true) },
        { label: t("Restablecer tamaños de los paneles"), icon: "discard", onClick: resetLayout },
      ],
    },
    {
      label: t("Proyecto"),
      items: [
        { label: t("Compilar"), icon: "tools", shortcut: "Mod+Shift+B", onClick: () => runTask("build"), disabled: noTask },
        { label: t("Revisar con Clippy"), icon: "check-all", onClick: () => runTask("check"), disabled: noTask },
        { label: t("Ejecutar pruebas"), icon: "beaker", onClick: () => runTask("test"), disabled: noTask },
        { label: t("Ejecutar sin depurar"), icon: "play-circle", shortcut: "Mod+F5", onClick: () => runTask("run"), disabled: noTask },
        { label: t("Detener"), icon: "debug-stop", shortcut: "Shift+F5", onClick: stop, disabled: running === null },
        "sep",
        {
          label: t("Configuración"),
          icon: "settings",
          submenu: [
            { label: t("Debug (rápido de compilar, para probar)"), checked: buildConfig === "debug", onClick: () => setBuildConfig("debug") },
            { label: t("Release (optimizado, para entregar)"), checked: buildConfig === "release", onClick: () => setBuildConfig("release") },
          ],
        },
        { label: t("Publicar…"), icon: "package", onClick: () => setPublishOpen(true), disabled: !project || running !== null || !projects.some((p) => p.kind === "bin") },
        "sep",
        { label: t("Administrar paquetes…"), icon: "package", onClick: () => startupDir && setPackagesFor(startupDir), disabled: !startupProject },
        {
          label: t("Proyecto de inicio"),
          icon: "rocket",
          submenu: projects.map((p) => ({ label: p.name, checked: p.dir === startupDir, onClick: () => setStartup(p.dir) })),
        },
      ],
    },
    {
      label: t("Depurar"),
      items: [
        { label: debugActive ? t("Continuar") : t("Iniciar depuración"), icon: "debug-start", shortcut: "F5", onClick: () => (debugActive ? debug.continue() : void startDebug()), disabled: !debugActive && (noTask || startupProject?.kind !== "bin") },
        { label: t("Detener depuración"), icon: "debug-stop", shortcut: "Shift+F5", onClick: () => void debug.stop(), disabled: !debugActive },
        { label: t("Reiniciar"), icon: "debug-restart", shortcut: "Mod+Shift+F5", onClick: () => void debug.restart(), disabled: !debugActive },
        "sep",
        { label: t("Paso a paso por procedimientos"), icon: "debug-step-over", shortcut: "F10", onClick: debug.stepOver, disabled: debugSnap.status !== "stopped" },
        { label: t("Paso a paso por instrucciones"), icon: "debug-step-into", shortcut: "F11", onClick: debug.stepInto, disabled: debugSnap.status !== "stopped" },
        { label: t("Paso a paso para salir"), icon: "debug-step-out", shortcut: "Shift+F11", onClick: debug.stepOut, disabled: debugSnap.status !== "stopped" },
        "sep",
        { label: t("Alternar punto de interrupción"), icon: "circle-filled", shortcut: "F9", onClick: toggleBreakpointAtCursor, disabled: !curTab?.path.endsWith(".rs") },
        { label: t("Nuevo punto de interrupción…"), icon: "add", onClick: () => { const loc = cursorLocation(); setBpDraft({ path: loc?.path ?? "", line: loc?.line ?? 1 }); }, disabled: !project },
      ],
    },
    {
      label: t("Git"),
      items: git.status?.repo
        ? [
            { label: t("Confirmar cambios (commit)…"), icon: "check", shortcut: "Mod+Shift+G", onClick: () => showGit("commit") },
            "sep",
            { label: t("Pull (bajar cambios)"), icon: "arrow-down", onClick: () => void git.ops.pull(), disabled: !git.status.remotes.length || !!git.busy },
            { label: t("Push (subir commits)"), icon: "arrow-up", onClick: () => void git.ops.push(), disabled: !git.status.remotes.length || !git.status.hasCommits || !!git.busy },
            { label: t("Fetch (traer sin combinar)"), icon: "cloud-download", onClick: () => void git.ops.fetch(), disabled: !git.status.remotes.length || !!git.busy },
            "sep",
            { label: t("Nueva rama…"), icon: "git-branch", onClick: () => showGit("new-branch"), disabled: !git.status.hasCommits },
            { label: t("Cambiar de rama…"), icon: "git-compare", onClick: () => showGit("branches") },
            "sep",
            { label: t("Guardar cambios temporalmente (stash)"), icon: "archive", onClick: () => void git.ops.stash(false), disabled: !git.status.files.length },
            { label: t("Recuperar cambios guardados"), icon: "unarchive", onClick: () => void git.ops.stash(true) },
            "sep",
            githubUrl(git.status.remotes[0]?.url)
              ? { label: t("Abrir en GitHub"), icon: "github", onClick: () => void openUrl(githubUrl(git.status!.remotes.find((r) => r.name === "origin")?.url ?? git.status!.remotes[0].url)!) }
              : { label: t("Publicar en GitHub…"), icon: "cloud-upload", onClick: () => setGhPublishOpen(true), disabled: !git.status.hasCommits || git.status.remotes.length > 0 },
            { label: t("Clonar repositorio…"), icon: "repo-clone", onClick: () => setCloneOpen(true) },
          ]
        : [
            { label: t("Inicializar repositorio"), icon: "repo", onClick: () => git.untrackedRoots[0] && void git.ops.init(git.untrackedRoots[0]), disabled: !git.untrackedRoots.length },
            { label: t("Clonar repositorio…"), icon: "repo-clone", onClick: () => setCloneOpen(true) },
          ],
    },
    {
      label: t("Ayuda"),
      items: [
        { label: t("Documentación"), icon: "book", shortcut: "F1", onClick: () => void openUrl(docsUrl()) },
        { label: t("Ejemplos…"), icon: "beaker", onClick: () => setShowSamples(true) },
        "sep",
        { label: t("Repositorio en GitHub"), icon: "github", onClick: () => void openUrl(GITHUB_URL) },
        { label: t("Reportar un problema"), icon: "bug", onClick: () => void openUrl(GITHUB_URL + "/issues/new") },
        { label: t("Licencia (MIT)"), icon: "law", onClick: () => setAboutOpen(true) },
        { label: t("Buscar actualizaciones…"), icon: "cloud-download", onClick: () => void updates.check(true) },
        { label: t("Herramientas necesarias…"), icon: "tools", onClick: () => setSetupOpen("manual") },
        { label: t("Conectar con IA (MCP)…"), icon: "plug", onClick: () => setMcpOpen(true) },
        "sep",
        { label: t("Acerca de Raxorin Studio"), icon: "info", onClick: () => setAboutOpen(true) },
      ],
    },
  ];

  // ---------- Atajos de teclado ----------
  const actions = useRef({ runTask, saveActive: saveCurrent, stop, startDebug, toggleBreakpointAtCursor, cursorLocation, openBreakpointDialog, newFile, openFileDialog, saveAs, saveAll, showGit: () => showGit(), showExplorer: () => { setSidebarVisible(true); setSideView("explorer"); } });
  actions.current = { runTask, saveActive: saveCurrent, stop, startDebug, toggleBreakpointAtCursor, cursorLocation, openBreakpointDialog, newFile, openFileDialog, saveAs, saveAll, showGit: () => showGit(), showExplorer: () => { setSidebarVisible(true); setSideView("explorer"); } };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      // Ctrl+` abre o cierra el terminal (como en VS Code).
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Backquote") {
        e.preventDefault();
        const showing = bottomVisibleRef.current && bottomTabRef.current === "terminal";
        if (showing) setBottomVisible(false);
        else {
          setBottomVisible(true);
          setBottomTab("terminal");
        }
        return;
      }
      // En el terminal, Ctrl+letra es del shell (Ctrl+C, Ctrl+R, Ctrl+B…). Cmd en macOS y las
      // teclas F siguen siendo atajos del IDE.
      const inTerminal = (e.target as HTMLElement | null)?.closest?.(".terminal-panel");
      if (inTerminal && e.ctrlKey && !e.metaKey && !/^F\d+$/.test(e.key)) return;
      let handled = true;
      const dbg = debug.getSnapshot().status;
      if (e.key === "F5" && mod && e.shiftKey) dbg !== "idle" ? debug.restart() : (handled = false);
      else if (e.key === "F5" && e.shiftKey) dbg !== "idle" ? debug.stop() : actions.current.stop();
      else if (e.key === "F5" && mod) actions.current.runTask("run");
      else if (e.key === "F5") actions.current.startDebug();
      else if (e.key === "F10" && mod) {
        const loc = actions.current.cursorLocation();
        if (loc) actions.current.startDebug(loc);
      }
      else if (e.key === "F9") actions.current.toggleBreakpointAtCursor();
      else if (e.key === "F6" && dbg === "running") debug.pause();
      else if (e.key === "F10" && dbg === "stopped") debug.stepOver();
      else if (e.key === "F11" && e.shiftKey && dbg === "stopped") debug.stepOut();
      else if (e.key === "F11" && dbg === "stopped") debug.stepInto();
      else if (mod && e.shiftKey && !e.altKey && key === "i") {
        e.preventDefault();
        setAiOpen((o) => !o);
      }
      else if (mod && e.shiftKey && key === "b") actions.current.runTask("build");
      else if (mod && e.altKey && !e.shiftKey && (key === "s" || e.code === "KeyS")) void actions.current.saveAll();
      else if (mod && e.shiftKey && !e.altKey && key === "s") void actions.current.saveAs();
      else if (mod && !e.shiftKey && key === "s") actions.current.saveActive();
      else if (mod && e.shiftKey && !e.altKey && key === "n") setShowNew(true);
      else if (mod && !e.shiftKey && !e.altKey && key === "n") void actions.current.newFile();
      else if (mod && !e.shiftKey && !e.altKey && key === "o") void actions.current.openFileDialog();
      else if (mod && !e.shiftKey && !e.altKey && key === ",") setSettingsOpen(true);
      else if (e.key === "F1" && !mod) void openUrl(docsUrl());
      else if (mod && e.shiftKey && !e.altKey && key === "g") actions.current.showGit();
      else if (mod && e.shiftKey && !e.altKey && key === "e") actions.current.showExplorer();
      else if (mod && !e.shiftKey && !e.altKey && key === "b") setSidebarVisible((v) => !v);
      else if (mod && !e.shiftKey && !e.altKey && key === "j") setBottomVisible((v) => !v);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debug]);

  // Doble clic en un .rxsln con la app ya abierta (macOS).
  const openPathRef = useRef<(p: string) => void>(() => {});
  openPathRef.current = (p: string) => {
    api.takePendingOpen().catch(() => null);
    (p.endsWith(".rxsln") ? openSolution(p) : openProject(p)).catch((e) => log(tErr(e), "error"));
  };
  useEffect(() => {
    const un = listen<string>("open-path", (e) => openPathRef.current(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ---------- Inicio ----------
  useEffect(() => {
    // macOS: abierta desde el .dmg (o desde Descargas): ofrecer moverla a Aplicaciones.
    api
      .appLocation()
      .then(async (loc) => {
        if (!loc.needsMove) return;
        const yes = await ask(
          loc.reason === "dmg"
            ? t("Raxorin Studio se está ejecutando desde el instalador (.dmg), así que no está instalada: no aparece en Aplicaciones ni en Launchpad, se cierra al expulsar el disco y no se puede actualizar.\n\n¿La muevo a la carpeta Aplicaciones? Se volverá a abrir desde allí.")
            : t("Raxorin Studio no está en la carpeta Aplicaciones, así que macOS la ejecuta desde una copia temporal y no se puede actualizar.\n\n¿La muevo a la carpeta Aplicaciones? Se volverá a abrir desde allí."),
          { title: t("Instalar Raxorin Studio"), kind: "info", okLabel: t("Mover a Aplicaciones"), cancelLabel: t("Ahora no") },
        );
        if (yes) await api.moveToApplications().catch((e) => void message(tErr(e), { title: t("No se pudo mover"), kind: "error" }));
      })
      .catch(() => {});
    refreshToolchain();
    // Si falta algo imprescindible (Rust o el compilador de C/C++), abrir el asistente.
    api
      .setupStatus()
      .then((tools) => tools.some((t) => t.required && !t.installed && !t.unavailable) && setSetupOpen("first"))
      .catch(() => {});
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      /* sin almacenamiento */
    }
    // Si la app se abrió con un .rxsln (doble clic en Finder/Explorador), abrirlo a él.
    api
      .takePendingOpen()
      .catch(() => null)
      .then((pending) => {
        const target = pending ?? (getSettings().reopenLast ? last : null);
        if (target) (target.endsWith(".rxsln") ? openSolution(target) : openProject(target)).catch((e) => log(tErr(e), "error"));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    // Clic en el margen izquierdo = poner/quitar punto de interrupción.
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const model = editor.getModel();
      const line = e.target.position?.lineNumber;
      if (model && line && model.uri.scheme === "file") bpStore.toggle(model.uri.fsPath, line);
    });
    // Al pasar el mouse por el margen se ve un punto tenue: ahí se pone el punto de interrupción.
    const hint = editor.createDecorationsCollection();
    editor.onMouseMove((e) => {
      const model = editor.getModel();
      const line = e.target.position?.lineNumber;
      const inGutter =
        e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
      if (!inGutter || !model || !line || model.uri.scheme !== "file" || !model.uri.path.endsWith(".rs") || bpStore.get(model.uri.fsPath, line)) {
        hint.clear();
        return;
      }
      hint.set([
        {
          range: new monaco.Range(line, 1, line, 1),
          options: {
            glyphMarginClassName: "bp-glyph hint",
            glyphMarginHoverMessage: { value: t("Clic: agregar punto de interrupción · Clic derecho: condicional o mensaje") },
          },
        },
      ]);
    });
    editor.onMouseLeave(() => hint.clear());
    // Clic derecho en el margen = elegir el tipo de punto (condicional, por vuelta, mensaje).
    editor.onContextMenu((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const model = editor.getModel();
      const line = e.target.position?.lineNumber;
      if (model && line && model.uri.scheme === "file") actions.current.openBreakpointDialog(model.uri.fsPath, line);
    });
    // Menú contextual del editor (clic derecho sobre el código).
    const isRust = () => editor.getModel()?.uri.path.endsWith(".rs") ?? false;
    const addBp = (id: string, label: string, order: number, kind?: BreakpointDraft["kind"]) =>
      editor.addAction({
        id,
        label,
        contextMenuGroupId: "0_debug",
        contextMenuOrder: order,
        run: () => {
          const loc = actions.current.cursorLocation();
          if (loc && isRust()) actions.current.openBreakpointDialog(loc.path, loc.line, kind);
        },
      });
    addBp("raxorin.bp.add", t("Agregar punto de interrupción…"), 1);
    addBp("raxorin.bp.cond", t("Agregar punto de interrupción condicional…"), 2, "condition");
    addBp("raxorin.bp.log", t("Agregar punto de registro (mensaje sin detenerse)…"), 3, "log");
    // Como "Agregar inspección" de Visual Studio: la selección o la variable bajo el cursor.
    editor.addAction({
      id: "raxorin.addWatch",
      label: t("Agregar a Inspección"),
      contextMenuGroupId: "0_debug",
      contextMenuOrder: 0,
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F9],
      run: () => {
        const model = editor.getModel();
        const sel = editor.getSelection();
        const pos = editor.getPosition();
        if (!model || !pos) return;
        let expr = sel && !sel.isEmpty() ? model.getValueInRange(sel).trim() : "";
        if (!expr) {
          // Variable bajo el cursor, incluyendo campos: `punto.x`
          const line = model.getLineContent(pos.lineNumber);
          const re = /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(line))) {
            if (pos.column >= m.index + 1 && pos.column <= m.index + 1 + m[0].length) expr = m[0];
          }
        }
        if (!expr) return;
        debug.addWatch(expr);
        if (debug.active) setBottomTab("debug");
        log(`Inspeccionando: ${expr}`, "muted");
      },
    });
    editor.addAction({
      id: "raxorin.runToCursor",
      label: t("Ejecutar hasta el cursor"),
      contextMenuGroupId: "0_debug",
      contextMenuOrder: 4,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F10],
      run: () => {
        const loc = actions.current.cursorLocation();
        if (loc && isRust()) actions.current.startDebug(loc);
      },
    });
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
      <MenuBar menus={menus} />
      <Toolbar
        aiOpen={aiOpen}
        onToggleAi={() => setAiOpen((o) => !o)}
        onTerminal={() => {
          setBottomVisible(true);
          setBottomTab("terminal");
        }}
        onGit={() => showGit()}
        hasProject={!!project}
        running={running}
        canSave={!!activeTab && activeTab.content !== activeTab.saved}
        canSaveAll={tabs.some((t) => t.content !== t.saved)}
        onSaveAll={() => void saveAll()}
        onSettings={() => setSettingsOpen(true)}
        buildConfig={buildConfig}
        onBuildConfig={setBuildConfig}
        onPublish={() => setPublishOpen(true)}
        canFormat={!!activeTab && lspReady && activeTab.path.endsWith(".rs")}
        onNew={() => setShowNew(true)}
        onOpen={openFolder}
        onOpenSolution={openSolutionDialog}
        onSave={() => void saveCurrent()}
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
        debugStatus={debugSnap.status}
        debugAvailable={!!debuggerInfo?.adapter}
        onDebug={() => void startDebug()}
        onContinue={debug.continue}
        onPause={debug.pause}
        onStepOver={debug.stepOver}
        onStepInto={debug.stepInto}
        onStepOut={debug.stepOut}
        onRestart={() => void debug.restart()}
        onDebugStop={() => void debug.stop()}
        diagOpen={diagOpen}
        onToggleDiag={() => setDiagOpen((o) => !o)}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        bottomVisible={bottomVisible}
        onToggleBottom={() => setBottomVisible((v) => !v)}
        onCustomize={() => setCustomizeOpen(true)}
      />
      {customizeOpen && <ToolbarCustomize onClose={() => setCustomizeOpen(false)} />}
      {settingsOpen && (
        <SettingsDialog
          runExternal={runExternal}
          onRunExternal={changeRunMode}
          onCheckUpdates={() => {
            setSettingsOpen(false);
            void updates.check(true);
          }}
          onCustomizeToolbar={() => {
            setSettingsOpen(false);
            setCustomizeOpen(true);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {aboutOpen && (
        <AboutDialog
          onClose={() => setAboutOpen(false)}
          onCheckUpdates={() => {
            setAboutOpen(false);
            void updates.check(true);
          }}
        />
      )}
      <UpdateDialog u={updates} />
      {setupOpen && (
        <SetupDialog
          firstRun={setupOpen === "first"}
          busy={running !== null && !running.startsWith("setup:")}
          onInstall={async (id) => {
            if (running && !running.startsWith("setup:")) return false;
            setBottomVisible(true);
            setBottomTab("output");
            setRunning(`setup:${id}`);
            try {
              await api.startTask(".", `setup:${id}`);
              return true;
            } catch (e) {
              setRunning(null);
              log(tErr(e), "error");
              return false;
            }
          }}
          onChanged={() => {
            void refreshToolchain();
            // Un depurador recién instalado (p. ej. CodeLLDB) se usa en la próxima depuración.
            api.debuggerInfo().then(setDebuggerInfo).catch(() => {});
          }}
          onClose={() => setSetupOpen(null)}
        />
      )}
      {cloneOpen && (
        <CloneDialog
          defaultParent={homeProjects}
          onCloned={(dir) => {
            log(t("Repositorio clonado en {0}", dir), "success");
            void offerSaveAll().then(() => openProject(dir));
          }}
          onClose={() => setCloneOpen(false)}
        />
      )}
      {ghPublishOpen && (
        <PublishGitHubDialog
          defaultName={solution?.name ?? basename(git.repo ?? project ?? t("proyecto"))}
          onPublish={(name, priv, desc) => git.ops.publishGitHub(name, priv, desc)}
          onClose={() => setGhPublishOpen(false)}
        />
      )}
      {publishOpen && (
        <PublishDialog
          projects={projects}
          startup={startupProject}
          solution={solution ? { name: solution.name, dir: solution.dir } : null}
          workspace={project}
          onShowGit={() => {
            setPublishOpen(false);
            showGit();
          }}
          log={log}
          onPublish={(dir, opts) => void runTask("publish", { dir, opts })}
          onSetupTarget={(dir, target) => void runTask("setup-target", { dir, opts: { outDir: "", target, zip: false, open: false } })}
          onClose={() => setPublishOpen(false)}
        />
      )}
      <ToolchainBanner status={toolchain} onInstall={installComponents} />
      <div className="main">
        {sidebarVisible && (
        <>
        <aside className="sidebar" style={{ width: sidebarSize.size }}>
          <div className="side-tabs" role="tablist">
            <button role="tab" aria-selected={sideView === "explorer"} className={sideView === "explorer" ? "active" : ""} onClick={() => setSideView("explorer")} title={t("Explorador (Ctrl/⌘+Shift+E)")}>
              <Codicon name="files" /> {" "}{t("Explorador")}
            </button>
            <button role="tab" aria-selected={sideView === "git"} className={sideView === "git" ? "active" : ""} onClick={() => setSideView("git")} title={t("Git: cambios, commits y ramas (Ctrl/⌘+Shift+G)")}>
              <Codicon name="source-control" /> {" "}{t("Git")}
              {!!git.status?.files.length && <span className="count">{git.status.files.length}</span>}
            </button>
          </div>
          {sideView === "git" ? (
            <GitPanel
              git={git}
              onOpenFile={(p) => void openFile(p)}
              onDiff={(repo, file, staged) => setDiffReq({ repo, file, staged })}
              onClone={() => setCloneOpen(true)}
              onPublishGitHub={() => setGhPublishOpen(true)}
              intent={gitIntent}
              onIntentDone={() => setGitIntent(null)}
            />
          ) : (
          <Explorer
            gitDecorations={git.decorations}
            roots={roots}
            solution={solution ? { name: solution.name, file: solution.file } : null}
            storageKey={workspaceKey}
            onSolution={onSolutionAction}
            activePath={active}
            problems={problems}
            onOpenFile={(path) => (path.endsWith(".rxsln") && path !== solution?.file ? askOpenSolution(path) : openFile(path))}
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
          )}
        </aside>
        <Splitter spec={PANELS.sidebar} panel="before" size={sidebarSize.size} onResize={sidebarSize.set} onReset={sidebarSize.reset} />
        </>
        )}
        <div className="center">
          {diffReq ? (
            <DiffView
              req={diffReq}
              onClose={() => setDiffReq(null)}
              onOpenFile={(p) => {
                setDiffReq(null);
                void openFile(p);
              }}
            />
          ) : project ? (
            <EditorArea
              tabs={tabs}
              active={active}
              onSelect={setActive}
              onClose={closeTab}
              onReorder={(from, to) => {
                const next = [...tabsRef.current];
                const [moved] = next.splice(from, 1);
                next.splice(to, 0, moved);
                tabsRef.current = next;
                setTabs(next);
              }}
              onNewFile={() => void newFile()}
              onMount={onEditorMount}
              designer={designerHost}
            />
          ) : (
            <Welcome
              onNew={() => setShowNew(true)}
              onOpen={openFolder}
              onOpenSolution={openSolutionDialog}
              onSamples={() => setShowSamples(true)}
            />
          )}
          {bottomVisible && (
          <>
          <Splitter spec={PANELS.bottom} panel="after" size={bottomSize.size} onResize={bottomSize.set} onReset={bottomSize.reset} />
          <BottomPanel
            height={bottomSize.size}
            onHide={() => setBottomVisible(false)}
            tab={bottomTab}
            setTab={setBottomTab}
            output={output}
            diagnostics={diagnostics}
            running={running}
            project={project}
            onClear={() => setOutput([])}
            onStdin={sendStdin}
            onGoto={gotoDiagnostic}
            acceptsInput={running === "run" || (debugActive && debugSnap.stdin)}
            debugActive={debugActive}
            debugContent={<DebugPanel ctl={debug} snap={debugSnap} root={project} />}
            consoleContent={
              <DebugConsole ctl={debug} entries={consoleEntries} setEntries={setConsoleEntries} stopped={debugSnap.status === "stopped"} />
            }
            terminalContent={
              <TerminalPanel cwd={project} visible={bottomTab === "terminal"} fontSize={Math.max(10, settings.fontSize - 1)} />
            }
            breakpointsContent={
              <BreakpointsPanel
                key={bpVersion}
                store={bpStore}
                root={project}
                onOpen={(b) => openFile(b.path).then(() => setReveal({ path: b.path, line: b.line, column: 1 }))}
                onAdd={() => {
                  const loc = cursorLocation();
                  const fallback = startupProject ? joinPath(joinPath(startupProject.dir, "src"), "main.rs") : "";
                  setBpDraft({ path: loc?.path.endsWith(".rs") ? loc.path : fallback, line: loc?.line ?? 1 });
                }}
                onEdit={(b) => setBpDraft({ path: b.path, line: b.line, existing: b })}
              />
            }
            breakpointCount={bpStore.all().length}
          />
          </>
          )}
        </div>
        {aiOpen && (
          <>
            <Splitter spec={PANELS.ai} panel="after" size={aiSize.size} onResize={aiSize.set} onReset={aiSize.reset} />
            <Suspense fallback={<aside className="ai-panel" style={{ width: aiSize.size }} />}>
            <ChatPanel
              width={aiSize.size}
              getContext={chatContext}
              onFileChanged={(p) => void reloadFromDisk([p])}
              onOpenFile={(p) => void openFile(p)}
              onClose={() => setAiOpen(false)}
              onRunInTerminal={(command) => {
                runInTerminal(project, command, Math.max(10, settings.fontSize - 1));
                setBottomVisible(true);
                setBottomTab("terminal");
              }}
            />
            </Suspense>
          </>
        )}
        {diagOpen && (
          <>
            <Splitter spec={PANELS.diagnostics} panel="after" size={diagSize.size} onResize={diagSize.set} onReset={diagSize.reset} />
            <DiagnosticsPanel width={diagSize.size} state={diag} onClose={() => setDiagOpen(false)} />
          </>
        )}
      </div>
      <footer className={"statusbar" + (debugActive ? " debugging" : running ? " running" : "")}>
        <span className="status-item">
          {debugActive ? (
            <>
              <Codicon name={debugSnap.status === "stopped" ? "debug-pause" : "debug-alt"} />
              {debugSnap.status === "stopped"
                ? `Depurando — ${debugSnap.description ?? "detenido"}`
                : debugSnap.status === "starting" ? t("Iniciando el depurador…") : t("Depurando — en ejecución")}
            </>
          ) : (
            <>
              {running ? <Codicon name="loading" spin /> : <Codicon name="check" />}
              {running ? TASK_LABEL[running] ?? (running.startsWith("setup:") ? t("Instalando herramientas…") : t("Trabajando…")) : t("Listo")}
            </>
          )}
        </span>
        {git.status?.repo && (
          <button className="status-btn" title={t("Git: ramas y cambios")} onClick={() => showGit("branches")}>
            <Codicon name={git.busy ? "sync" : "git-branch"} spin={!!git.busy} />
            {git.status.detached ? t("(sin rama)") : git.status.branch}
            {git.status.files.length > 0 && "*"}
            {(git.status.behind > 0 || git.status.ahead > 0) && (
              <span className="status-sync">
                {git.status.behind > 0 && <>↓{git.status.behind}</>} {git.status.ahead > 0 && <>↑{git.status.ahead}</>}
              </span>
            )}
          </button>
        )}
        <span className="status-path">{project ?? t("Sin proyecto")}</span>
        <span className="spacer" />
        {project && lspStatus && (
          <button
            className="status-btn"
            title={t("Reiniciar rust-analyzer")}
            onClick={() => setLspGeneration((g) => g + 1)}
          >
            <Codicon
              name={/…|\d+%/.test(lspStatus) ? "sync" : /error|detuvo|Sin /.test(lspStatus) ? "warning" : "check"}
              spin={/…|\d+%/.test(lspStatus)}
            />
            {lspStatus.replace(/ ✓$/, "")}
          </button>
        )}
        {(updates.status === "available" || updates.status === "installed") && !updates.open && (
          <button className="status-btn status-update" title={t("Ver la actualización")} onClick={() => updates.setOpen(true)}>
            <Codicon name="cloud-download" />
            {updates.status === "installed" ? t("Reiniciar para actualizar") : t("Versión {0} disponible", updates.info?.version)}
          </button>
        )}
        {activeTab && <span>{t("Ln")}{" "}{cursor.line}{t(", Col")}{" "}{cursor.column}</span>}
        <span>{toolchain?.cargo ?? ""}</span>
      </footer>
      {bpDraft && (
        <BreakpointDialog
          draft={bpDraft}
          root={project}
          srcDirs={projects.map((p) => joinPath(p.dir, "src"))}
          onSave={(path, line, patch, oldPath, oldLine) => {
            if (oldPath && oldLine !== undefined && (oldPath !== path || oldLine !== line)) bpStore.remove(oldPath, oldLine);
            bpStore.upsert(path, line, patch);
            const short = `${basename(path)}:${line}`;
            log(
              patch.logMessage ? t("Punto de registro en {0}", short) : patch.condition ? t("Punto condicional en {0} (si {1})", short, patch.condition) : patch.hitCondition ? t("Punto en {0} (a partir de la vuelta {1})", short, patch.hitCondition) : t("Punto de interrupción en {0}", short),
              "muted",
            );
          }}
          onDelete={bpDraft.existing ? () => bpStore.remove(bpDraft.existing!.path, bpDraft.existing!.line) : undefined}
          onClose={() => setBpDraft(null)}
        />
      )}
      {mcpOpen && <McpDialog project={solution?.dir ?? project} onClose={() => setMcpOpen(false)} />}
      {showSamples && (
        <SamplesDialog
          onCancel={() => setShowSamples(false)}
          onCreated={async (sample, created) => {
            await offerSaveAll();
            setShowSamples(false);
            await (sample.tipo === "solucion" ? openSolution(created.open) : openProject(created.open));
            await openFile(created.file).catch(() => {});
            log(t("Ejemplo «{0}» creado en {1}. Pulsa F5 para ejecutarlo.", sample.nombre, created.open), "success");
            if (sample.tipo === "ventana") log(t("La primera compilación de una ventana (Slint) tarda un par de minutos."), "muted");
          }}
        />
      )}
      {showNew && (
        <NewProjectDialog
          currentRoot={project}
          solutionName={solution?.name ?? null}
          onCancel={() => setShowNew(false)}
          onCreate={createProject}
        />
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

function Welcome({
  onNew,
  onOpen,
  onOpenSolution,
  onSamples,
}: {
  onNew: () => void;
  onOpen: () => void;
  onOpenSolution: () => void;
  onSamples: () => void;
}) {
  return (
    <div className="welcome">
      <img className="welcome-logo" src={raxorinMark} height={96} alt="" />
      <h1 className="wordmark">
        <span className="brand-accent">{t("Raxorin")}</span> {" "}{t("Studio")}
      </h1>
      <p className="muted">{t("Crea programas en Rust de forma fácil.")}</p>
      <div className="welcome-actions">
        <button className="welcome-card" onClick={onNew}>
          <Codicon name="new-file" className="welcome-icon" />
          <strong>{t("Nuevo proyecto")}</strong>
          <small>{t("Consola, ventana o biblioteca")}</small>
        </button>
        <button className="welcome-card" onClick={onOpen}>
          <Codicon name="folder-opened" className="welcome-icon" />
          <strong>{t("Abrir proyecto")}</strong>
          <small>{t("Una carpeta con Cargo.toml")}</small>
        </button>
        <button className="welcome-card" onClick={onOpenSolution}>
          <Codicon name="layers" className="welcome-icon" />
          <strong>{t("Abrir solución")}</strong>
          <small>{t("Varios proyectos (.rxsln)")}</small>
        </button>
        <button className="welcome-card" onClick={onSamples}>
          <Codicon name="beaker" className="welcome-icon" />
          <strong>{t("Ejemplos")}</strong>
          <small>{t("Aplicaciones listas para probar")}</small>
        </button>
      </div>
      <div className="shortcuts muted">
        <div><kbd>F5</kbd> {" "}{t("Depurar")}</div>
        <div><kbd>Ctrl/⌘</kbd>+<kbd>F5</kbd> {" "}{t("Ejecutar sin depurar")}</div>
        <div><kbd>F9</kbd> {" "}{t("Punto de interrupción")}</div>
        <div><kbd>F10</kbd> / <kbd>F11</kbd> {" "}{t("Paso a paso")}</div>
        <div><kbd>Ctrl/⌘</kbd>+<kbd>{t("Shift")}</kbd>+<kbd>B</kbd> {" "}{t("Compilar")}</div>
        <div><kbd>Ctrl/⌘</kbd>+<kbd>S</kbd> {" "}{t("Guardar")}</div>
        <div><kbd>{t("Shift")}</kbd>+<kbd>F5</kbd> {" "}{t("Detener")}</div>
        <div><kbd>F12</kbd> {" "}{t("Ir a definición")}</div>
        <div><kbd>F2</kbd> {" "}{t("Renombrar")}</div>
        <div><kbd>Ctrl/⌘</kbd>+<kbd>.</kbd> {" "}{t("Acciones rápidas")}</div>
        <div><kbd>{t("Shift")}</kbd>+<kbd>{t("Alt")}</kbd>+<kbd>F</kbd> {" "}{t("Formatear")}</div>
      </div>
    </div>
  );
}
