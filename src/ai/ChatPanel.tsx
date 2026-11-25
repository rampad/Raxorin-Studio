// Panel lateral del chat con IA: Anthropic, Gemini, Claude Code o GitHub Copilot, con las
// herramientas del IDE. Cada cambio de archivo, comando o paquete se aprueba en el chat.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Codicon } from "../components/Icon";
import { t, tErr } from "../i18n/index.ts";
import { backend, type CliStatus } from "./backend";
import { AnthropicSession, ANTHROPIC_DEFAULT_MODEL, anthropicError, anthropicModels } from "./anthropic";
import { GeminiSession, geminiDefault, geminiError, geminiModels } from "./gemini";
import { ClaudeCodeSession, CLAUDE_MODELS } from "./claudeCode";
import { AcpSession, COPILOT, COPILOT_MODELS, GEMINI_CLI } from "./acp";
import CliSetup from "./CliSetup";
import type { CliProgram } from "./backend";
import { diffLines, hunks } from "./diff";
import Markdown from "./Markdown";
import { newId, type Approval, type ApprovalDetail, type ChatContext, type Host, type Item, type ProviderId, type Session } from "./types";

interface Props {
  width: number;
  getContext: () => ChatContext;
  onFileChanged: (path: string) => void;
  onOpenFile: (path: string) => void;
  onClose: () => void;
  /** Abre el terminal integrado ejecutando un comando (instalar o iniciar sesión en una CLI). */
  onRunInTerminal: (command: string) => void;
  /** Solo para vistas previas y pruebas: conversación inicial. */
  initialItems?: Item[];
}

const PREFS_KEY = "raxorinstudio.aiChat";
type Prefs = { provider: ProviderId; models: Partial<Record<ProviderId, string>> };
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "");
    if (p && typeof p.provider === "string") return { provider: p.provider, models: p.models ?? {} };
  } catch {
    /* sin preferencias */
  }
  return { provider: "anthropic", models: {} };
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* sin almacenamiento */
  }
}

const PROVIDERS: { id: ProviderId; label: string; icon: string }[] = [
  { id: "anthropic", label: "Claude (API)", icon: "key" },
  { id: "claude-code", label: "Claude Code", icon: "terminal" },
  { id: "gemini", label: "Gemini (API)", icon: "key" },
  { id: "copilot", label: "GitHub Copilot", icon: "copilot" },
  { id: "gemini-cli", label: "Gemini CLI (Google)", icon: "terminal" },
];

type Model = { id: string; name: string };

function Diff({ detail }: { detail: Extract<ApprovalDetail, { type: "diff" }> }) {
  const parts = useMemo(() => hunks(diffLines(detail.before, detail.after)), [detail.before, detail.after]);
  const added = parts.filter((p) => p.kind === "add").length;
  const removed = parts.filter((p) => p.kind === "del").length;
  return (
    <div className="ai-diff">
      <div className="ai-diff-head">
        <span className="ai-diff-path" title={detail.path}>{detail.path.split(/[\\/]/).slice(-2).join("/")}</span>
        {!detail.before && <span className="ai-badge">{t("nuevo")}</span>}
        <span className="ai-diff-count add">+{added}</span>
        <span className="ai-diff-count del">−{removed}</span>
      </div>
      <div className="ai-diff-body">
        {parts.map((p, i) =>
          p.kind === "skip" ? (
            <div key={i} className="ai-diff-skip">{t("… {0} líneas sin cambios …", p.count)}</div>
          ) : (
            <div key={i} className={`ai-diff-line ${p.kind}`}>
              <span className="ai-diff-no">{p.kind === "add" ? "" : p.oldNo}</span>
              <span className="ai-diff-no">{p.kind === "del" ? "" : p.newNo}</span>
              <span className="ai-diff-sign">{p.kind === "add" ? "+" : p.kind === "del" ? "−" : " "}</span>
              <span className="ai-diff-text">{p.text || " "}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/** Diff unificado (de Copilot): sin las cabeceras de git, con las líneas coloreadas. */
function Patch({ detail }: { detail: Extract<ApprovalDetail, { type: "patch" }> }) {
  const lines = detail.text.replace(/\r/g, "").split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  return (
    <div className="ai-diff">
      <div className="ai-diff-head">
        <span className="ai-diff-path" title={detail.path}>{detail.path.split(/[\\/]/).slice(-2).join("/")}</span>
        <span className="ai-diff-count add">+{added}</span>
        <span className="ai-diff-count del">−{removed}</span>
      </div>
      <div className="ai-diff-body">
        {lines.map((l, i) =>
          l.startsWith("@@") ? (
            <div key={i} className="ai-diff-skip">{l}</div>
          ) : (
            <div key={i} className={`ai-diff-line ${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "same"}`}>
              <span className="ai-diff-sign">{l.startsWith("+") ? "+" : l.startsWith("-") ? "−" : " "}</span>
              <span className="ai-diff-text">{l.slice(1) || " "}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function ApprovalCard({ item, onAnswer }: { item: Extract<Item, { kind: "approval" }>; onAnswer: (a: Approval) => void }) {
  const [reason, setReason] = useState("");
  const [askReason, setAskReason] = useState(false);
  return (
    <div className={`ai-approval ${item.state}`}>
      <div className="ai-approval-title">
        <Codicon name={item.state === "approved" ? "check" : item.state === "rejected" ? "close" : "shield"} />
        <span>{item.title}</span>
        {item.state !== "pending" && <span className="ai-badge">{item.state === "approved" ? t("Aprobado") : t("Rechazado")}</span>}
      </div>
      {item.detail.type === "diff" ? (
        <Diff detail={item.detail} />
      ) : item.detail.type === "patch" ? (
        <Patch detail={item.detail} />
      ) : (
        <pre className={item.detail.type === "command" ? "ai-command" : "ai-detail"}>{item.detail.text}</pre>
      )}
      {item.state === "pending" && (
        <>
          {askReason && (
            <input
              className="ai-reason"
              autoFocus
              placeholder={t("Por qué no (opcional): la IA lo tendrá en cuenta")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onAnswer({ allow: false, message: reason.trim() || undefined })}
            />
          )}
          <div className="ai-approval-actions">
            <button className="btn primary" onClick={() => onAnswer({ allow: true })}>
              <Codicon name="check" /> {t("Aprobar")}
            </button>
            <button className="btn" onClick={() => (askReason ? onAnswer({ allow: false, message: reason.trim() || undefined }) : setAskReason(true))}>
              <Codicon name="close" /> {askReason ? t("Rechazar") : t("Rechazar…")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const icon = item.status === "running" ? "loading" : item.status === "error" ? "error" : "check";
  return (
    <div className={`ai-tool ${item.status}`}>
      <button className="ai-tool-head" onClick={() => setOpen((o) => !o)} disabled={!item.output}>
        <Codicon name={icon} spin={item.status === "running"} />
        <span className="ai-tool-name">{item.name}</span>
        <span className="ai-tool-summary">{item.summary}</span>
        {item.output && <Codicon name={open ? "chevron-down" : "chevron-right"} />}
      </button>
      {open && item.output && <pre className="ai-tool-output">{item.output.length > 20000 ? item.output.slice(0, 20000) + "\n…" : item.output}</pre>}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-thinking">
      <button onClick={() => setOpen((o) => !o)}>
        <Codicon name={open ? "chevron-down" : "chevron-right"} /> {t("Razonamiento")}
      </button>
      {open && <div className="ai-thinking-text">{text}</div>}
    </div>
  );
}

export default function ChatPanel({ width, getContext, onFileChanged, onOpenFile, onClose, onRunInTerminal, initialItems }: Props) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const provider = prefs.provider;
  const [items, setItems] = useState<Item[]>(initialItems ?? []);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keys, setKeys] = useState<{ anthropic: string | null; gemini: string | null }>({ anthropic: null, gemini: null });
  const [keyDraft, setKeyDraft] = useState("");
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsError, setModelsError] = useState("");
  const session = useRef<Session | null>(null);
  const resolvers = useRef(new Map<string, (a: Approval) => void>());
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const keyProvider = provider === "anthropic" || provider === "gemini" ? provider : null;
  const needsKey = keyProvider ? !keys[keyProvider] : false;
  const cliProgram: CliProgram | null = provider === "claude-code" ? "claude" : provider === "copilot" ? "copilot" : provider === "gemini-cli" ? "gemini" : null;
  const needsCli = cliProgram ? !!cli && !cli[cliProgram] : false;
  const model = prefs.models[provider] ?? (provider === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : provider === "gemini" ? geminiDefault(models) : "default");

  useEffect(() => {
    void Promise.all([backend.keyGet("anthropic").catch(() => null), backend.keyGet("gemini").catch(() => null)]).then(([anthropic, gemini]) => setKeys({ anthropic, gemini }));
    void backend.cliStatus().then(setCli).catch(() => setCli({ claude: null, copilot: null, gemini: null, exe: "" }));
  }, []);

  // Lista de modelos de cada proveedor.
  useEffect(() => {
    setModelsError("");
    if (provider === "claude-code") return setModels(CLAUDE_MODELS);
    if (provider === "copilot") return setModels(COPILOT_MODELS);
    if (provider === "gemini-cli") {
      setModels([{ id: "default", name: t("Predeterminado de Gemini CLI") }]);
      if (!cli?.gemini) return;
      let alive = true;
      void backend.cliModels("gemini").then((ids) => alive && ids.length && setModels([{ id: "default", name: t("Predeterminado de Gemini CLI") }, ...ids.filter((id) => id !== "default").map((id) => ({ id, name: id === "auto" ? t("Automático") : id }))]));
      return () => {
        alive = false;
      };
    }
    const key = keyProvider ? keys[keyProvider] : null;
    if (!key) return setModels([]);
    let alive = true;
    (provider === "anthropic" ? anthropicModels(key) : geminiModels(key))
      .then((m) => alive && setModels(m))
      .catch((e) => alive && setModelsError(provider === "anthropic" ? anthropicError(e) : geminiError(e)));
    return () => {
      alive = false;
    };
  }, [provider, keys, keyProvider, cli]);

  const updatePrefs = (p: Prefs) => {
    setPrefs(p);
    savePrefs(p);
  };

  const reset = useCallback(() => {
    session.current?.dispose();
    session.current = null;
    resolvers.current.forEach((r) => r({ allow: false, message: "The chat was reset." }));
    resolvers.current.clear();
    setItems([]);
    setBusy(false);
  }, []);

  useEffect(() => () => session.current?.dispose(), []);

  // Cambiar de proveedor o de modelo empieza una conversación nueva.
  const choose = (p: Partial<Prefs> & { model?: string }) => {
    const next: Prefs = { provider: p.provider ?? prefs.provider, models: { ...prefs.models } };
    if (p.model) next.models[next.provider] = p.model;
    if (next.provider !== prefs.provider || (p.model && p.model !== model)) reset();
    updatePrefs(next);
    setKeyDraft("");
  };

  const host = useMemo<Host>(() => ({
    push: (item) => setItems((xs) => [...xs, item]),
    update: (id, patch) => setItems((xs) => xs.map((x) => (x.id === id ? ({ ...x, ...patch } as Item) : x))),
    append: (id, text) => setItems((xs) => xs.map((x) => (x.id === id && "text" in x ? ({ ...x, text: x.text + text } as Item) : x))),
    approve: (title, detail) =>
      new Promise<Approval>((resolve) => {
        const id = newId();
        resolvers.current.set(id, resolve);
        setItems((xs) => [...xs, { kind: "approval", id, title, detail, state: "pending" }]);
      }),
    fileChanged: (path) => onFileChanged(path),
    needsLogin: () => setSettingsOpen(true),
  }), [onFileChanged]);

  const answer = (id: string, a: Approval) => {
    resolvers.current.get(id)?.(a);
    resolvers.current.delete(id);
    setItems((xs) => xs.map((x) => (x.id === id ? ({ ...x, state: a.allow ? "approved" : "rejected" } as Item) : x)));
  };

  // Desplazar al final mientras llega la respuesta, salvo que la persona haya subido.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const makeSession = (): Session => {
    const exe = cli?.exe ?? "";
    switch (provider) {
      case "anthropic":
        return new AnthropicSession(keys.anthropic ?? "", model, host);
      case "gemini":
        return new GeminiSession(keys.gemini ?? "", model, host);
      case "claude-code":
        return new ClaudeCodeSession(model, host, exe);
      case "copilot":
        return new AcpSession(COPILOT, model, host, exe);
      case "gemini-cli":
        return new AcpSession(GEMINI_CLI, model, host, exe);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy || needsKey || needsCli) return;
    setInput("");
    stick.current = true;
    setItems((xs) => [...xs, { kind: "user", id: newId(), text }]);
    setBusy(true);
    try {
      session.current ??= makeSession();
      await session.current.send(text, getContext());
    } catch (e) {
      setItems((xs) => [...xs, { kind: "error", id: newId(), text: tErr(e instanceof Error ? e.message : e) }]);
    }
    setBusy(false);
    inputRef.current?.focus();
  };

  const stop = () => {
    session.current?.stop();
    resolvers.current.forEach((r) => r({ allow: false, message: "Stopped by the user." }));
    resolvers.current.clear();
    setItems((xs) => xs.map((x) => (x.kind === "approval" && x.state === "pending" ? { ...x, state: "rejected" } : x)));
  };

  const saveKey = async (value: string | null) => {
    if (!keyProvider) return;
    try {
      await backend.keySet(keyProvider, value);
      setKeys((k) => ({ ...k, [keyProvider]: value?.trim() || null }));
      setKeyDraft("");
      reset();
    } catch (e) {
      setItems((xs) => [...xs, { kind: "error", id: newId(), text: tErr(e) }]);
    }
  };

  const ctx = getContext();
  // Con una CLI, la sesión (iniciar, cerrar, comprobar) se ve al empezar cada conversación.
  const showSetup = settingsOpen || needsKey || needsCli || (!!cliProgram && !items.length);

  return (
    <aside className="ai-panel" style={{ width }}>
      <div className="ai-header">
        <Codicon name="sparkle" />
        <select className="ai-select" value={provider} onChange={(e) => choose({ provider: e.target.value as ProviderId })} title={t("Proveedor de IA")}>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <select className="ai-select ai-model" value={model} onChange={(e) => choose({ model: e.target.value })} disabled={!models.length} title={t("Modelo")}>
          {!models.some((m) => m.id === model) && model && <option value={model}>{model}</option>}
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <span className="spacer" />
        <button className="icon-btn" title={t("Nueva conversación")} onClick={reset} disabled={!items.length}>
          <Codicon name="add" />
        </button>
        <button className={"icon-btn" + (settingsOpen ? " active" : "")} title={t("Configurar")} onClick={() => setSettingsOpen((o) => !o)}>
          <Codicon name="settings-gear" />
        </button>
        <button className="icon-btn" title={t("Cerrar")} onClick={onClose}>
          <Codicon name="close" />
        </button>
      </div>

      {showSetup && (
        <div className="ai-setup">
          {keyProvider && (
            <>
              <div className="ai-setup-title">{keyProvider === "anthropic" ? t("Clave de API de Anthropic") : t("Clave de API de Gemini")}</div>
              <p className="muted small">
                {keys[keyProvider]
                  ? t("Hay una clave guardada en el llavero del sistema.")
                  : keyProvider === "anthropic"
                    ? t("Crea una en la consola de Anthropic. Se guarda en el llavero del sistema y solo se usa para hablar con Anthropic desde tu equipo.")
                    : t("Crea una en Google AI Studio. Se guarda en el llavero del sistema y solo se usa para hablar con Gemini desde tu equipo.")}
              </p>
              <div className="ai-key-row">
                <input
                  type="password"
                  placeholder={keys[keyProvider] ? "••••••••••••" : keyProvider === "anthropic" ? "sk-ant-…" : "AIza…"}
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && keyDraft.trim() && void saveKey(keyDraft)}
                />
                <button className="btn primary" disabled={!keyDraft.trim()} onClick={() => void saveKey(keyDraft)}>{t("Guardar")}</button>
                {keys[keyProvider] && <button className="btn" onClick={() => void saveKey(null)}>{t("Borrar")}</button>}
              </div>
              <button className="link-btn small" onClick={() => void openUrl(keyProvider === "anthropic" ? "https://platform.claude.com/settings/keys" : "https://aistudio.google.com/apikey")}>
                <Codicon name="link-external" /> {keyProvider === "anthropic" ? t("Obtener una clave de Anthropic") : t("Obtener una clave de Gemini")}
              </button>
              {modelsError && <p className="small err">{modelsError}</p>}
            </>
          )}
          {cliProgram && (
            <CliSetup
              program={cliProgram}
              info={cli?.[cliProgram] ?? null}
              onRunInTerminal={onRunInTerminal}
              onRecheck={() => void backend.cliStatus().then(setCli)}
            />
          )}
        </div>
      )}

      <div
        className="ai-messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!items.length && (
          <div className="ai-empty">
            <Codicon name="sparkle" />
            <p>{t("Pregunta sobre tu código, pide que corrija los errores o que cree algo nuevo. La IA puede leer el proyecto, compilarlo y probarlo; los cambios los apruebas tú.")}</p>
            {ctx.roots.length > 0 &&
              [t("Compila el proyecto y explícame los errores"), t("¿Qué hace el archivo abierto?"), t("Agrega pruebas para las funciones de este archivo")].map((s) => (
                <button key={s} className="ai-suggestion" onClick={() => setInput(s)}>{s}</button>
              ))}
          </div>
        )}
        {items.map((it) => {
          switch (it.kind) {
            case "user":
              return <div key={it.id} className="ai-msg user">{it.text}</div>;
            case "assistant":
              return <div key={it.id} className="ai-msg assistant"><Markdown text={it.text} /></div>;
            case "thinking":
              return <Thinking key={it.id} text={it.text} />;
            case "tool":
              return <ToolCard key={it.id} item={it} />;
            case "approval":
              return <ApprovalCard key={it.id} item={it} onAnswer={(a) => answer(it.id, a)} />;
            case "plan":
              return (
                <div key={it.id} className="ai-plan">
                  {it.entries.map((e, i) => (
                    <div key={i} className={`ai-plan-entry ${e.status}`}>
                      <Codicon name={e.status === "completed" ? "pass" : e.status === "in_progress" ? "loading" : "circle-large-outline"} spin={e.status === "in_progress"} /> {e.content}
                    </div>
                  ))}
                </div>
              );
            case "error":
              return <div key={it.id} className="ai-msg error"><Codicon name="error" /> <span>{it.text}</span></div>;
            case "info":
              return <div key={it.id} className="ai-msg info"><Codicon name="info" /> <span>{it.text}</span></div>;
          }
        })}
        {busy && !items.some((x) => x.kind === "approval" && x.state === "pending") && (
          <div className="ai-working"><Codicon name="loading" spin /> {t("Trabajando…")}</div>
        )}
      </div>

      <div className="ai-input">
        {ctx.activeFile && (
          <button className="ai-context" title={ctx.activeFile} onClick={() => onOpenFile(ctx.activeFile!)}>
            <Codicon name="file" /> {ctx.activeFile.split(/[\\/]/).pop()}
            {ctx.selection && <span className="muted"> · {t("selección")}</span>}
          </button>
        )}
        <textarea
          ref={inputRef}
          rows={3}
          value={input}
          disabled={needsKey || !!needsCli}
          placeholder={needsKey ? t("Guarda una clave de API para empezar") : needsCli ? t("Instala la herramienta para empezar") : t("Escribe un mensaje (Enter envía, Shift+Enter: nueva línea)")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="ai-input-actions">
          <span className="muted small">{ctx.roots.length ? "" : t("Sin proyecto abierto: la IA no podrá usar archivos.")}</span>
          <span className="spacer" />
          {busy ? (
            <button className="btn" onClick={stop}><Codicon name="debug-stop" /> {t("Detener")}</button>
          ) : (
            <button className="btn primary" onClick={() => void send()} disabled={!input.trim() || needsKey || !!needsCli}>
              <Codicon name="send" /> {t("Enviar")}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
