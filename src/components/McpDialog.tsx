import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { t, tErr, docsUrl } from "../i18n/index.ts";
import { Codicon } from "./Icon";

interface Props {
  /** Carpeta del proyecto o la solución abierta (para limitar el acceso a ella). */
  project: string | null;
  onClose: () => void;
}

type Setup = Awaited<ReturnType<typeof api.mcpSetup>>;

const quote = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** Ayuda → Conectar con IA (MCP): cómo usar Raxorin Studio desde Claude Code, Claude Desktop y otros. */
export default function McpDialog({ project, onClose }: Props) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const [onlyProject, setOnlyProject] = useState(!!project);
  const [copied, setCopied] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.mcpSetup().then(setSetup).catch((e) => setError(tErr(e)));
  }, []);

  const roots = onlyProject && project ? [project] : [];
  const args = ["--mcp", ...roots.flatMap((r) => ["--root", r])];
  const claudeCode = setup ? `claude mcp add raxorin-studio -- ${quote(setup.exe)} ${args.map(quote).join(" ")}` : "";
  const json = setup ? JSON.stringify({ mcpServers: { "raxorin-studio": { command: setup.exe, args } } }, null, 2) : "";

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* sin portapapeles */
    }
  };

  const addToDesktop = async () => {
    setBusy(true);
    setError("");
    try {
      setAdded(await api.mcpAddToClaudeDesktop(roots));
      setSetup(await api.mcpSetup());
    } catch (e) {
      setError(tErr(e));
    }
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal mcp-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          <Codicon name="plug" /> {t("Conectar con IA (MCP)")}
        </h2>
        <p className="muted small">
          {t("Raxorin Studio es un servidor MCP: Claude Code, Claude Desktop y otras IA pueden compilar tus proyectos, ver los errores con su archivo y línea, ejecutar las pruebas y el programa, buscar paquetes, crear proyectos y escribir ventanas de Slint que el diseñador entiende.")}
        </p>

        {setup?.temporaryLocation && (
          <div className="mcp-warn small">
            <Codicon name="warning" /> {t("Raxorin Studio se está ejecutando desde el instalador o una copia temporal: muévelo a Aplicaciones antes de conectarlo, o la ruta dejará de funcionar.")}
          </div>
        )}

        <label className="check-line">
          <input type="checkbox" checked={onlyProject} disabled={!project} onChange={(e) => setOnlyProject(e.target.checked)} />
          {project ? t("Solo la carpeta del proyecto abierto ({0})", project) : t("Abre un proyecto para limitar el acceso a su carpeta")}
        </label>
        <p className="muted small mcp-note">
          {onlyProject && project
            ? t("La IA solo podrá leer y escribir dentro de esa carpeta.")
            : t("Sin límite, la IA puede usar las carpetas que comparta el cliente o, si no comparte ninguna, tu carpeta de usuario.")}
        </p>

        {setup && (
          <>
            <section className="mcp-section">
              <h3>Claude Code</h3>
              <p className="muted small">{t("Ejecuta en una terminal (por ejemplo, el terminal de Raxorin Studio):")}</p>
              <div className="mcp-code">
                <code>{claudeCode}</code>
                <button className="icon-btn" title={t("Copiar")} onClick={() => copy(claudeCode, "code")}>
                  <Codicon name={copied === "code" ? "check" : "copy"} />
                </button>
              </div>
            </section>

            <section className="mcp-section">
              <h3>Claude Desktop</h3>
              <p className="muted small">
                {setup.inClaudeDesktop
                  ? t("Raxorin Studio ya está en la configuración de Claude Desktop. Puedes volver a agregarlo para cambiar la carpeta.")
                  : t("Se agrega a su configuración (se guarda una copia de la anterior). Después, reinicia Claude Desktop.")}
              </p>
              <div className="row">
                <button className="btn primary" onClick={() => void addToDesktop()} disabled={busy || !setup.claudeDesktopConfig}>
                  <Codicon name="add" /> {setup.inClaudeDesktop ? t("Actualizar en Claude Desktop") : t("Agregar a Claude Desktop")}
                </button>
              </div>
              {added && (
                <p className="small ok">
                  <Codicon name="check" /> {t("Listo: {0}. Reinicia Claude Desktop para usarlo.", added)}
                </p>
              )}
            </section>

            <section className="mcp-section">
              <h3>{t("Otros clientes MCP")}</h3>
              <p className="muted small">{t("La configuración estándar (stdio):")}</p>
              <div className="mcp-code">
                <pre>{json}</pre>
                <button className="icon-btn" title={t("Copiar")} onClick={() => copy(json, "json")}>
                  <Codicon name={copied === "json" ? "check" : "copy"} />
                </button>
              </div>
            </section>
          </>
        )}

        {error && <pre className="hint err">{error}</pre>}

        <div className="actions">
          <button className="btn" onClick={() => void openUrl(docsUrl("guias/mcp/"))}>
            <Codicon name="book" /> {t("Documentación")}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>{t("Cerrar")}</button>
        </div>
      </div>
    </div>
  );
}
