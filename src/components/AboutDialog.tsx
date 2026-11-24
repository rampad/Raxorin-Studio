import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Codicon } from "./Icon";
import raxorinMark from "../assets/brand/raxorin-mark.svg";
import licenseText from "../../LICENSE?raw";

export const GITHUB_URL = "https://github.com/rampad/Raxorin-Studio";

const CREDITS: { name: string; license: string; url: string }[] = [
  { name: "Tauri", license: "MIT / Apache-2.0", url: "https://tauri.app" },
  { name: "Monaco Editor", license: "MIT", url: "https://github.com/microsoft/monaco-editor" },
  { name: "rust-analyzer", license: "MIT / Apache-2.0", url: "https://rust-analyzer.github.io" },
  { name: "CodeLLDB (depurador en Windows y Linux)", license: "MIT", url: "https://github.com/vadimcn/codelldb" },
  { name: "Slint", license: "GPL-3.0 / Royalty-free / comercial", url: "https://slint.dev" },
  { name: "Codicons", license: "CC BY 4.0", url: "https://github.com/microsoft/vscode-codicons" },
  { name: "Material Icon Theme", license: "MIT", url: "https://github.com/material-extensions/vscode-material-icon-theme" },
  { name: "React", license: "MIT", url: "https://react.dev" },
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
              <span className="brand-accent">Raxorin</span> Studio
            </h2>
            <div className="muted">Versión {version || "…"} · IDE para crear programas en Rust de forma fácil</div>
            <div className="muted small">© 2026 Benjamin · Licencia MIT</div>
          </div>
        </div>

        <div className="about-links">
          <button className="link-btn" onClick={link(GITHUB_URL)}>
            <Codicon name="github" /> Repositorio en GitHub
          </button>
          <button className="link-btn" onClick={link(GITHUB_URL + "/releases")}>
            <Codicon name="cloud-download" /> Versiones e instaladores
          </button>
          <button className="link-btn" onClick={link(GITHUB_URL + "/issues/new")}>
            <Codicon name="bug" /> Reportar un problema
          </button>
          {onCheckUpdates && (
            <button className="link-btn" onClick={onCheckUpdates}>
              <Codicon name="sync" /> Buscar actualizaciones
            </button>
          )}
          <button className={"link-btn" + (showLicense ? " active" : "")} onClick={() => setShowLicense((v) => !v)}>
            <Codicon name="law" /> {showLicense ? "Ocultar licencia" : "Ver licencia"}
          </button>
        </div>

        {showLicense ? (
          <pre className="license-text">{licenseText}</pre>
        ) : (
          <div className="credits">
            <div className="set-title">Hecho con</div>
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
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
