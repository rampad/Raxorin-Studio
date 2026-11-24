import { useState } from "react";
import type { ToolchainStatus } from "../api";
import { Codicon } from "./Icon";

export const COMPONENTS: { key: keyof ToolchainStatus; name: string; what: string }[] = [
  { key: "rustAnalyzer", name: "rust-analyzer", what: "autocompletado e ir a definición" },
  { key: "clippy", name: "clippy", what: "sugerencias de código" },
  { key: "rustfmt", name: "rustfmt", what: "formatear código" },
  { key: "rustSrc", name: "rust-src", what: "autocompletado de la biblioteca estándar" },
];

export function missingComponents(s: ToolchainStatus | null) {
  if (!s || !s.cargo) return [];
  return COMPONENTS.filter((c) => !s[c.key]);
}

interface Props {
  status: ToolchainStatus | null;
  onInstall: (names: string[]) => Promise<void>;
}

export default function ToolchainBanner({ status, onInstall }: Props) {
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden || !status) return null;

  if (!status.cargo) {
    return (
      <div className="banner error">
        <Codicon name="warning" />
        <span>No se encontró Rust en este equipo. Instálalo desde <strong>https://rustup.rs</strong> y reinicia Rust Studio.</span>
      </div>
    );
  }
  const missing = missingComponents(status);
  if (missing.length === 0) return null;

  return (
    <div className="banner">
      <Codicon name="extensions" />
      <span>
        Faltan herramientas: {missing.map((m) => `${m.name} (${m.what})`).join(", ")}.
      </span>
      <span className="spacer" />
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onInstall(missing.map((m) => m.name)).finally(() => setBusy(false));
        }}
      >
        {busy ? <><Codicon name="loading" spin /> Instalando… (puede tardar un minuto)</> : "Instalar"}
      </button>
      <button className="btn" disabled={busy} onClick={() => setHidden(true)}>Ahora no</button>
    </div>
  );
}
