import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { api, type GitFile } from "../api";
import { Codicon } from "../components/Icon";
import { languageFor } from "../util";
import { monacoTheme, useTheme } from "../theme";
import { useSettings } from "../settings";
import { repoPath } from "./useGit";
import { t, tErr } from "../i18n/index.ts";

export interface DiffRequest {
  repo: string;
  file: GitFile;
  /** true: lo preparado (último commit ↔ preparado); false: copia de trabajo (preparado ↔ archivo). */
  staged: boolean;
}

/** Diferencias lado a lado de un archivo (solo lectura). */
export default function DiffView({ req, onClose, onOpenFile }: { req: DiffRequest; onClose: () => void; onOpenFile: (path: string) => void }) {
  const { theme } = useTheme();
  const settings = useSettings();
  const [texts, setTexts] = useState<{ original: string; modified: string } | null>(null);
  const [err, setErr] = useState("");
  const { repo, file, staged } = req;
  const abs = repoPath(repo, file.path);
  const untracked = file.index === "?";
  const deleted = (staged ? file.index : file.worktree) === "D";

  useEffect(() => {
    setTexts(null);
    setErr("");
    const origPath = file.orig ?? file.path;
    (async () => {
      // Izquierda: último commit (lo preparado) o el índice (los cambios sin preparar).
      const original = untracked ? "" : await api.gitShowFile(repo, staged ? "HEAD" : "", staged ? origPath : file.path);
      // Derecha: el índice (lo preparado) o el archivo en disco.
      const modified = deleted ? "" : staged ? await api.gitShowFile(repo, "", file.path) : await api.readFile(abs);
      setTexts({ original, modified });
    })().catch((e) => setErr(tErr(e)));
  }, [repo, file, staged, abs, untracked, deleted]);

  const left = untracked ? "(archivo nuevo)" : staged ? t("Último commit") : t("Preparado / último commit");
  const right = deleted ? "(borrado)" : staged ? t("Preparado para el commit") : t("Tu copia de trabajo");

  return (
    <div className="diff-view">
      <div className="diff-head">
        <Codicon name="git-compare" />
        <strong>{file.path}</strong>
        <span className="muted small">{left} ↔ {right}</span>
        <span className="spacer" />
        {!deleted && (
          <button className="btn small" onClick={() => onOpenFile(abs)}>
            <Codicon name="go-to-file" /> {" "}{t("Abrir archivo")}
          </button>
        )}
        <button className="icon-btn" title={t("Cerrar diferencias (Esc)")} onClick={onClose}><Codicon name="close" /></button>
      </div>
      <div className="diff-body" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        {err ? (
          <div className="hint err pad">{err}</div>
        ) : !texts ? (
          <div className="empty-editor"><Codicon name="loading" spin /></div>
        ) : (
          <DiffEditor
            original={texts.original}
            modified={texts.modified}
            language={languageFor(file.path)}
            theme={monacoTheme(theme)}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: true,
              fontSize: settings.fontSize,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              minimap: { enabled: false },
            }}
          />
        )}
      </div>
    </div>
  );
}
