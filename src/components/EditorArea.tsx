import { useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Uri } from "monaco-editor";
import SlintDesigner, { type DesignerHost } from "../designer/SlintDesigner";
import { languageFor } from "../util";
import { Codicon, FileIcon } from "./Icon";
import { monacoTheme, useTheme } from "../theme";
import { useSettings } from "../settings";

export interface Tab {
  path: string;
  name: string;
  content: string;
  saved: string;
}

interface Props {
  tabs: Tab[];
  active: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** Mover la pestaña `from` a la posición `to` (índices en `tabs`). */
  onReorder: (from: number, to: number) => void;
  onNewFile: () => void;
  onMount: OnMount;
  designer: DesignerHost;
}

// El contenido de las pestañas se sincroniza desde los modelos de Monaco en App.tsx,
// así también se reflejan las ediciones hechas en otros archivos (p. ej. al renombrar).
export default function EditorArea({ tabs, active, onSelect, onClose, onReorder, onNewFile, onMount, designer }: Props) {
  // Arrastrar pestañas: cuál se arrastra y dónde caería (antes de la pestaña `index`).
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null);
  const { theme } = useTheme();
  const settings = useSettings();
  const tab = tabs.find((t) => t.path === active);
  // Los .slint se abren en el diseñador; se puede cambiar a la vista de código.
  const [modes, setModes] = useState<Record<string, "design" | "code">>({});
  const isSlint = !!tab && tab.path.toLowerCase().endsWith(".slint");
  const mode = tab ? modes[tab.path] ?? (isSlint ? "design" : "code") : "code";
  const setMode = (m: "design" | "code") => tab && setModes((x) => ({ ...x, [tab.path]: m }));
  return (
    <div className="editor-area">
      <div className="tabs">
        {tabs.map((t, i) => (
          <div
            key={t.path}
            className={
              "tab" + (t.path === active ? " active" : "") + (drag?.from === i ? " dragging" : "") +
              (drag && drag.over === i && drag.from !== i && drag.from !== i - 1 ? " drop-before" : "") +
              (drag && drag.over === tabs.length && i === tabs.length - 1 && drag.from !== i ? " drop-after" : "")
            }
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", t.path);
              setDrag({ from: i, over: null });
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              // Mitad izquierda: antes de esta pestaña; mitad derecha: después.
              const r = e.currentTarget.getBoundingClientRect();
              const over = e.clientX < r.left + r.width / 2 ? i : i + 1;
              if (over !== drag.over) setDrag({ ...drag, over });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag && drag.over !== null) {
                const to = drag.over > drag.from ? drag.over - 1 : drag.over;
                if (to !== drag.from) onReorder(drag.from, to);
              }
              setDrag(null);
            }}
            onDragEnd={() => setDrag(null)}
            onClick={() => onSelect(t.path)}
            onAuxClick={(e) => e.button === 1 && onClose(t.path)}
            title={t.path}
          >
            <FileIcon name={t.name} />
            <span>{t.name}</span>
            {t.content !== t.saved ? (
              <Codicon name="circle-filled" className="dirty" title="Sin guardar" />
            ) : null}
            <button
              className="tab-close"
              title="Cerrar"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.path);
              }}
            >
              <Codicon name="close" />
            </button>
          </div>
        ))}
        <button className="tabs-new" title="Nuevo archivo (Ctrl/⌘+N)" onClick={onNewFile}>
          <Codicon name="add" />
        </button>
      </div>
      {isSlint && (
        <div className="view-switch">
          <div className="segmented small">
            <button className={mode === "design" ? "active" : ""} onClick={() => setMode("design")}>
              <Codicon name="layout" /> Diseño
            </button>
            <button className={mode === "code" ? "active" : ""} onClick={() => setMode("code")}>
              <Codicon name="code" /> Código
            </button>
          </div>
          <span className="muted small">
            {mode === "design" ? "Los cambios del diseñador se escriben en el archivo .slint" : "Edita el .slint a mano; el diseñador se actualiza al volver"}
          </span>
        </div>
      )}
      <div className="editor-host">
        {tab && mode === "design" ? (
          <SlintDesigner key={tab.path} path={tab.path} onShowCode={() => setMode("code")} {...designer} />
        ) : tab ? (
          <Editor
            keepCurrentModel
            theme={monacoTheme(theme)}
            path={Uri.file(tab.path).toString()}
            language={languageFor(tab.path)}
            defaultValue={tab.content}
            onMount={onMount}
            options={{
              fontSize: settings.fontSize,
              fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
              fontLigatures: true,
              tabSize: settings.tabSize,
              wordWrap: settings.wordWrap ? "on" : "off",
              minimap: { enabled: settings.minimap },
              lineNumbers: settings.lineNumbers ? "on" : "off",
              insertSpaces: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderWhitespace: settings.renderWhitespace ? "all" : "selection",
              bracketPairColorization: { enabled: true },
              inlayHints: { enabled: "on" },
              glyphMargin: true, // para los puntos de interrupción
              "semanticHighlighting.enabled": false,
              quickSuggestions: { other: true, comments: false, strings: false },
            }}
          />
        ) : (
          <div className="empty-editor">Abre un archivo desde el explorador</div>
        )}
      </div>
    </div>
  );
}
