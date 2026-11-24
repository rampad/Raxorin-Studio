import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CrateDetails, DepKind, Dependency } from "../../api";
import type { Recommendation } from "../../recommendations";
import { Codicon, FileIcon } from "../Icon";
import Readme from "./Readme";
import { compareVersions, formatCount, formatDate, isBreaking, libName, stripReq, timeAgo } from "./format";

export interface DetailActions {
  install: (opts: { version: string; features: string[]; kind: DepKind; defaultFeatures: boolean }) => void;
  change: (dep: Dependency, opts: { version: string; features: string[]; defaultFeatures: boolean }) => void;
  remove: (dep: Dependency) => void;
}

interface Props {
  name: string;
  details: CrateDetails | null;
  detailsError: string;
  installed?: Dependency;
  recommendation?: Recommendation;
  busy: boolean;
  actions: DetailActions;
}

const KIND_LABEL: Record<DepKind, string> = {
  normal: "Dependencia normal",
  dev: "Solo para pruebas (dev)",
  build: "Para build.rs (build)",
};
const SECTION: Record<DepKind, string> = {
  normal: "[dependencies]",
  dev: "[dev-dependencies]",
  build: "[build-dependencies]",
};

export default function CrateDetail({ name, details, detailsError, installed, recommendation, busy, actions }: Props) {
  const [view, setView] = useState<"info" | "readme">("info");
  const [version, setVersion] = useState("");
  const [features, setFeatures] = useState<string[]>([]);
  const [defaultFeatures, setDefaultFeatures] = useState(true);
  const [kind, setKind] = useState<DepKind>("normal");
  const [featureFilter, setFeatureFilter] = useState("");

  const installedVersion = installed ? installed.resolved ?? stripReq(installed.req) : null;

  // Estado inicial: lo instalado o, si no, la última versión + lo que sugiere la recomendación.
  useEffect(() => {
    setView("info");
    setFeatureFilter("");
    setFeatures(installed?.features ?? recommendation?.features ?? []);
    setDefaultFeatures(installed?.defaultFeatures ?? true);
    setKind(installed?.kind ?? recommendation?.kind ?? "normal");
    setVersion(installed ? stripReq(installed.req) : "");
  }, [name, installed, recommendation]);

  useEffect(() => {
    if (details && !installed && !version) setVersion(details.versions[0]?.num ?? details.version);
  }, [details, installed, version]);

  const versionInfo = details?.versions.find((v) => v.num === version) ?? details?.versions[0];
  const defaults = new Set(versionInfo?.features["default"] ?? []);
  const allFeatures = useMemo(
    () => Object.keys(versionInfo?.features ?? {}).filter((f) => f !== "default" && !f.startsWith("_")).sort(),
    [versionInfo],
  );
  const shownFeatures = allFeatures.filter((f) => f.includes(featureFilter.trim()));

  // Vista previa de la línea que quedará en Cargo.toml.
  const tomlLine = useMemo(() => {
    const v = version || details?.version || "*";
    const feats = features.filter((f) => allFeatures.length === 0 || allFeatures.includes(f));
    if (feats.length === 0 && defaultFeatures) return `${name} = "${v}"`;
    const partsList = [`version = "${v}"`];
    if (!defaultFeatures) partsList.push("default-features = false");
    if (feats.length) partsList.push(`features = [${feats.map((f) => `"${f}"`).join(", ")}]`);
    return `${name} = { ${partsList.join(", ")} }`;
  }, [name, version, features, defaultFeatures, details, allFeatures]);

  const toggleFeature = (f: string) =>
    setFeatures((fs) => (fs.includes(f) ? fs.filter((x) => x !== f) : [...fs, f]));

  const changed =
    !!installed &&
    (stripReq(installed.req) !== version ||
      installed.defaultFeatures !== defaultFeatures ||
      [...installed.features].sort().join() !== [...features].sort().join());

  // ---------- Referencia a proyecto local (no está en crates.io) ----------
  if (installed?.path) {
    return (
      <div className="crate-detail">
        <div className="crate-title">
          <FileIcon name={name} project="lib" size={28} />
          <div>
            <h3>{name}</h3>
            <span className="muted">Proyecto local · {installed.path}</span>
          </div>
        </div>
        <p className="muted">Esta dependencia apunta a otro proyecto de tu carpeta, así que no tiene versiones en crates.io.</p>
        <pre className="toml-preview">{`${SECTION[installed.kind]}\n${name} = { path = "…" }`}</pre>
        <div className="detail-actions">
          <button className="btn danger" disabled={busy} onClick={() => actions.remove(installed)}>
            <Codicon name="trash" /> Quitar referencia
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="crate-detail">
      <div className="crate-title">
        <Codicon name="package" className="crate-title-icon" />
        <div className="crate-title-text">
          <h3>{name}</h3>
          {details && <span className="muted">{details.description}</span>}
        </div>
      </div>

      {detailsError && <div className="hint err">{detailsError}</div>}
      {!details && !detailsError && (
        <div className="muted"><Codicon name="loading" spin /> Consultando crates.io…</div>
      )}

      {details && (
        <>
          <div className="stats">
            <Stat icon="cloud-download" label="Descargas" value={formatCount(details.downloads)} />
            <Stat icon="graph-line" label="Últimos 90 días" value={formatCount(details.recentDownloads)} />
            <Stat icon="history" label="Actualizado" value={timeAgo(details.updatedAt)} />
            <Stat icon="law" label="Licencia" value={versionInfo?.license ?? "—"} />
            {versionInfo?.rustVersion && <Stat icon="versions" label="Rust mínimo" value={versionInfo.rustVersion} />}
          </div>

          <div className="links">
            <LinkBtn icon="book" label="Documentación" url={details.documentation ?? `https://docs.rs/${name}`} />
            {details.repository && <LinkBtn icon="github" label="Repositorio" url={details.repository} />}
            {details.homepage && details.homepage !== details.repository && (
              <LinkBtn icon="home" label="Sitio web" url={details.homepage} />
            )}
            <LinkBtn icon="package" label="crates.io" url={`https://crates.io/crates/${name}`} />
          </div>

          {/* ----- Instalar / cambiar ----- */}
          <div className="install-box">
            {installed && (
              <div className="installed-line">
                <Codicon name="pass-filled" className="ok" />
                Instalado <strong>{installedVersion}</strong>
                <span className="muted">· {KIND_LABEL[installed.kind]}</span>
                {details.version && compareVersions(details.version, installedVersion ?? "0") > 0 && (
                  <span className={"update-pill" + (isBreaking(installedVersion ?? "0", details.version) ? " breaking" : "")}>
                    <Codicon name="arrow-circle-up" /> {details.version} disponible
                  </span>
                )}
              </div>
            )}
            <div className="install-row">
              <label>
                Versión
                <select value={version} onChange={(e) => setVersion(e.target.value)}>
                  {installed && !details.versions.some((v) => v.num === version) && <option value={version}>{version}</option>}
                  {details.versions.map((v, i) => (
                    <option key={v.num} value={v.num}>
                      {v.num}
                      {i === 0 ? "  (última)" : ""}
                      {installedVersion === v.num ? "  · instalada" : ""} — {formatDate(v.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
              {!installed && (
                <label>
                  Tipo
                  <select value={kind} onChange={(e) => setKind(e.target.value as DepKind)}>
                    {(Object.keys(KIND_LABEL) as DepKind[]).map((k) => (
                      <option key={k} value={k}>{KIND_LABEL[k]}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="detail-actions">
              {!installed && (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => actions.install({ version, features, kind, defaultFeatures })}
                >
                  <Codicon name="cloud-download" /> Instalar
                </button>
              )}
              {installed && (
                <button
                  className="btn primary"
                  disabled={busy || !changed}
                  onClick={() => actions.change(installed, { version, features, defaultFeatures })}
                >
                  <Codicon name="check" /> Aplicar cambios
                </button>
              )}
              {installed && (
                <button className="btn danger" disabled={busy} onClick={() => actions.remove(installed)}>
                  <Codicon name="trash" /> Desinstalar
                </button>
              )}
            </div>
          </div>

          <div className="detail-tabs">
            <button className={view === "info" ? "active" : ""} onClick={() => setView("info")}>Detalles</button>
            <button className={view === "readme" ? "active" : ""} onClick={() => setView("readme")}>README</button>
          </div>

          {view === "readme" ? (
            <Readme name={name} version={version || details.version} />
          ) : (
            <>
              {/* ----- Features ----- */}
              <section>
                <h4>
                  Features <span className="muted">(funciones opcionales)</span>
                </h4>
                {allFeatures.length === 0 ? (
                  <p className="muted small">Este crate no tiene features opcionales.</p>
                ) : (
                  <>
                    <label className="check-line">
                      <input type="checkbox" checked={defaultFeatures} onChange={(e) => setDefaultFeatures(e.target.checked)} />
                      Incluir las features por defecto
                      {defaults.size > 0 && <span className="muted"> ({[...defaults].join(", ")})</span>}
                    </label>
                    {allFeatures.length > 12 && (
                      <input
                        className="feature-filter"
                        placeholder={`Filtrar ${allFeatures.length} features…`}
                        value={featureFilter}
                        onChange={(e) => setFeatureFilter(e.target.value)}
                      />
                    )}
                    <div className="feature-grid">
                      {shownFeatures.map((f) => {
                        const byDefault = defaultFeatures && defaults.has(f);
                        return (
                          <label key={f} className={"feature" + (byDefault ? " by-default" : "")} title={(versionInfo?.features[f] ?? []).join(", ")}>
                            <input
                              type="checkbox"
                              checked={features.includes(f) || byDefault}
                              disabled={byDefault}
                              onChange={() => toggleFeature(f)}
                            />
                            <span>{f}</span>
                            {recommendation?.features?.includes(f) && <span className="rec-tag">recomendada</span>}
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>

              {/* ----- Cómo queda y cómo se usa ----- */}
              <section>
                <h4>En tu Cargo.toml</h4>
                <pre className="toml-preview">{`${SECTION[installed?.kind ?? kind]}\n${tomlLine}`}</pre>
                <h4>En tu código</h4>
                <pre className="toml-preview">{usageSnippet(name, features)}</pre>
              </section>

              {(details.keywords.length > 0 || details.categories.length > 0) && (
                <section>
                  <h4>Etiquetas</h4>
                  <div className="chips">
                    {details.categories.map((c) => <span key={c} className="chip static cat">{c}</span>)}
                    {details.keywords.map((k) => <span key={k} className="chip static">#{k}</span>)}
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function usageSnippet(name: string, features: string[]) {
  const lib = libName(name);
  if (lib === "serde" && features.includes("derive")) {
    return "use serde::{Deserialize, Serialize};\n\n#[derive(Serialize, Deserialize)]\nstruct Persona {\n    nombre: String,\n}";
  }
  if (lib === "rand") return "let n: u32 = rand::random_range(1..=6); // un dado";
  if (lib === "anyhow") return "fn main() -> anyhow::Result<()> {\n    let texto = std::fs::read_to_string(\"datos.txt\")?;\n    Ok(())\n}";
  if (lib === "clap" && features.includes("derive")) {
    return "use clap::Parser;\n\n#[derive(Parser)]\nstruct Args {\n    nombre: String,\n}\n\nlet args = Args::parse();";
  }
  return `use ${lib}::…;`;
}

function Stat({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="stat">
      <Codicon name={icon} />
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

function LinkBtn({ icon, label, url }: { icon: string; label: string; url: string }) {
  return (
    <button className="link-btn" title={url} onClick={() => openUrl(url).catch(() => {})}>
      <Codicon name={icon} /> {label}
    </button>
  );
}
