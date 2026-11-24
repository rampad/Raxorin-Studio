import Editor, { type OnMount } from "@monaco-editor/react";
import { languageFor } from "../util";

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
  onChange: (path: string, value: string) => void;
  onMount: OnMount;
}

export default function EditorArea({ tabs, active, onSelect, onClose, onChange, onMount }: Props) {
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
            <span>{t.name}</span>
            {t.content !== t.saved ? (
              <span className="dirty" title="Sin guardar">●</span>
            ) : null}
            <button
              className="tab-close"
              title="Cerrar"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.path);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="editor-host">
        {tab ? (
          <Editor
            theme="vs-dark"
            path={tab.path}
            language={languageFor(tab.path)}
            value={tab.content}
            onChange={(v) => onChange(tab.path, v ?? "")}
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
            }}
          />
        ) : (
          <div className="empty-editor">Abre un archivo desde el explorador</div>
        )}
      </div>
    </div>
  );
}
