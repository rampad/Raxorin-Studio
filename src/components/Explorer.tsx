import { useEffect, useState } from "react";
import { api, type Entry } from "../api";
import { basename } from "../util";

interface Props {
  root: string | null;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
}

export default function Explorer({ root, activePath, onOpenFile, onRefresh }: Props) {
  return (
    <div className="explorer">
      <div className="panel-title">
        <span>EXPLORADOR</span>
        {root && <button className="icon-btn" onClick={onRefresh} title="Actualizar">⟳</button>}
      </div>
      {root ? (
        <div className="tree">
          <TreeNode
            entry={{ name: basename(root), path: root, isDir: true }}
            depth={0}
            initiallyOpen
            activePath={activePath}
            onOpenFile={onOpenFile}
          />
        </div>
      ) : (
        <div className="muted pad">No hay ningún proyecto abierto.</div>
      )}
    </div>
  );
}

interface NodeProps {
  entry: Entry;
  depth: number;
  initiallyOpen?: boolean;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}

function TreeNode({ entry, depth, initiallyOpen = false, activePath, onOpenFile }: NodeProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const [children, setChildren] = useState<Entry[] | null>(null);

  useEffect(() => {
    if (open && entry.isDir && children === null) {
      api.listDir(entry.path).then(setChildren).catch(() => setChildren([]));
    }
  }, [open, entry, children]);

  const onClick = () => (entry.isDir ? setOpen((o) => !o) : onOpenFile(entry.path));

  return (
    <>
      <div
        className={"tree-row" + (activePath === entry.path ? " active" : "") + (depth === 0 ? " root" : "")}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={onClick}
        title={entry.path}
      >
        <span className="twisty">{entry.isDir ? (open ? "▾" : "▸") : ""}</span>
        <span className="file-icon">{iconFor(entry, open)}</span>
        <span className="label">{entry.name}</span>
      </div>
      {open &&
        children?.map((c) => (
          <TreeNode
            key={c.path}
            entry={c}
            depth={depth + 1}
            initiallyOpen={depth === 0 && c.name === "src"}
            activePath={activePath}
            onOpenFile={onOpenFile}
          />
        ))}
    </>
  );
}

function iconFor(e: Entry, open: boolean) {
  if (e.isDir) return open ? "📂" : "📁";
  const ext = e.name.split(".").pop()?.toLowerCase();
  if (ext === "rs") return "🦀";
  if (ext === "toml") return "⚙️";
  if (ext === "md") return "📝";
  if (ext === "lock") return "🔒";
  return "📄";
}
