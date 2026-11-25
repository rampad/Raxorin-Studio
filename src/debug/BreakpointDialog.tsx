import { useEffect, useState } from "react";
import { api } from "../api";
import { Codicon } from "../components/Icon";
import { joinPath, relative } from "../util";
import type { BreakpointInfo } from "./breakpoints";
import { t } from "../i18n/index.ts";

export interface BreakpointDraft {
  path: string;
  line: number;
  existing?: BreakpointInfo;
  /** Tipo con el que abrir el diálogo. */
  kind?: Kind;
}

type Kind = "always" | "condition" | "hit" | "log";

interface Props {
  draft: BreakpointDraft;
  root: string | null;
  /** Carpetas `src` de los proyectos (para sugerir archivos). */
  srcDirs: string[];
  onSave: (path: string, line: number, patch: { condition?: string; hitCondition?: string; logMessage?: string }, oldPath?: string, oldLine?: number) => void;
  onDelete?: () => void;
  onClose: () => void;
}

const KINDS: { id: Kind; icon: string; title: string; desc: string }[] = [
  { id: "always", icon: "circle-filled", title: t("Detenerse siempre"), desc: t("Se detiene cada vez que el programa llega a esta línea.") },
  { id: "condition", icon: "debug-breakpoint-conditional", title: t("Detenerse si se cumple una condición"), desc: t("Solo se detiene cuando la expresión es verdadera.") },
  { id: "hit", icon: "debug-breakpoint-function", title: t("Detenerse en la vuelta número…"), desc: t("Útil en ciclos: se detiene a partir de la N-ésima vez.") },
  { id: "log", icon: "debug-breakpoint-log", title: t("Mostrar un mensaje sin detenerse"), desc: t("Como un println! temporal: escribe en la Salida y sigue.") },
];

/** Busca archivos .rs (hasta 5 niveles) para sugerirlos. */
async function listRustFiles(dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 5 || out.length > 300) return;
    const entries = await api.listDir(dir).catch(() => []);
    for (const e of entries) {
      if (e.isDir) await walk(e.path, depth + 1);
      else if (e.name.endsWith(".rs")) out.push(e.path);
    }
  };
  for (const d of dirs) await walk(d, 0);
  return out.sort();
}

export default function BreakpointDialog({ draft, root, srcDirs, onSave, onDelete, onClose }: Props) {
  const ex = draft.existing;
  const initialKind: Kind =
    draft.kind ?? (ex?.logMessage ? "log" : ex?.condition ? "condition" : ex?.hitCondition ? "hit" : "always");
  const [kind, setKind] = useState<Kind>(initialKind);
  const [file, setFile] = useState(relative(root, draft.path) || draft.path);
  const [line, setLine] = useState(String(draft.line));
  const [condition, setCondition] = useState(ex?.condition ?? "");
  const [hit, setHit] = useState(ex?.hitCondition ?? "2");
  const [log, setLog] = useState(ex?.logMessage ?? "");
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    listRustFiles(srcDirs).then(setFiles);
  }, [srcDirs]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseInt(line, 10);
    if (!Number.isInteger(n) || n < 1) return setError(t("Escribe un número de línea válido."));
    const path = file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) ? file : root ? joinPath(root, file) : file;
    if (!path.endsWith(".rs")) return setError(t("Los puntos de interrupción van en archivos .rs."));
    if (kind === "condition" && !condition.trim()) return setError(t("Escribe la condición, por ejemplo: i == 5"));
    if (kind === "hit" && !/^\d+$/.test(hit.trim())) return setError(t("Escribe un número de vuelta, por ejemplo: 3"));
    if (kind === "log" && !log.trim()) return setError(t("Escribe el mensaje, por ejemplo: i = {i}"));
    onSave(
      path,
      n,
      {
        condition: kind === "condition" ? condition : undefined,
        hitCondition: kind === "hit" ? hit : undefined,
        logMessage: kind === "log" ? log : undefined,
      },
      ex?.path,
      ex?.line,
    );
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal bp-dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>
          <Codicon name="debug-alt" /> {ex ? t("Editar punto de interrupción") : t("Agregar punto de interrupción")}
        </h2>

        <div className="row">
          <label className="grow">
            
            {t("Archivo")}
            <input list="bp-files" value={file} onChange={(e) => setFile(e.target.value)} spellCheck={false} />
            <datalist id="bp-files">
              {files.map((f) => <option key={f} value={relative(root, f) || f} />)}
            </datalist>
          </label>
          <label className="line-field">
            
            {t("Línea")}
            <input value={line} onChange={(e) => setLine(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoFocus={!ex} />
          </label>
        </div>

        <div className="bp-kinds">
          {KINDS.map((k) => (
            <button type="button" key={k.id} className={"template" + (kind === k.id ? " selected" : "")} onClick={() => setKind(k.id)}>
              <Codicon name={k.icon} className={"bp-kind-icon " + k.id} />
              <span>
                <strong>{k.title}</strong>
                <small>{k.desc}</small>
              </span>
            </button>
          ))}
        </div>

        {kind === "condition" && (
          <label>
            
            {t("Condición (expresión de Rust que devuelve verdadero/falso)")}
            <input className="mono" value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="i == 5" autoFocus spellCheck={false} />
            <span className="hint muted">{t("Ejemplos:")}{" "}<code>total &gt; 100</code> · <code>nombre == "Ana"</code> · <code>lista.len() == 3</code></span>
          </label>
        )}
        {kind === "hit" && (
          <label>
            
            {t("Detenerse a partir de la vuelta número")}
            <input className="mono" value={hit} onChange={(e) => setHit(e.target.value.replace(/\D/g, ""))} autoFocus />
            <span className="hint muted">{t("Con 3, ignora las dos primeras veces y se detiene en la tercera.")}</span>
          </label>
        )}
        {kind === "log" && (
          <label>
            
            {t("Mensaje (las expresiones entre llaves se reemplazan por su valor)")}
            <input className="mono" value={log} onChange={(e) => setLog(e.target.value)} placeholder="i = {i}, total = {total}" autoFocus spellCheck={false} />
            <span className="hint muted">{t("Aparece en la pestaña Salida cada vez que se pasa por la línea, sin pausar el programa.")}</span>
          </label>
        )}

        {error && <div className="hint err">{error}</div>}

        <div className="actions">
          {onDelete && (
            <button type="button" className="btn danger" onClick={() => { onDelete(); onClose(); }}>
              <Codicon name="trash" /> {" "}{t("Quitar")}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{t("Cancelar")}</button>
          <button type="submit" className="btn primary">{ex ? t("Guardar") : t("Agregar")}</button>
        </div>
      </form>
    </div>
  );
}
