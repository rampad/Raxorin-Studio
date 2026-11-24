import Editor, { type OnMount } from "@monaco-editor/react";
import { Uri } from "monaco-editor";
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
}

// El contenido de las pestañas se sincroniza desde los modelos de Monaco en App.tsx,
// así también se reflejan las ediciones hechas en otros archivos (p. ej. al renombrar).
export default function EditorArea({ tabs, active, onSelect, onClose, onMount }: Props) {
  const tab = tabs.find((t) => t.path === active);
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
      <div className="editor-host">
        {tab ? (
          <Editor
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
