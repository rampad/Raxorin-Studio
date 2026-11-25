import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Codicon } from "./Icon";
import raxorinMark from "../assets/brand/raxorin-mark.svg";
import licenseText from "../../LICENSE?raw";
import { t } from "../i18n/index.ts";

export const GITHUB_URL = "https://github.com/rampad/Raxorin-Studio";

const CREDITS: { name: string; license: string; url: string }[] = [
  { name: t("Tauri"), license: "MIT / Apache-2.0", url: "https://tauri.app" },
  { name: t("Monaco Editor"), license: "MIT", url: "https://github.com/microsoft/monaco-editor" },
  { name: "rust-analyzer", license: "MIT / Apache-2.0", url: "https://rust-analyzer.github.io" },
  { name: t("CodeLLDB (depurador en Windows y Linux)"), license: "MIT", url: "https://github.com/vadimcn/codelldb" },
  { name: t("Slint"), license: "GPL-3.0 / Royalty-free / comercial", url: "https://slint.dev" },
  { name: t("Codicons"), license: "CC BY 4.0", url: "https://github.com/microsoft/vscode-codicons" },
  { name: t("Material Icon Theme"), license: "MIT", url: "https://github.com/material-extensions/vscode-material-icon-theme" },
  { name: t("React"), license: "MIT", url: "https://react.dev" },
];

/** Acerca de: versión, licencia MIT, enlaces a GitHub y créditos. */
export default function AboutDialog({ onClose, onCheckUpdates }: { onClose: () => void; onCheckUpdates?: () => void }) {
  const [version, setVersion] = useState("");
  const [showLicense, setShowLicense] = useState(false);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const link = (url: string) => () => openUrl(url).catch(() => {});

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal about" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="about-head">
          <img src={raxorinMark} width={64} height={64} alt="" />
          <div>
            <h2>
              <span className="brand-accent">{t("Raxorin")}</span> {" "}{t("Studio")}
            </h2>
            <div className="muted">{t("Versión")}{" "}{version || "…"} {" "}{t("· IDE para crear programas en Rust de forma fácil")}</div>
            <div className="muted small">{t("© 2026 Benjamin · Licencia MIT")}</div>
          </div>
        </div>

        <div className="about-links">
          <button className="link-btn" onClick={link(GITHUB_URL)}>
            <Codicon name="github" /> {" "}{t("Repositorio en GitHub")}
          </button>
          <button className="link-btn" onClick={link(GITHUB_URL + "/releases")}>
            <Codicon name="cloud-download" /> {" "}{t("Versiones e instaladores")}
          </button>
          <button className="link-btn" onClick={link(GITHUB_URL + "/issues/new")}>
            <Codicon name="bug" /> {" "}{t("Reportar un problema")}
          </button>
          {onCheckUpdates && (
            <button className="link-btn" onClick={onCheckUpdates}>
              <Codicon name="sync" /> {" "}{t("Buscar actualizaciones")}
            </button>
          )}
          <button className={"link-btn" + (showLicense ? " active" : "")} onClick={() => setShowLicense((v) => !v)}>
            <Codicon name="law" /> {showLicense ? t("Ocultar licencia") : t("Ver licencia")}
          </button>
        </div>

        {showLicense ? (
          <pre className="license-text">{licenseText}</pre>
        ) : (
          <div className="credits">
            <div className="set-title">{t("Hecho con")}</div>
            {CREDITS.map((c) => (
              <button key={c.name} className="credit-row" onClick={link(c.url)} title={c.url}>
                <span>{c.name}</span>
                <span className="muted">{c.license}</span>
                <Codicon name="link-external" className="muted" />
              </button>
            ))}
          </div>
        )}

        <div className="actions">
          <span className="spacer" />
          <button className="btn primary" onClick={onClose} autoFocus>
            
            {t("Cerrar")}
          </button>
        </div>
      </div>
    </div>
  );
}
