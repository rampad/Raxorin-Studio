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

export type Task = "build" | "run" | "check" | "test";
export interface TaskFinished { task: Task; success: boolean; code: number | null; cancelled: boolean }

export const api = {
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, contents: string) => invoke<void>("write_file", { path, contents }),
  createProject: (parent: string, name: string, kind: "bin" | "lib") =>
    invoke<string>("create_project", { parent, name, kind }),
  startTask: (project: string, task: Task) => invoke<void>("start_task", { project, task }),
  stopTask: () => invoke<void>("stop_task"),
  sendStdin: (text: string) => invoke<void>("send_stdin", { text }),
  toolchainInfo: () => invoke<string>("toolchain_info"),
};
