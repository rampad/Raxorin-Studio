// Asocia nombres de archivo/carpeta con los SVG de src/assets/file-icons
// (Material Icon Theme, licencia MIT — ver LICENSE-material-icon-theme).

const icons = import.meta.glob("./assets/file-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const url = (name: string) => icons[`./assets/file-icons/${name}.svg`] ?? icons["./assets/file-icons/document.svg"];

export type ProjectKind = "bin" | "lib";

const FILE_NAMES: Record<string, string> = {
  "cargo.toml": "toml",
  "cargo.lock": "lock",
  "rust-toolchain": "rust",
  "rust-toolchain.toml": "rust",
  "rustfmt.toml": "settings",
  ".rustfmt.toml": "settings",
  "clippy.toml": "settings",
  "tauri.conf.json": "tauri",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  license: "license",
  "license.md": "license",
  "license.txt": "license",
  "license-mit": "license",
  "license-apache": "license",
  "readme.md": "readme",
  readme: "readme",
};

const EXTENSIONS: Record<string, string> = {
  rs: "rust",
  toml: "toml",
  md: "markdown",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  bmp: "image",
  svg: "svg",
  html: "html",
  css: "css",
  sh: "console",
  bash: "console",
  zsh: "console",
  bat: "console",
  cmd: "console",
  ps1: "console",
  log: "log",
  slint: "slint",
  rxsln: "raxorin-solution",
  exe: "exe",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  lock: "lock",
};

const FOLDERS: Record<string, string> = {
  src: "folder-src",
  target: "folder-target",
  tests: "folder-test",
  test: "folder-test",
  examples: "folder-examples",
  docs: "folder-docs",
  doc: "folder-docs",
  images: "folder-images",
  img: "folder-images",
  icons: "folder-images",
  assets: "folder-resource",
  resources: "folder-resource",
  res: "folder-resource",
  ui: "folder-resource",
  benches: "folder-benchmark",
  config: "folder-config",
  ".git": "folder-git",
  ".github": "folder-github",
  ".vscode": "folder-vscode",
  "src-tauri": "folder-src-tauri",
};

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();
  if (FILE_NAMES[lower]) return url(FILE_NAMES[lower]);
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return url(EXTENSIONS[ext] ?? "document");
}

export function folderIconUrl(name: string, open: boolean, project?: ProjectKind): string {
  const base = project === "bin" ? "folder-app" : project === "lib" ? "folder-lib" : FOLDERS[name.toLowerCase()] ?? "folder";
  return url(open ? `${base}-open` : base);
}
