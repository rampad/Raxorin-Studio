import type { Task } from "../api";

interface Props {
  hasProject: boolean;
  running: Task | null;
  canSave: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onTask: (t: Task) => void;
  onStop: () => void;
}

export default function Toolbar(p: Props) {
  const busy = p.running !== null;
  const noTask = !p.hasProject || busy;
  return (
    <div className="toolbar">
      <span className="brand">🦀 Rust Studio</span>
      <button className="tb-btn" onClick={p.onNew} title="Nuevo proyecto">📄 Nuevo</button>
      <button className="tb-btn" onClick={p.onOpen} title="Abrir carpeta de proyecto">📂 Abrir</button>
      <button className="tb-btn" onClick={p.onSave} disabled={!p.canSave} title="Guardar (Ctrl/⌘+S)">💾 Guardar</button>
      <span className="tb-sep" />
      <button className="tb-btn" onClick={() => p.onTask("build")} disabled={noTask} title="Compilar (Ctrl/⌘+Shift+B)">🔨 Compilar</button>
      <button className="tb-btn" onClick={() => p.onTask("check")} disabled={noTask} title="Revisar errores sin generar ejecutable (más rápido)">✓ Revisar</button>
      <button className="tb-btn" onClick={() => p.onTask("test")} disabled={noTask} title="Ejecutar pruebas (cargo test)">🧪 Probar</button>
      <button className="tb-btn run" onClick={() => p.onTask("run")} disabled={noTask} title="Ejecutar (F5)">▶ Ejecutar</button>
      <button className="tb-btn stop" onClick={p.onStop} disabled={!busy} title="Detener (Shift+F5)">■ Detener</button>
    </div>
  );
}
