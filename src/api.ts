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

export type Task = "build" | "run" | "check" | "test" | "debug" | "publish" | "setup-target" | `setup:${string}`;

/** Herramienta del sistema (ver setup.rs). */
export interface SetupTool {
  id: string;
  name: string;
  description: string;
  required: boolean;
  installed: boolean;
  version: string | null;
  canInstall: boolean;
  needsAdmin: boolean;
  manual: string | null;
  unavailable: string | null;
  /** Instalado pero incompleto (p. ej. Visual Studio sin el SDK de Windows). */
  problem: string | null;
}

/** Opciones de "Publicar" (ver runner.rs). */
export interface PublishOptions { outDir: string; target: string | null; zip: boolean; open: boolean }
export interface RustTargets { host: string; installed: string[] }
export interface UpdateInfo { version: string; current: string; notes: string | null; date: string | null }
export interface CrossStatus {
  target: string;
  rustTarget: boolean;
  linker: string | null;
  linkerFound: boolean;
  canInstall: boolean;
  manual: string | null;
}
export interface DebuggerInfo {
  adapter: string | null;
  /** "lldb-dap" (Apple/LLVM) o "codelldb" (Windows; también en Linux si no hay lldb-dap). */
  kind: "lldb-dap" | "codelldb" | null;
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

// ---------- Git ----------
export interface GitFile { path: string; orig: string | null; index: string; worktree: string; conflict: boolean }
export interface GitStatus {
  repo: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasCommits: boolean;
  files: GitFile[];
  remotes: { name: string; url: string }[];
  inProgress: string | null;
}
export interface GitBranch { name: string; current: boolean; remote: boolean; upstream: string | null }
export interface GithubPublishInfo {
  repo: string | null;
  githubUrl: string | null;
  version: string;
  workflow: string;
  workflowExists: boolean;
  tags: string[];
  programs: string[];
  problem: string | null;
}
export interface GitCommit { hash: string; short: string; author: string; date: string; subject: string; refs: string }

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
  writeFileBase64: (path: string, base64: string) => invoke<void>("write_file_base64", { path, base64 }),
  createProject: (parent: string, name: string, kind: "bin" | "lib" | "slint") =>
    invoke<string>("create_project", { parent, name, kind }),
  startTask: (project: string, task: Task, external = false, release = false, publish: PublishOptions | null = null) =>
    invoke<void>("start_task", { project, task, external, release, publish }),
  rustTargets: () => invoke<RustTargets>("rust_targets"),
  setupStatus: () => invoke<SetupTool[]>("setup_status"),
  updateCheck: (channel: "stable" | "beta") => invoke<UpdateInfo | null>("update_check", { channel }),
  updateInstall: () => invoke<void>("update_install"),
  updateRestart: () => invoke<void>("update_restart"),
  crossStatus: (target: string) => invoke<CrossStatus>("cross_status", { target }),
  gitStatus: (dir: string) => invoke<GitStatus>("git_status", { dir }),
  gitInit: (dir: string) => invoke<void>("git_init", { dir }),
  gitNestedRepos: (base: string, projects: string[]) =>
    invoke<{ path: string; commits: number; dirty: boolean }[]>("git_nested_repos", { base, projects }),
  gitInitSolution: (base: string, projects: string[]) => invoke<void>("git_init_solution", { base, projects }),
  gitStage: (repo: string, paths: string[]) => invoke<void>("git_stage", { repo, paths }),
  gitUnstage: (repo: string, paths: string[]) => invoke<void>("git_unstage", { repo, paths }),
  gitDiscard: (repo: string, paths: string[], untracked: string[]) => invoke<void>("git_discard", { repo, paths, untracked }),
  gitCommit: (repo: string, message: string, amend: boolean, all: boolean) =>
    invoke<string>("git_commit", { repo, message, amend, all }),
  gitShowFile: (repo: string, rev: string, path: string) => invoke<string>("git_show_file", { repo, rev, path }),
  gitBranches: (repo: string) => invoke<GitBranch[]>("git_branches", { repo }),
  gitCheckout: (repo: string, name: string, create = false, remote = false) =>
    invoke<void>("git_checkout", { repo, name, create, remote }),
  gitDeleteBranch: (repo: string, name: string, force = false) => invoke<void>("git_delete_branch", { repo, name, force }),
  gitMerge: (repo: string, name: string) => invoke<string>("git_merge", { repo, name }),
  gitFetch: (repo: string) => invoke<void>("git_fetch", { repo }),
  gitPull: (repo: string) => invoke<string>("git_pull", { repo }),
  gitPush: (repo: string) => invoke<string>("git_push", { repo }),
  gitStash: (repo: string, pop: boolean) => invoke<string>("git_stash", { repo, pop }),
  gitStashCount: (repo: string) => invoke<number>("git_stash_count", { repo }),
  gitLog: (repo: string, limit = 50) => invoke<GitCommit[]>("git_log", { repo, limit }),
  gitRemoteAdd: (repo: string, name: string, url: string) => invoke<void>("git_remote_add", { repo, name, url }),
  gitClone: (url: string, parent: string) => invoke<string>("git_clone", { url, parent }),
  gitIdentity: (repo: string) => invoke<{ name: string; email: string }>("git_identity", { repo }),
  gitSetIdentity: (repo: string, name: string, email: string) => invoke<void>("git_set_identity", { repo, name, email }),
  ghStatus: () => invoke<{ installed: boolean; user: string | null }>("gh_status"),
  ghRepoCreate: (repo: string, name: string, priv: boolean, description: string) =>
    invoke<string>("gh_repo_create", { repo, name, private: priv, description }),
  ghLogin: () => invoke<void>("gh_login"),
  githubPublishInfo: (base: string, name: string, projects: string[]) =>
    invoke<GithubPublishInfo>("github_publish_info", { base, name, projects }),
  githubPublish: (base: string, name: string, projects: string[], tag: string | null) =>
    invoke<string>("github_publish", { base, name, projects, tag }),
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
