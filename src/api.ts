import { invoke } from "@tauri-apps/api/core";

export interface Entry { name: string; path: string; isDir: boolean }

export type OutputKind =
  | "info" | "muted" | "stdout" | "stderr" | "error" | "warning" | "success" | "input";
export interface OutputChunk { text: string; kind: OutputKind }

export interface Diagnostic {
  level: string;
  message: string;
  code: string | null;
  file: string | null;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export type Task = "build" | "run" | "check" | "test" | "debug";
export interface DebuggerInfo {
  adapter: string | null;
  formatters: string | null;
  formatterGuard: string | null;
  stdinSupported: boolean;
}
export interface TaskFinished { task: Task; success: boolean; code: number | null; cancelled: boolean }

export interface ToolchainStatus {
  cargo: string | null;
  rustAnalyzer: boolean;
  clippy: boolean;
  rustfmt: boolean;
  rustSrc: boolean;
}

export interface ProjectInfo {
  name: string;
  dir: string;
  manifest: string;
  kind: "bin" | "lib";
  workspaceManifest: string;
}

export interface SolutionProject { ruta: string; path: string; exists: boolean }
export interface SolutionInfo {
  file: string;
  dir: string;
  name: string;
  /** Carpeta absoluta del proyecto de inicio. */
  startup: string | null;
  projects: SolutionProject[];
}

export interface CrateSummary {
  name: string;
  description: string;
  version: string;
  downloads: number;
  recentDownloads: number;
  updatedAt: string;
}
export interface VersionInfo {
  num: string;
  createdAt: string;
  license: string | null;
  rustVersion: string | null;
  features: Record<string, string[]>;
}
export interface CrateDetails extends CrateSummary {
  homepage: string | null;
  repository: string | null;
  documentation: string | null;
  keywords: string[];
  categories: string[];
  versions: VersionInfo[];
}
export type DepKind = "normal" | "dev" | "build";
export interface Dependency {
  name: string;
  req: string;
  resolved: string | null;
  kind: DepKind;
  features: string[];
  defaultFeatures: boolean;
  optional: boolean;
  path: string | null;
}
export interface AddOptions {
  version?: string;
  features?: string[];
  kind?: DepKind;
  defaultFeatures?: boolean;
}

export const api = {
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, contents: string) => invoke<void>("write_file", { path, contents }),
  createProject: (parent: string, name: string, kind: "bin" | "lib" | "slint") =>
    invoke<string>("create_project", { parent, name, kind }),
  startTask: (project: string, task: Task, external = false) =>
    invoke<void>("start_task", { project, task, external }),
  createFile: (path: string) => invoke<void>("create_file", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  renamePath: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  deletePath: (path: string) => invoke<void>("delete_path", { path }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  findProjects: (root: string) => invoke<ProjectInfo[]>("find_projects", { root }),
  addProjectReference: (project: string, dependency: string) =>
    invoke<string>("add_project_reference", { project, dependency }),
  debuggerInfo: () => invoke<DebuggerInfo>("debugger_info"),
  debugStdinWrite: (text: string) => invoke<void>("debug_stdin_write", { text }),
  watchProject: (roots: string[]) => invoke<void>("watch_project", { roots }),
  solutionRead: (file: string) => invoke<SolutionInfo>("solution_read", { file }),
  solutionCreate: (dir: string, name: string, projects: string[]) =>
    invoke<string>("solution_create", { dir, name, projects }),
  solutionAddProject: (file: string, path: string) => invoke<SolutionInfo>("solution_add_project", { file, path }),
  solutionRemoveProject: (file: string, path: string) => invoke<SolutionInfo>("solution_remove_project", { file, path }),
  solutionSetStartup: (file: string, dir: string | null) => invoke<void>("solution_set_startup", { file, dir }),
  solutionFind: (dir: string) => invoke<string | null>("solution_find", { dir }),
  /** Archivo con el que se abrió la app (doble clic en un .rxsln o argumento). */
  takePendingOpen: () => invoke<string | null>("take_pending_open"),
  stopTask: () => invoke<void>("stop_task"),
  sendStdin: (text: string) => invoke<void>("send_stdin", { text }),
  toolchainStatus: () => invoke<ToolchainStatus>("toolchain_status"),
  installComponents: (components: string[]) => invoke<string>("install_components", { components }),
  crateSearch: (query: string, page = 1) => invoke<CrateSummary[]>("crate_search", { query, page }),
  crateDetails: (name: string) => invoke<CrateDetails>("crate_details", { name }),
  crateReadme: (name: string, version: string) => invoke<string>("crate_readme", { name, version }),
  crateLatest: (names: string[]) => invoke<Record<string, string>>("crate_latest", { names }),
  crateList: (project: string) => invoke<Dependency[]>("crate_list", { project }),
  crateAdd: (project: string, name: string, o: AddOptions = {}) =>
    invoke<string>("crate_add", {
      project,
      name,
      version: o.version,
      features: o.features,
      kind: o.kind,
      defaultFeatures: o.defaultFeatures,
    }),
  crateSetFeatures: (project: string, d: Dependency, features: string[], defaultFeatures: boolean) =>
    invoke<string>("crate_set_features", {
      project,
      name: d.name,
      req: d.req,
      kind: d.kind,
      features,
      defaultFeatures,
    }),
  crateRemove: (project: string, name: string, kind: string) =>
    invoke<void>("crate_remove", { project, name, kind }),
};
