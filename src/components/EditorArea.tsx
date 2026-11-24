import { useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Uri } from "monaco-editor";
import SlintDesigner, { type DesignerHost } from "../designer/SlintDesigner";
import { languageFor } from "../util";
import { Codicon, FileIcon } from "./Icon";

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
  onMount: OnMount;
  designer: DesignerHost;
}

// El contenido de las pestañas se sincroniza desde los modelos de Monaco en App.tsx,
// así también se reflejan las ediciones hechas en otros archivos (p. ej. al renombrar).
export default function EditorArea({ tabs, active, onSelect, onClose, onMount, designer }: Props) {
  const tab = tabs.find((t) => t.path === active);
  // Los .slint se abren en el diseñador; se puede cambiar a la vista de código.
  const [modes, setModes] = useState<Record<string, "design" | "code">>({});
  const isSlint = !!tab && tab.path.toLowerCase().endsWith(".slint");
  const mode = tab ? modes[tab.path] ?? (isSlint ? "design" : "code") : "code";
  const setMode = (m: "design" | "code") => tab && setModes((x) => ({ ...x, [tab.path]: m }));
  return (
    <div className="editor-area">
      <div className="tabs">
        {tabs.map((t) => (
          <div
            key={t.path}
            className={"tab" + (t.path === active ? " active" : "")}
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
            theme="vs-dark"
            path={Uri.file(tab.path).toString()}
            language={languageFor(tab.path)}
            defaultValue={tab.content}
            onMount={onMount}
            options={{
              fontSize: 14,
              fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
              fontLigatures: true,
              tabSize: 4,
              insertSpaces: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderWhitespace: "selection",
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
