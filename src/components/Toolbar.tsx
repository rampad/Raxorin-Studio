import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { ProjectInfo, Task } from "../api";
import { relative } from "../util";
import { Codicon, FileIcon } from "./Icon";
import raxorinMark from "../assets/brand/raxorin-mark.svg";
import { setThemePref, toggleTheme, useTheme, type ThemePref } from "../theme";
import { isSep, TOOLS, useToolbarConfig, type ToolId } from "../toolbarConfig";
import { resetLayout } from "../layout";

interface Props {
  hasProject: boolean;
  running: Task | null;
  canSave: boolean;
  canSaveAll: boolean;
  canFormat: boolean;
  onNew: () => void;
  onOpen: () => void;
  onOpenSolution: () => void;
  onSave: () => void;
  onSaveAll: () => void;
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
  debugStatus: "idle" | "starting" | "running" | "stopped";
  debugAvailable: boolean;
  onDebug: () => void;
  onContinue: () => void;
  onPause: () => void;
  onStepOver: () => void;
  onStepInto: () => void;
  onStepOut: () => void;
  onRestart: () => void;
  onDebugStop: () => void;
  diagOpen: boolean;
  onToggleDiag: () => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  bottomVisible: boolean;
  onToggleBottom: () => void;
  onCustomize: () => void;
  onSettings: () => void;
  buildConfig: "debug" | "release";
  onBuildConfig: (c: "debug" | "release") => void;
  onPublish: () => void;
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

const THEMES: { id: ThemePref; icon: string; name: string }[] = [
  { id: "dark", icon: "color-mode", name: "Oscuro" },
  { id: "light", icon: "lightbulb", name: "Claro" },
  { id: "system", icon: "device-desktop", name: "Según el sistema" },
];

type Menu = "run" | "startup" | "settings" | null;

export default function Toolbar(p: Props) {
  const busy = p.running !== null;
  const noTask = !p.hasProject || busy || !p.startup;
  const [menu, setMenu] = useState<Menu>(null);
  const config = useToolbarConfig();
  const { pref, theme } = useTheme();
  const toggle = (m: Menu) => setMenu((o) => (o === m ? null : m));
  /** Texto del botón, si la barra muestra textos. */
  const lbl = (id: ToolId) => (config.labels ? TOOLS[id].label : undefined);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  // Ejecutables primero, luego bibliotecas.
  const sorted = [...p.projects].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "bin" ? -1 : 1));
  const debugging = p.debugStatus !== "idle";

  const debugBar = (
    <div className="debug-bar" key="debug-bar">
      {p.debugStatus === "stopped" ? (
        <Btn icon="debug-continue" title="Continuar (F5)" onClick={p.onContinue} className="dbg-continue" />
      ) : (
        <Btn icon="debug-pause" title="Pausar (F6)" onClick={p.onPause} disabled={p.debugStatus !== "running"} />
      )}
      <Btn icon="debug-step-over" title="Paso a paso por procedimientos (F10)" onClick={p.onStepOver} disabled={p.debugStatus !== "stopped"} />
      <Btn icon="debug-step-into" title="Paso a paso por instrucciones (F11)" onClick={p.onStepInto} disabled={p.debugStatus !== "stopped"} />
      <Btn icon="debug-step-out" title="Paso a paso para salir (Shift+F11)" onClick={p.onStepOut} disabled={p.debugStatus !== "stopped"} />
      <Btn icon="debug-restart" title="Reiniciar (Ctrl/⌘+Shift+F5)" onClick={p.onRestart} className="dbg-restart" />
      <Btn icon="debug-stop" label="Detener" title="Detener la depuración (Shift+F5)" onClick={p.onDebugStop} className="stop" />
    </div>
  );

  const render = (id: ToolId): ReactNode => {
    switch (id) {
      case "new":
        return <Btn icon="new-file" label={lbl(id)} title="Nuevo proyecto" onClick={p.onNew} />;
      case "open":
        return <Btn icon="folder-opened" label={lbl(id)} title="Abrir carpeta" onClick={p.onOpen} />;
      case "openSolution":
        return <Btn icon="layers" title="Abrir solución (.rxsln)" onClick={p.onOpenSolution} />;
      case "save":
        return <Btn icon="save" title="Guardar (Ctrl/⌘+S)" onClick={p.onSave} disabled={!p.canSave} />;
      case "saveAll":
        return <Btn icon="save-all" title="Guardar todo" onClick={p.onSaveAll} disabled={!p.canSaveAll} />;
      case "format":
        return <Btn icon="wand" title="Formatear documento (Shift+Alt+F)" onClick={p.onFormat} disabled={!p.canFormat} />;
      case "packages":
        return <Btn icon="package" label={lbl(id)} title="Administrar paquetes (crates)" onClick={p.onPackages} disabled={!p.startup} />;
      case "startup":
        if (!p.projects.length) return null;
        return (
          <div className="split-btn" onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="tb-btn startup-btn"
              title="Proyecto de inicio: el que se compila, ejecuta y depura"
              onClick={() => toggle("startup")}
            >
              {p.startup ? <FileIcon name={p.startup.name} project={p.startup.kind} /> : <Codicon name="question" />}
              <span className="startup-name">{p.startup?.name ?? "Elegir proyecto"}</span>
              <Codicon name="chevron-down" className="muted" />
            </button>
            {menu === "startup" && (
              <div className="context-menu dropdown" onClick={() => setMenu(null)}>
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
        );
      case "config":
        return (
          <select
            className="tb-select"
            value={p.buildConfig}
            onChange={(e) => p.onBuildConfig(e.target.value as "debug" | "release")}
            title="Configuración: Debug compila rápido para probar; Release optimiza para entregar (depurar siempre usa Debug)"
          >
            <option value="debug">Debug</option>
            <option value="release">Release</option>
          </select>
        );
      case "publish":
        return <Btn icon="package" label={lbl(id)} title="Publicar: compilar en Release y dejar el ejecutable listo para compartir" onClick={p.onPublish} disabled={noTask} />;
      case "build":
        return <Btn icon="tools" label={lbl(id)} title="Compilar (Ctrl/⌘+Shift+B)" onClick={() => p.onTask("build")} disabled={noTask} />;
      case "check":
        return <Btn icon="check-all" label={lbl(id)} title="Revisar el código con Clippy, sin generar ejecutable" onClick={() => p.onTask("check")} disabled={noTask} />;
      case "test":
        return <Btn icon="beaker" label={lbl(id)} title="Ejecutar pruebas (cargo test)" onClick={() => p.onTask("test")} disabled={noTask} />;
      case "debug":
        return (
          <Btn
            icon="debug-start"
            label={lbl(id)}
            title={p.debugAvailable ? "Iniciar depuración (F5): se detiene en los puntos de interrupción" : "Depurador no disponible (falta lldb-dap)"}
            onClick={p.onDebug}
            disabled={noTask || p.startup?.kind !== "bin"}
            className="debug"
          />
        );
      case "run":
        return (
          <div className="split-btn" onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="tb-btn run"
              onClick={() => p.onTask("run")}
              disabled={noTask}
              title={(p.runExternal ? "Ejecutar sin depurar, en una terminal externa (Ctrl/⌘+F5)" : "Ejecutar sin depurar (Ctrl/⌘+F5)") + " — ignora los puntos de interrupción"}
            >
              <Codicon name="play-circle" />
              {config.labels && <span>{TOOLS.run.label}</span>}
              {p.runExternal && <Codicon name="link-external" className="run-mode" />}
            </button>
            <button className="tb-btn split-arrow" onClick={() => toggle("run")} title="Dónde ejecutar">
              <Codicon name="chevron-down" />
            </button>
            {menu === "run" && (
              <div className="context-menu dropdown" onClick={() => setMenu(null)}>
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
        );
      case "stop":
        return <Btn icon="debug-stop" label={lbl(id)} title="Detener (Shift+F5)" onClick={p.onStop} disabled={!busy} className="stop" />;
      case "diag":
        return (
          <Btn
            icon="pulse"
            title="Herramientas de diagnóstico: CPU y memoria del programa"
            onClick={p.onToggleDiag}
            className={"diag-toggle" + (p.diagOpen ? " on" : "")}
          />
        );
      case "theme":
        return (
          <Btn
            icon={theme === "dark" ? "lightbulb" : "color-mode"}
            title={theme === "dark" ? "Cambiar al tema claro" : "Cambiar al tema oscuro"}
            onClick={toggleTheme}
          />
        );
      case "sidebar":
        return (
          <Btn
            icon="layout-sidebar-left"
            title={(p.sidebarVisible ? "Ocultar" : "Mostrar") + " el explorador (Ctrl/⌘+B)"}
            onClick={p.onToggleSidebar}
            className={"toggle" + (p.sidebarVisible ? " on" : "")}
          />
        );
      case "bottom":
        return (
          <Btn
            icon="layout-panel"
            title={(p.bottomVisible ? "Ocultar" : "Mostrar") + " el panel inferior (Ctrl/⌘+J)"}
            onClick={p.onToggleBottom}
            className={"toggle" + (p.bottomVisible ? " on" : "")}
          />
        );
    }
  };

  // Armar la barra según la configuración. Durante la depuración, los controles
  // de depurar/ejecutar/detener se reemplazan por la barra de depuración.
  const out: ReactNode[] = [];
  let debugPlaced = false;
  let lastWasSep = true; // evita separadores al principio o repetidos
  for (const item of config.items) {
    if (!item.on) continue;
    if (isSep(item.id)) {
      if (!lastWasSep) out.push(<span className="tb-sep" key={item.id} />);
      lastWasSep = true;
      continue;
    }
    const id = item.id;
    if (debugging && (id === "debug" || id === "run" || id === "stop")) {
      if (!debugPlaced) out.push(debugBar);
      debugPlaced = true;
      lastWasSep = false;
      continue;
    }
    const node = render(id);
    if (node) {
      out.push(<Fragment key={id}>{node}</Fragment>);
      lastWasSep = false;
    }
  }
  // La barra de depuración siempre aparece, aunque se hayan quitado esos controles.
  if (debugging && !debugPlaced) out.push(debugBar);
  if (out.length && lastWasSep) out.pop();

  return (
    <div
      className="toolbar"
      onContextMenu={(e) => {
        e.preventDefault();
        p.onCustomize();
      }}
    >
      <span className="brand">
        <img src={raxorinMark} height={18} alt="" />
        <span className="brand-name"><span className="brand-accent">Raxorin</span> Studio</span>
      </span>
      {out}
      <span className="spacer" />
      <div className="split-btn" onMouseDown={(e) => e.stopPropagation()}>
        <Btn icon="settings-gear" title="Ajustes: tema, paneles y barra de herramientas" onClick={() => toggle("settings")} />
        {menu === "settings" && (
          <div className="context-menu dropdown align-right" onClick={() => setMenu(null)}>
            <div className="menu-header">Tema</div>
            {THEMES.map((t) => (
              <button key={t.id} className="menu-item" onClick={() => setThemePref(t.id)}>
                <span className="menu-label">
                  <Check on={pref === t.id} />
                  <Codicon name={t.icon} />
                  {t.name}
                </span>
              </button>
            ))}
            <div className="menu-sep" />
            <div className="menu-header">Paneles</div>
            <button className="menu-item" onClick={p.onToggleSidebar}>
              <span className="menu-label">
                <Check on={p.sidebarVisible} />
                <Codicon name="layout-sidebar-left" />
                Explorador
              </span>
              <span className="muted">Ctrl/⌘+B</span>
            </button>
            <button className="menu-item" onClick={p.onToggleBottom}>
              <span className="menu-label">
                <Check on={p.bottomVisible} />
                <Codicon name="layout-panel" />
                Panel inferior
              </span>
              <span className="muted">Ctrl/⌘+J</span>
            </button>
            <button className="menu-item" onClick={p.onToggleDiag}>
              <span className="menu-label">
                <Check on={p.diagOpen} />
                <Codicon name="pulse" />
                Herramientas de diagnóstico
              </span>
            </button>
            <button className="menu-item" onClick={resetLayout}>
              <span className="menu-label">
                <Check on={false} />
                <Codicon name="discard" />
                Restablecer tamaños de los paneles
              </span>
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={p.onCustomize}>
              <span className="menu-label">
                <Check on={false} />
                <Codicon name="settings" />
                Personalizar barra de herramientas…
              </span>
            </button>
            <button className="menu-item" onClick={p.onSettings}>
              <span className="menu-label">
                <Check on={false} />
                <Codicon name="settings-gear" />
                Configuración…
              </span>
              <span className="muted">Ctrl/⌘+,</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
