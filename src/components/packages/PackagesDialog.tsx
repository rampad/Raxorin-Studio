import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CrateDetails, type CrateSummary, type DepKind, type Dependency, type ToolchainStatus } from "../../api";
import { CATEGORIES, contextual, type Recommendation } from "../../recommendations";
import { Codicon, FileIcon } from "../Icon";
import { COMPONENTS } from "../ToolchainBanner";
import CrateDetail, { type DetailActions } from "./CrateDetail";
import { compareVersions, formatCount, isBreaking, stripReq, timeAgo } from "./format";
import { t, tErr } from "../../i18n/index.ts";

type Tab = "browse" | "installed" | "updates" | "recommended" | "essentials";

interface Props {
  project: string;
  title?: string;
  projectKind: "bin" | "lib";
  toolchain: ToolchainStatus | null;
  onInstallComponents: (names: string[]) => Promise<void>;
  onClose: () => void;
  /** Tras agregar/quitar: recargar Cargo.toml y avisar a rust-analyzer. */
  onChanged: (message: string) => void;
}

const norm = (n: string) => n.replace(/-/g, "_");

export default function PackagesDialog(p: Props) {
  const [tab, setTab] = useState<Tab>("browse");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CrateSummary[]>([]);
  const [page, setPage] = useState(1);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [installed, setInstalled] = useState<Dependency[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [latest, setLatest] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<{ name: string; rec?: Recommendation } | null>(null);
  const [details, setDetails] = useState<CrateDetails | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const cache = useRef(new Map<string, CrateDetails>());
  const searchSeq = useRef(0);

  const find = useCallback((name: string) => installed.find((d) => norm(d.name) === norm(name)), [installed]);

  // ---------- Carga de datos ----------

  const loadInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const deps = await api.crateList(p.project);
      setInstalled(deps);
      const names = deps.filter((d) => !d.path).map((d) => d.name);
      if (names.length) api.crateLatest(names).then(setLatest).catch(() => {});
    } catch (e) {
      setStatus({ text: tErr(e), error: true });
    } finally {
      setLoadingInstalled(false);
    }
  }, [p.project]);

  useEffect(() => {
    loadInstalled();
  }, [loadInstalled]);

  const search = useCallback(async (q: string, pg = 1) => {
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError("");
    try {
      const res = await api.crateSearch(q, pg);
      if (seq !== searchSeq.current) return; // llegó una búsqueda más nueva
      setResults((r) => (pg === 1 ? res : [...r, ...res]));
      setPage(pg);
    } catch (e) {
      if (seq === searchSeq.current) setSearchError(tErr(e));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  // Búsqueda mientras se escribe (con una pequeña espera).
  useEffect(() => {
    if (tab !== "browse") return;
    const t = setTimeout(() => search(query), query ? 350 : 0);
    return () => clearTimeout(t);
  }, [query, tab, search]);

  // Detalles del crate seleccionado (con caché).
  useEffect(() => {
    if (!selected) return;
    const dep = find(selected.name);
    if (dep?.path) {
      setDetails(null);
      return;
    }
    const cached = cache.current.get(selected.name);
    setDetailsError("");
    if (cached) {
      setDetails(cached);
      return;
    }
    setDetails(null);
    let alive = true;
    api
      .crateDetails(selected.name)
      .then((d) => {
        cache.current.set(selected.name, d);
        if (alive) setDetails(d);
      })
      .catch((e) => alive && setDetailsError(tErr(e)));
    return () => {
      alive = false;
    };
  }, [selected, find]);

  // ---------- Acciones ----------

  const run = async (label: string, action: () => Promise<string | void>, done: string) => {
    setBusy(label);
    setStatus({ text: label });
    try {
      const out = await action();
      setStatus({ text: done });
      p.onChanged(typeof out === "string" && out.trim() ? out.trim() : done);
      await loadInstalled();
    } catch (e) {
      setStatus({ text: tErr(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const actions: DetailActions = {
    install: ({ version, features, kind, defaultFeatures }) =>
      selected &&
      run(
        `Instalando ${selected.name} ${version}…`,
        () => api.crateAdd(p.project, selected.name, { version, features, kind, defaultFeatures }),
        `Instalado ${selected.name} ${version}`,
      ),
    change: (dep, { version, features, defaultFeatures }) =>
      run(
        `Actualizando ${dep.name}…`,
        () => api.crateSetFeatures(p.project, { ...dep, req: version }, features, defaultFeatures),
        `${dep.name} actualizado a ${version}`,
      ),
    remove: (dep) =>
      run(`Quitando ${dep.name}…`, () => api.crateRemove(p.project, dep.name, dep.kind), `Quitado ${dep.name}`),
  };

  const currentOf = (d: Dependency) => d.resolved ?? stripReq(d.req);
  const updates = useMemo(
    () => installed.filter((d) => !d.path && latest[d.name] && compareVersions(latest[d.name], currentOf(d)) > 0),
    [installed, latest],
  );

  const updateAll = async () => {
    for (const d of updates) {
      await run(
        `Actualizando ${d.name} a ${latest[d.name]}…`,
        () => api.crateAdd(p.project, d.name, { version: latest[d.name], kind: d.kind }),
        `${d.name} actualizado a ${latest[d.name]}`,
      );
    }
  };

  const missingTools = COMPONENTS.filter((c) => p.toolchain && !p.toolchain[c.key]);

  // ---------- Listas ----------

  const select = (name: string, rec?: Recommendation) => setSelected({ name, rec });
  const isSel = (name: string) => selected?.name === name;

  const installedBadge = (name: string) => {
    const d = find(name);
    if (!d) return null;
    const cur = currentOf(d);
    const up = latest[d.name] && compareVersions(latest[d.name], cur) > 0;
    return (
      <span className={"pill " + (up ? "update" : "ok")}>
        <Codicon name={up ? "arrow-circle-up" : "pass-filled"} /> {up ? `${cur} → ${latest[d.name]}` : cur}
      </span>
    );
  };

  const summaryRow = (c: CrateSummary) => (
    <div key={c.name} className={"pkg-row" + (isSel(c.name) ? " selected" : "")} onClick={() => select(c.name)}>
      <Codicon name="package" className="pkg-row-icon" />
      <div className="pkg-row-main">
        <div className="pkg-row-top">
          <strong>{c.name}</strong>
          <span className="muted">{c.version}</span>
          <span className="spacer" />
          {installedBadge(c.name)}
        </div>
        <div className="pkg-desc">{c.description}</div>
        <div className="pkg-meta muted">
          <span><Codicon name="cloud-download" /> {formatCount(c.downloads)}</span>
          <span><Codicon name="history" /> {timeAgo(c.updatedAt)}</span>
        </div>
      </div>
    </div>
  );

  const depRow = (d: Dependency) => (
    <div key={d.kind + d.name} className={"pkg-row" + (isSel(d.name) ? " selected" : "")} onClick={() => select(d.name)}>
      {d.path ? <span className="pkg-row-icon"><FileIcon name={d.name} project="lib" size={20} /></span> : <Codicon name="package" className="pkg-row-icon" />}
      <div className="pkg-row-main">
        <div className="pkg-row-top">
          <strong>{d.name}</strong>
          {d.path ? <span className="pill local">{t("proyecto local")}</span> : <span className="muted">{d.req}</span>}
          <span className="spacer" />
          {!d.path && installedBadge(d.name)}
        </div>
        <div className="pkg-meta muted">
          {d.resolved ? <span>{t("en uso:")}{" "}{d.resolved}</span> : !d.path && <span>{t("se resolverá al compilar")}</span>}
          {d.features.length > 0 && <span>features: {d.features.join(", ")}</span>}
          {!d.defaultFeatures && <span>{t("sin features por defecto")}</span>}
          {d.optional && <span>opcional</span>}
        </div>
      </div>
    </div>
  );

  const recRow = (r: Recommendation & { because?: string }) => (
    <div key={r.name + (r.because ?? "")} className={"pkg-row" + (isSel(r.name) ? " selected" : "")} onClick={() => select(r.name, r)}>
      <Codicon name="package" className="pkg-row-icon" />
      <div className="pkg-row-main">
        <div className="pkg-row-top">
          <strong>{r.name}</strong>
          {r.starter && <span className="pill starter">{t("ideal para empezar")}</span>}
          {r.kind === "dev" && <span className="pill">pruebas</span>}
          {r.kind === "build" && <span className="pill">build</span>}
          <span className="spacer" />
          {installedBadge(r.name)}
        </div>
        <div className="pkg-desc">{r.why}</div>
        {(r.because || r.features?.length) && (
          <div className="pkg-meta muted">
            {r.because && <span><Codicon name="lightbulb" /> {r.because}</span>}
            {r.features?.length ? <span>features: {r.features.join(", ")}</span> : null}
          </div>
        )}
      </div>
    </div>
  );

  const groups: [DepKind, string][] = [["normal", "Dependencias"], ["dev", t("Solo para pruebas (dev)")], ["build", t("Para build.rs (build)")]];
  const suggestions = contextual(installed, p.projectKind);

  const list = () => {
    switch (tab) {
      case "browse":
        return (
          <>
            {!query && <div className="list-header">{t("Más descargados recientemente")}</div>}
            {results.map(summaryRow)}
            {searchError && <div className="pad hint err">{searchError}</div>}
            {searching && <div className="pad muted"><Codicon name="loading" spin /> {" "}{t("Buscando en crates.io…")}</div>}
            {!searching && results.length === 0 && !searchError && <div className="pad muted">{t("Sin resultados para “")}{query}”.</div>}
            {!searching && results.length >= page * 30 && (
              <button className="btn load-more" onClick={() => search(query, page + 1)}>{t("Cargar más")}</button>
            )}
          </>
        );
      case "installed":
        if (loadingInstalled && installed.length === 0) return <div className="pad muted"><Codicon name="loading" spin /> {" "}{t("Leyendo Cargo.toml…")}</div>;
        if (installed.length === 0)
          return (
            <div className="empty-state">
              <Codicon name="package" />
              <p>{t("Este proyecto aún no tiene paquetes.")}</p>
              <button className="btn primary" onClick={() => setTab("recommended")}>{t("Ver recomendados")}</button>
            </div>
          );
        return groups.map(([k, label]) => {
          const ds = installed.filter((d) => d.kind === k);
          if (ds.length === 0) return null;
          return (
            <div key={k}>
              <div className="list-header">{label} <span className="muted">({ds.length})</span></div>
              {ds.map(depRow)}
            </div>
          );
        });
      case "updates":
        if (updates.length === 0)
          return (
            <div className="empty-state">
              <Codicon name="pass" className="ok" />
              <p>{t("Todo está al día.")}</p>
            </div>
          );
        return (
          <>
            <div className="list-header row">
              <span>{updates.length} {" "}{t("actualización(es) disponible(s)")}</span>
              <span className="spacer" />
              <button className="btn small primary" disabled={!!busy} onClick={updateAll}>{t("Actualizar todo")}</button>
            </div>
            {updates.some((d) => isBreaking(currentOf(d), latest[d.name])) && (
              <div className="pad small warn-text">
                <Codicon name="warning" /> {" "}{t("Las marcadas en naranja son versiones mayores: pueden requerir cambios en tu código.")}
              </div>
            )}
            {updates.map(depRow)}
          </>
        );
      case "recommended":
        return (
          <>
            {suggestions.length > 0 && (
              <div>
                <div className="list-header"><Codicon name="lightbulb" /> {" "}{t("Sugeridos para este proyecto")}</div>
                {suggestions.map(recRow)}
              </div>
            )}
            {CATEGORIES.map((c) => (
              <div key={c.id}>
                <div className="list-header"><Codicon name={c.icon} /> {c.title}</div>
                {c.items.map((r) => recRow(r))}
              </div>
            ))}
          </>
        );
      case "essentials":
        return (
          <div className="essentials">
            <p className="muted small">
              
              {t("Estas herramientas no se agregan a tu proyecto: las usa Raxorin Studio para el autocompletado, revisar y formatear tu código.")}
            </p>
            {COMPONENTS.map((c) => {
              const ok = !!p.toolchain?.[c.key];
              return (
                <div key={c.name} className="tool-row">
                  <Codicon name={ok ? "pass-filled" : "circle-large"} className={ok ? "ok" : "warn"} />
                  <div className="pkg-row-main">
                    <strong>{c.name}</strong>
                    <div className="muted small">{c.what}</div>
                  </div>
                  <span className={"pill " + (ok ? "ok" : "update")}>{ok ? t("Instalado") : t("Falta")}</span>
                </div>
              );
            })}
            {missingTools.length > 0 && (
              <button
                className="btn primary"
                disabled={!!busy}
                onClick={async () => {
                  setBusy("Instalando herramientas…");
                  setStatus({ text: t("Instalando herramientas con rustup… (puede tardar un minuto)") });
                  await p.onInstallComponents(missingTools.map((m) => m.name));
                  setBusy(null);
                  setStatus({ text: t("Herramientas instaladas") });
                }}
              >
                <Codicon name="cloud-download" /> {" "}{t("Instalar lo que falta (")}{missingTools.length})
              </button>
            )}
            <div className="list-header">{t("Toolchain")}</div>
            <div className="tool-row">
              <Codicon name={p.toolchain?.cargo ? "pass-filled" : "error"} className={p.toolchain?.cargo ? "ok" : "err"} />
              <div className="pkg-row-main">
                <strong>{t("Rust y Cargo")}</strong>
                <div className="muted small">{p.toolchain?.cargo ?? t("No instalado — https://rustup.rs")}</div>
              </div>
            </div>
          </div>
        );
    }
  };

  const tabs: { id: Tab; label: string; icon: string; count?: number; alert?: boolean }[] = [
    { id: "browse", label: t("Explorar"), icon: "search" },
    { id: "installed", label: t("Instalados"), icon: "package", count: installed.length },
    { id: "updates", label: t("Actualizaciones"), icon: "arrow-circle-up", count: updates.length, alert: updates.length > 0 },
    { id: "recommended", label: t("Recomendados"), icon: "star-full" },
    { id: "essentials", label: t("Esenciales"), icon: "tools", count: missingTools.length || undefined, alert: missingTools.length > 0 },
  ];

  return (
    <div className="modal-backdrop" onMouseDown={p.onClose}>
      <div className="modal packages" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pkg-header">
          <h2>
            <Codicon name="package" /> {" "}{t("Paquetes")}{p.title ? t(" de “{0}”", p.title) : ""}
            <span className="muted pkg-source">crates.io</span>
          </h2>
          <button className="icon-btn" onClick={p.onClose} title={t("Cerrar")}><Codicon name="close" /></button>
        </div>

        <div className="pkg-tabs">
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              <Codicon name={t.icon} /> {t.label}
              {t.count !== undefined && t.count > 0 && <span className={"count" + (t.alert ? " alert" : "")}>{t.count}</span>}
            </button>
          ))}
          {tab === "browse" && (
            <div className="pkg-search">
              <Codicon name="search" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Buscar en crates.io…")}
                autoFocus
                spellCheck={false}
              />
            </div>
          )}
        </div>

        <div className="pkg-body">
          <div className="pkg-list">{list()}</div>
          <div className="pkg-detail">
            {selected ? (
              <CrateDetail
                name={selected.name}
                details={details}
                detailsError={detailsError}
                installed={find(selected.name)}
                recommendation={selected.rec}
                busy={!!busy}
                actions={actions}
              />
            ) : (
              <div className="empty-state">
                <Codicon name="package" />
                <p>{t("Selecciona un paquete para ver sus detalles.")}</p>
              </div>
            )}
          </div>
        </div>

        {status && (
          <div className={"pkg-status" + (status.error ? " err" : "")}>
            {busy && <Codicon name="loading" spin />} {status.text}
          </div>
        )}
      </div>
    </div>
  );
}
