// Configuración de las CLI de IA en el chat (Claude Code, GitHub Copilot, Gemini CLI): instalarlas,
// iniciar y cerrar sesión. Los comandos se ejecutan en el terminal integrado, a la vista, porque
// el inicio de sesión abre el navegador o pide elegir opciones.
import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Codicon } from "../components/Icon";
import { t } from "../i18n/index.ts";
import { backend, type CliAuth, type CliInfo, type CliProgram } from "./backend";

const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

interface Spec {
  title: string;
  install: string;
  needsNode: boolean;
  docs: string;
  logins: { label: string; command: string; hint?: string }[];
  logout?: string;
  uses: string;
}

function spec(program: CliProgram): Spec {
  switch (program) {
    case "claude":
      return {
        title: "Claude Code",
        install: windows ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash",
        needsNode: false,
        docs: "https://code.claude.com/docs/en/setup",
        logins: [
          { label: t("Iniciar sesión con Claude"), command: "claude auth login", hint: t("Con tu suscripción de Claude (Pro o Max).") },
          { label: t("Con la consola de Anthropic"), command: "claude auth login --console", hint: t("Con tu cuenta de la consola de Anthropic: se cobra como uso de la API, sin clave.") },
        ],
        logout: "claude auth logout",
        uses: t("Usa el Claude Code instalado en tu equipo, con su sesión."),
      };
    case "copilot":
      return {
        title: "GitHub Copilot",
        install: "npm install -g @github/copilot",
        needsNode: true,
        docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli",
        logins: [{ label: t("Iniciar sesión con GitHub"), command: "copilot login", hint: t("Se abre el navegador para autorizar con tu cuenta de GitHub (necesita una suscripción de Copilot).") }],
        uses: t("Usa la CLI de GitHub Copilot instalada en tu equipo, con su sesión."),
      };
    case "gemini":
      return {
        title: "Gemini CLI",
        install: "npm install -g @google/gemini-cli",
        needsNode: true,
        docs: "https://github.com/google-gemini/gemini-cli",
        logins: [{ label: t("Iniciar sesión con Google"), command: "gemini", hint: t("En el terminal elige «Sign in with Google» y sigue el navegador; cuando termine, escribe /quit.") }],
        uses: t("Usa Gemini CLI instalado en tu equipo, con tu cuenta de Google (sin clave de API)."),
      };
  }
}

const methodLabel = (m: string | null) =>
  m === "claude.ai" ? t("suscripción de Claude") : m === "console" || m === "console_oauth" ? t("consola de Anthropic") : m === "google" ? "Google" : m ?? "";

export default function CliSetup({ program, info, onRunInTerminal, onRecheck }: {
  program: CliProgram;
  info: CliInfo | null;
  onRunInTerminal: (command: string) => void;
  /** Volver a buscar las CLI instaladas. */
  onRecheck: () => void;
}) {
  const s = spec(program);
  const [auth, setAuth] = useState<CliAuth | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const check = useCallback(() => {
    if (info) void backend.cliAuth(program).then(setAuth).catch(() => setAuth(null));
    else setAuth(null);
  }, [program, info]);

  useEffect(() => {
    check();
    // Al volver del navegador (tras iniciar sesión), comprobar otra vez.
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [check]);

  const run = (command: string, after?: string) => {
    onRunInTerminal(command);
    setHint(after ?? null);
  };

  return (
    <>
      <div className="ai-setup-title">{s.title}</div>
      {!info ? (
        <>
          <p className="muted small">
            {s.needsNode
              ? t("{0} no está instalado. Se instala con npm (necesita Node.js):", s.title)
              : t("{0} no está instalado. Se instala con su instalador oficial:", s.title)}
          </p>
          <pre className="ai-command">{s.install}</pre>
          <div className="ai-cli-actions">
            <button className="btn primary" onClick={() => run(s.install, t("Cuando termine la instalación, pulsa «Volver a buscar»."))}>
              <Codicon name="cloud-download" /> {t("Instalar en el terminal")}
            </button>
            <button className="btn" onClick={onRecheck}>
              <Codicon name="refresh" /> {t("Volver a buscar")}
            </button>
          </div>
          <button className="link-btn small" onClick={() => void openUrl(s.docs)}>
            <Codicon name="link-external" /> {t("Documentación")}
          </button>
        </>
      ) : (
        <>
          <p className="muted small">{s.uses} <span className="ai-version">{info.version}</span></p>
          <div className={"ai-auth " + (auth?.loggedIn ? "ok" : auth?.loggedIn === false ? "no" : "")}>
            <Codicon name={auth?.loggedIn ? "pass" : auth?.loggedIn === false ? "circle-slash" : "question"} />
            <span>
              {auth?.loggedIn
                ? [t("Sesión iniciada"), auth.account, methodLabel(auth.method)].filter(Boolean).join(" · ")
                : auth?.loggedIn === false
                  ? t("Sin sesión iniciada")
                  : t("Si no has iniciado sesión, el chat te lo dirá al enviar un mensaje.")}
            </span>
          </div>
          <div className="ai-cli-actions">
            {s.logins.map((l, i) => (
              <button key={l.command} className={"btn" + (i === 0 && !auth?.loggedIn ? " primary" : "")} title={l.hint} onClick={() => run(l.command, l.hint)}>
                <Codicon name={i === 0 ? "account" : "key"} /> {l.label}
              </button>
            ))}
            {s.logout && auth?.loggedIn && (
              <button className="btn" onClick={() => run(s.logout!)}>
                <Codicon name="sign-out" /> {t("Cerrar sesión")}
              </button>
            )}
            <button className="icon-btn" title={t("Comprobar")} onClick={check}>
              <Codicon name="refresh" />
            </button>
          </div>
        </>
      )}
      {hint && (
        <p className="small ai-cli-hint">
          <Codicon name="terminal" /> {t("Se abrió el terminal abajo.")} {hint}
        </p>
      )}
    </>
  );
}
