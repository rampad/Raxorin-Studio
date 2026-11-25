import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { api, type Sample, type SampleCatalog } from "../api";
import { Codicon } from "./Icon";
import { t, tErr } from "../i18n/index.ts";

type Kind = "bin" | "lib" | "slint" | "solution";

interface Props {
  /** Carpeta abierta actualmente (para "agregar a la carpeta actual"). */
  currentRoot: string | null;
  /** Nombre de la solución abierta (si hay): “Agregar a la solución”. */
  solutionName?: string | null;
  onCancel: () => void;
  /** `start`: empezar desde un ejemplo en vez de un proyecto en blanco. */
  onCreate: (
    parent: string,
    name: string,
    kind: Kind,
    addToCurrent: boolean,
    start?: { sample: Sample; online: boolean },
  ) => Promise<void>;
}

const TEMPLATES: { kind: Kind; icon: string; title: string; desc: string; blank: string; sample: Sample["tipo"] }[] = [
  { kind: "bin", icon: "terminal", title: t("Aplicación de consola"), desc: t("Un programa que se ejecuta en la terminal."), blank: t("Pregunta tu nombre y te saluda."), sample: "consola" },
  { kind: "slint", icon: "window", title: t("Aplicación de ventana"), desc: t("Ventana con diseñador visual (Slint), como WPF."), blank: t("Una ventana con un campo de texto y un botón."), sample: "ventana" },
  { kind: "lib", icon: "library", title: t("Biblioteca"), desc: t("Código reutilizable para otros proyectos."), blank: t("Una función de ejemplo con su prueba."), sample: "biblioteca" },
  { kind: "solution", icon: "layers", title: t("Solución"), desc: t("Un archivo .rxsln para agrupar varios proyectos."), blank: t("Una solución vacía, lista para agregar proyectos."), sample: "solucion" },
];

const CRATE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SOLUTION_NAME = /^[^/\\:*?"<>|]+$/;

/** Nuevo proyecto en dos pasos: el tipo, y después cómo empezar (en blanco o desde un ejemplo). */
export default function NewProjectDialog({ currentRoot, solutionName, onCancel, onCreate }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [kind, setKind] = useState<Kind>("bin");
  /** null = proyecto en blanco. */
  const [sample, setSample] = useState<Sample | null>(null);
  const [catalog, setCatalog] = useState<SampleCatalog | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [name, setName] = useState("mi_app");
  const [nameTouched, setNameTouched] = useState(false);
  const [location, setLocation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [addToCurrent, setAddToCurrent] = useState(!!currentRoot);
  const [defaultLocation, setDefaultLocation] = useState("");

  useEffect(() => {
    homeDir()
      .then((h) => join(h, "RustProjects"))
      .then((d) => {
        setDefaultLocation(d);
        if (!currentRoot) setLocation(d);
      })
      .catch(() => {});
    // Los ejemplos se cargan mientras se elige el tipo.
    api.samplesList().then(setCatalog).catch(() => setCatalogFailed(true));
  }, [currentRoot]);

  const isSolution = kind === "solution";
  useEffect(() => {
    // Una solución nueva va en su propia carpeta (por defecto ~/RustProjects).
    if (addToCurrent && currentRoot && !isSolution) setLocation(currentRoot);
    else if (defaultLocation) setLocation(defaultLocation);
  }, [addToCurrent, currentRoot, defaultLocation, isSolution]);

  const template = TEMPLATES.find((t) => t.kind === kind)!;
  const samples = useMemo(() => (catalog?.samples ?? []).filter((s) => s.tipo === template.sample), [catalog, template]);

  /** Nombre sugerido mientras el usuario no escriba uno propio. */
  const suggest = (k: Kind, s: Sample | null) => {
    if (nameTouched) return;
    if (s) setName(k === "solution" ? s.nombre.replace(/\s*\(.*\)$/, "") : s.id);
    else setName(k === "solution" ? t("Mi solución") : "mi_app");
  };

  const chooseKind = (k: Kind) => {
    setKind(k);
    setSample(null);
    suggest(k, null);
  };

  const chooseStart = (s: Sample | null) => {
    setSample(s);
    suggest(kind, s);
    setError("");
  };

  const nameOk = isSolution ? SOLUTION_NAME.test(name.trim()) : CRATE_NAME.test(name);
  const valid = nameOk && location.length > 0;
  const adding = !isSolution && addToCurrent && !!currentRoot;

  const browse = async () => {
    const dir = await open({ directory: true, defaultPath: location || undefined });
    if (typeof dir === "string") setLocation(dir);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 1) {
      setStep(2);
      return;
    }
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(location, name.trim(), kind, adding, sample ? { sample, online: !!catalog?.online } : undefined);
    } catch (err) {
      setError(tErr(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onCancel()}>
      <form
        className={"modal new-project" + (step === 2 ? " wide" : "")}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>{step === 1 ? t("Nuevo proyecto") : template.title}</h2>
        <div className="wizard-steps small">
          <span className={step === 1 ? "active" : "done"}>1. Tipo</span>
          <Codicon name="chevron-right" />
          <span className={step === 2 ? "active" : ""}>{t("2. Cómo empezar")}</span>
        </div>

        {step === 1 ? (
          <div className="templates">
            {TEMPLATES.map((t) => {
              const count = (catalog?.samples ?? []).filter((s) => s.tipo === t.sample).length;
              return (
                <button
                  type="button"
                  key={t.kind}
                  className={"template" + (t.kind === kind ? " selected" : "")}
                  onClick={() => chooseKind(t.kind)}
                  onDoubleClick={() => {
                    chooseKind(t.kind);
                    setStep(2);
                  }}
                >
                  <Codicon name={t.icon} className="template-icon" />
                  <span>
                    <strong>{t.title}</strong>
                    <small>{t.desc}</small>
                  </span>
                  {count > 0 && <span className="template-count">{count === 1 ? "1 ejemplo" : `${count} ejemplos`}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="start-body">
            <div className="start-list">
              <button
                type="button"
                className={"sample-card blank" + (!sample ? " selected" : "")}
                onClick={() => chooseStart(null)}
              >
                <Codicon name="new-file" className="sample-icon" />
                <span className="sample-text">
                  <strong>{isSolution ? t("Solución en blanco") : t("Proyecto en blanco")}</strong>
                  <small>{template.blank}</small>
                </span>
              </button>
              {samples.length > 0 && <div className="start-section">{t("Empezar desde un ejemplo")}</div>}
              {samples.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={"sample-card" + (sample?.id === s.id ? " selected" : "")}
                  onClick={() => chooseStart(s)}
                >
                  <Codicon name={s.icono} className="sample-icon" />
                  <span className="sample-text">
                    <strong>{s.nombre}</strong>
                    <small>{s.descripcion}</small>
                    <span className="sample-tags">
                      <span className={"tag level" + (s.nivel === "Principiante" || s.nivel === "Beginner" ? " easy" : "")}>{s.nivel}</span>
                      {s.aprenderas.slice(0, 2).map((a) => (
                        <span key={a} className="tag">{a}</span>
                      ))}
                    </span>
                  </span>
                </button>
              ))}
              {!catalog && !catalogFailed && (
                <p className="muted small">
                  <Codicon name="loading" spin /> {" "}{t("Cargando ejemplos…")}
                </p>
              )}
            </div>

            <div className="start-form">
              <label>
                {isSolution ? t("Nombre de la solución") : t("Nombre del proyecto")}
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameTouched(true);
                  }}
                  autoFocus
                  spellCheck={false}
                />
              </label>
              {!nameOk && name.length > 0 && (
                <div className="hint err">
                  {isSolution ? t("El nombre no puede tener / \\ : * ? \" < > |") : t("Usa letras, números, “_” o “-”, sin empezar con número.")}
                </div>
              )}
              {currentRoot && !isSolution && (
                <div className="segmented vertical">
                  <button type="button" className={addToCurrent ? "active" : ""} onClick={() => setAddToCurrent(true)}>
                    <Codicon name="add" /> {solutionName ? t("Agregar a la solución “{0}”", solutionName) : t("Agregar a la carpeta actual")}
                  </button>
                  <button type="button" className={!addToCurrent ? "active" : ""} onClick={() => setAddToCurrent(false)}>
                    <Codicon name="folder-opened" /> {" "}{t("Crear en otra ubicación")}
                  </button>
                </div>
              )}
              <label>
                
                {t("Ubicación")}
                <div className="row">
                  <input value={location} onChange={(e) => setLocation(e.target.value)} spellCheck={false} />
                  <button type="button" className="btn" onClick={browse}>
                    
                    {t("Examinar…")}
                  </button>
                </div>
              </label>
              {sample && (
                <p className="muted small start-note">
                  <Codicon name="info" /> {" "}{t("Se copia el ejemplo «")}{sample.nombre}{t("» con el nombre que elegiste. Es tuyo: cámbialo todo lo que quieras.")}
                </p>
              )}
            </div>
          </div>
        )}

        {error && <pre className="hint err">{error}</pre>}
        <div className="actions">
          {step === 2 && (
            <button type="button" className="btn" onClick={() => setStep(1)} disabled={busy}>
              <Codicon name="arrow-left" /> {" "}{t("Atrás")}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            
            {t("Cancelar")}
          </button>
          {step === 1 ? (
            <button type="submit" className="btn primary">
              
              {t("Siguiente")}{" "}<Codicon name="arrow-right" />
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!valid || busy}>
              {busy ? t("Creando…") : adding ? t("Agregar") : t("Crear")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
