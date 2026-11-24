// Íconos de la interfaz: Codicons (los de VS Code) y SVG por tipo de archivo (Material Icon Theme).
import { fileIconUrl, folderIconUrl, type ProjectKind } from "../fileIcons";

interface CodiconProps {
  name: string;
  className?: string;
  title?: string;
  spin?: boolean;
}

/** Ícono de Codicons. Nombres: https://microsoft.github.io/vscode-codicons/dist/codicon.html */
export function Codicon({ name, className, title, spin }: CodiconProps) {
  return (
    <i
      className={`codicon codicon-${name}${spin ? " codicon-modifier-spin" : ""}${className ? " " + className : ""}`}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  );
}

interface FileIconProps {
  name: string;
  isDir?: boolean;
  open?: boolean;
  project?: ProjectKind;
  size?: number;
}

/** Ícono SVG según el tipo de archivo o carpeta. */
export function FileIcon({ name, isDir, open, project, size = 16 }: FileIconProps) {
  const src = isDir || project ? folderIconUrl(name, !!open, project) : fileIconUrl(name);
  return <img className="file-icon-img" src={src} width={size} height={size} alt="" draggable={false} />;
}
