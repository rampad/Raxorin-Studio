import { useEffect, useState } from "react";
import type { ProjectInfo, Task } from "../api";
import { relative } from "../util";
import { Codicon, FileIcon } from "./Icon";
import rustLogo from "../assets/file-icons/rust.svg";

interface Props {
  hasProject: boolean;
  running: Task | null;
  canSave: boolean;
  canFormat: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onFormat: () => void;
  onPackages: () => void;
  onTask: (t: Task) => void;
  onStop: () => void;
  runExternal: boolean;
  onRunModeChange: (external: boolean) => void;
  root: string | null;
  projects: ProjectInfo[];
  startup: ProjectInfo | null;
  onSetStartup: (dir: string) => void;
}

function Btn(props: {
  icon: string;
  label?: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={"tb-btn" + (props.className ? " " + props.className : "")}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      <Codicon name={props.icon} />
      {props.label && <span>{props.label}</span>}
    </button>
  );
}

const Check = ({ on }: { on: boolean }) => <Codicon name="check" className={"menu-check" + (on ? "" : " off")} />;

export default function Toolbar(p: Props) {
  const busy = p.running !== null;
  const noTask = !p.hasProject || busy || !p.startup;
  const [menuOpen, setMenuOpen] = useState(false);
  const [startupOpen, setStartupOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen && !startupOpen) return;
    const close = () => {
      setMenuOpen(false);
      setStartupOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen, startupOpen]);

  // Ejecutables primero, luego bibliotecas.
  const sorted = [...p.projects].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "bin" ? -1 : 1));

  return (
    <div className="toolbar">
      <span className="brand">
        <img src={rustLogo} width={18} height={18} alt="" />
        Rust Studio
      </span>
      <Btn icon="new-file" label="Nuevo" title="Nuevo proyecto" onClick={p.onNew} />
      <Btn icon="folder-opened" label="Abrir" title="Abrir carpeta" onClick={p.onOpen} />
      <Btn icon="save" title="Guardar (Ctrl/⌘+S)" onClick={p.onSave} disabled={!p.canSave} />
      <Btn icon="wand" title="Formatear documento (Shift+Alt+F)" onClick={p.onFormat} disabled={!p.canFormat} />
      <Btn icon="package" label="Paquetes" title="Administrar paquetes (crates)" onClick={p.onPackages} disabled={!p.startup} />
      <span className="tb-sep" />

      {p.projects.length > 0 && (
        <div className="split-btn" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="tb-btn startup-btn"
            title="Proyecto de inicio: el que se compila, ejecuta y depura"
            onClick={() => setStartupOpen((o) => !o)}
          >
            {p.startup ? <FileIcon name={p.startup.name} project={p.startup.kind} /> : <Codicon name="question" />}
            <span className="startup-name">{p.startup?.name ?? "Elegir proyecto"}</span>
            <Codicon name="chevron-down" className="muted" />
          </button>
          {startupOpen && (
            <div className="context-menu dropdown" onClick={() => setStartupOpen(false)}>
              <div className="menu-header">Proyecto de inicio</div>
              {sorted.map((proj) => (
                <button key={proj.dir} className="menu-item" onClick={() => p.onSetStartup(proj.dir)}>
                  <span className="menu-label">
                    <Check on={p.startup?.dir === proj.dir} />
                    <FileIcon name={proj.name} project={proj.kind} />
                    {proj.name}
                  </span>
                  <span className="muted">{relative(p.root, proj.dir) || "."}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <Btn icon="tools" label="Compilar" title="Compilar (Ctrl/⌘+Shift+B)" onClick={() => p.onTask("build")} disabled={noTask} />
      <Btn icon="check-all" label="Revisar" title="Revisar el código con Clippy, sin generar ejecutable" onClick={() => p.onTask("check")} disabled={noTask} />
      <Btn icon="beaker" label="Probar" title="Ejecutar pruebas (cargo test)" onClick={() => p.onTask("test")} disabled={noTask} />

      <div className="split-btn" onMouseDown={(e) => e.stopPropagation()}>
        <button
          className="tb-btn run"
          onClick={() => p.onTask("run")}
          disabled={noTask}
          title={p.runExternal ? "Ejecutar en una terminal externa (F5)" : "Ejecutar en el panel de salida (F5)"}
        >
          <Codicon name="play" />
          <span>Ejecutar</span>
          {p.runExternal && <Codicon name="link-external" className="run-mode" />}
        </button>
        <button className="tb-btn split-arrow" onClick={() => setMenuOpen((o) => !o)} title="Dónde ejecutar">
          <Codicon name="chevron-down" />
        </button>
        {menuOpen && (
          <div className="context-menu dropdown" onClick={() => setMenuOpen(false)}>
            <div className="menu-header">Ejecutar el programa en…</div>
            <button className="menu-item" onClick={() => p.onRunModeChange(false)}>
              <span className="menu-label">
                <Check on={!p.runExternal} />
                <Codicon name="output" />
                Panel de salida integrado
              </span>
            </button>
            <button className="menu-item" onClick={() => p.onRunModeChange(true)}>
              <span className="menu-label">
                <Check on={p.runExternal} />
                <Codicon name="terminal" />
                Terminal externa (ventana nueva)
              </span>
            </button>
          </div>
        )}
      </div>
      <Btn icon="debug-stop" label="Detener" title="Detener (Shift+F5)" onClick={p.onStop} disabled={!busy} className="stop" />
    </div>
  );
}
