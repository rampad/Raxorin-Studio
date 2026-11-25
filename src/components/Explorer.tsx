import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, type Entry, type ProjectInfo } from "../api";
import { basename, dirname, isInside, joinPath, relative } from "../util";
import { Codicon, FileIcon } from "./Icon";
import { t, tErr } from "../i18n/index.ts";

export interface FileProblems { errors: number; warnings: number }

export type SolutionAction = "new-project" | "add-existing" | "remove" | "edit-file" | "save-as";

interface Props {
  /** Carpetas raíz: una al abrir una carpeta; una por proyecto al abrir una solución. */
  roots: string[];
  /** Solución abierta (muestra una cabecera y acciones de solución). */
  solution: { name: string; file: string } | null;
  /** Clave para recordar las carpetas expandidas (carpeta o archivo .rxsln). */
  storageKey: string | null;
  onSolution: (action: SolutionAction, path?: string) => void;
  activePath: string | null;
  problems: Map<string, FileProblems>;
  /** Ruta absoluta → letra de Git (M, U, A, D, C…). */
  gitDecorations?: Map<string, string>;
  onOpenFile: (path: string) => void;
  onCreated: (path: string, isDir: boolean) => void;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (path: string) => void;
  onError: (message: string) => void;
  projects: ProjectInfo[];
  startupDir: string | null;
  onSetStartup: (dir: string) => void;
  onAddReference: (dir: string) => void;
  onManagePackages: (dir: string) => void;
}

type Editing =
  | { mode: "rename"; path: string; isDir: boolean }
  | { mode: "new-file" | "new-folder"; parent: string };

interface Menu { x: number; y: number; entry: Entry; isRoot: boolean }

const DRAG_TYPE = "application/x-raxorinstudio-path";
const expandedKey = (root: string) => `raxorinstudio.expanded:${root}`;

export default function Explorer(p: Props) {
  const { roots } = p;
  const rootsKey = roots.join("|");
  /** Raíz que contiene una ruta (o null). */
  const rootOf = (path: string) => roots.find((r) => isInside(path, r)) ?? null;
  const isRootPath = (path: string) => roots.includes(path);
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [solutionMenu, setSolutionMenu] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const projectByDir = useMemo(() => new Map(p.projects.map((pr) => [pr.dir, pr])), [p.projects]);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const treeRef = useRef<HTMLDivElement>(null);

  const loadDir = useCallback(async (dir: string) => {
    try {
      const entries = await api.listDir(dir);
      setChildren((c) => ({ ...c, [dir]: entries }));
    } catch {
      // La carpeta ya no existe: olvidarla.
      setChildren((c) => {
        const { [dir]: _, ...rest } = c;
        return rest;
      });
    }
  }, []);

  // Al abrir una carpeta o solución: restaurar las carpetas expandidas.
  useEffect(() => {
    if (!roots.length) return;
    const defaults = roots.map((r) => joinPath(r, "src"));
    let saved: string[] = defaults;
    try {
      saved = JSON.parse(localStorage.getItem(expandedKey(p.storageKey ?? rootsKey)) ?? "null") ?? defaults;
    } catch {
      /* sin almacenamiento */
    }
    const initial = new Set([...roots, ...saved.filter((d) => roots.some((r) => isInside(d, r)))]);
    setChildren({});
    setExpanded(initial);
    initial.forEach(loadDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, p.storageKey, loadDir]);

  // Guardar carpetas expandidas.
  useEffect(() => {
    if (!roots.length) return;
    try {
      localStorage.setItem(expandedKey(p.storageKey ?? rootsKey), JSON.stringify([...expanded].filter((d) => !roots.includes(d))));
    } catch {
      /* sin almacenamiento */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, rootsKey, p.storageKey]);

  // Actualización automática cuando cambian archivos en disco.
  useEffect(() => {
    const un = listen<string[]>("fs-changed", (e) => {
      for (const dir of e.payload) if (childrenRef.current[dir]) loadDir(dir);
    });
    return () => {
      un.then((f) => f());
    };
  }, [loadDir]);

  // Mostrar en el árbol el archivo activo del editor.
  useEffect(() => {
    const path = p.activePath;
    const root = path ? rootOf(path) : null;
    if (!root || !path || path === root) return;
    const ancestors: string[] = [];
    for (let d = dirname(path); d !== root && isInside(d, root); d = dirname(d)) ancestors.push(d);
    setExpanded((e) => {
      const missing = ancestors.filter((a) => !e.has(a));
      if (missing.length === 0) return e;
      missing.forEach(loadDir);
      return new Set([...e, ...missing]);
    });
    setSelected(path);
    setTimeout(() => {
      treeRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
    }, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.activePath, rootsKey, loadDir]);

  // Cerrar el menú de la solución con cualquier clic fuera.
  useEffect(() => {
    if (!solutionMenu) return;
    const close = () => setSolutionMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [solutionMenu]);

  // Cerrar el menú contextual con cualquier clic o Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // ---------- Acciones ----------

  const toggle = (dir: string) => {
    setExpanded((e) => {
      const next = new Set(e);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        loadDir(dir);
      }
      return next;
    });
  };

  const findEntry = (path: string): Entry | undefined => {
    if (isRootPath(path)) return { name: basename(path), path, isDir: true };
    return childrenRef.current[dirname(path)]?.find((e) => e.path === path);
  };

  /** Carpeta destino para "nuevo archivo": la seleccionada, la del archivo seleccionado o la raíz. */
  const targetDir = (path: string | null) => {
    if (!roots.length) return null;
    if (!path) return roots[0];
    const entry = findEntry(path);
    return entry?.isDir ? path : dirname(path);
  };

  const startNew = (mode: "new-file" | "new-folder", parent: string | null) => {
    if (!parent) return;
    setExpanded((e) => new Set([...e, parent]));
    loadDir(parent);
    setEditing({ mode, parent });
  };

  const commitEdit = async (name: string) => {
    const ed = editing;
    setEditing(null);
    name = name.trim();
    if (!ed || !name) return;
    try {
      if (ed.mode === "rename") {
        if (name === basename(ed.path)) return;
        const to = joinPath(dirname(ed.path), name);
        await api.renamePath(ed.path, to);
        await loadDir(dirname(ed.path));
        if (ed.isDir && expanded.has(ed.path)) {
          setExpanded((e) => new Set([...[...e].map((d) => (isInside(d, ed.path) ? to + d.slice(ed.path.length) : d))]));
          loadDir(to);
        }
        setSelected(to);
        p.onRenamed(ed.path, to);
      } else {
        const path = joinPath(ed.parent, name);
        if (ed.mode === "new-file") await api.createFile(path);
        else await api.createDir(path);
        await loadDir(ed.parent);
        setSelected(path);
        p.onCreated(path, ed.mode === "new-folder");
      }
    } catch (e) {
      p.onError(tErr(e));
    }
  };

  const remove = async (entry: Entry) => {
    const ok = await ask(
      t("¿Mover “{0}”{1} a la papelera?", entry.name, entry.isDir ? t(" y todo su contenido") : ""),
      { title: t("Eliminar"), kind: "warning", okLabel: t("Mover a la papelera"), cancelLabel: t("Cancelar") },
    );
    if (!ok) return;
    try {
      await api.deletePath(entry.path);
      await loadDir(dirname(entry.path));
      p.onDeleted(entry.path);
    } catch (e) {
      p.onError(tErr(e));
    }
  };

  const move = async (from: string, toDir: string) => {
    if (dirname(from) === toDir || isInside(toDir, from)) return;
    const to = joinPath(toDir, basename(from));
    try {
      await api.renamePath(from, to);
      await Promise.all([loadDir(dirname(from)), loadDir(toDir)]);
      setExpanded((e) => new Set([...e, toDir]));
      p.onRenamed(from, to);
    } catch (e) {
      p.onError(tErr(e));
    }
  };

  const refreshAll = () => Object.keys(childrenRef.current).forEach(loadDir);
  const collapseAll = () => setExpanded(new Set(roots));
  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

  // ---------- Teclado ----------

  /** Filas visibles en orden, para moverse con las flechas. */
  const visible = useMemo(() => {
    const out: Entry[] = [];
    const walk = (dir: string) => {
      for (const e of children[dir] ?? []) {
        out.push(e);
        if (e.isDir && expanded.has(e.path)) walk(e.path);
      }
    };
    for (const root of roots) {
      out.push({ name: basename(root), path: root, isDir: true });
      if (expanded.has(root)) walk(root);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children, expanded, rootsKey]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !selected) return;
    const entry = visible.find((v) => v.path === selected);
    if (!entry) return;
    const idx = visible.indexOf(entry);
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = visible[idx + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) setSelected(next.path);
    } else if (e.key === "ArrowRight" && entry.isDir && !expanded.has(entry.path)) toggle(entry.path);
    else if (e.key === "ArrowLeft") {
      if (entry.isDir && expanded.has(entry.path)) toggle(entry.path);
      else if (!isRootPath(entry.path)) setSelected(dirname(entry.path));
    } else if (e.key === "Enter") entry.isDir ? toggle(entry.path) : p.onOpenFile(entry.path);
    else if (e.key === "F2" && !isRootPath(entry.path)) setEditing({ mode: "rename", path: entry.path, isDir: entry.isDir });
    else if ((e.key === "Delete" || (mod && e.key === "Backspace")) && !isRootPath(entry.path)) remove(entry);
    else return;
    e.preventDefault();
  };

  // ---------- Problemas (errores/advertencias) ----------

  const problemsIn = (path: string, isDir: boolean): FileProblems | null => {
    if (!isDir) return p.problems.get(path) ?? null;
    let errors = 0, warnings = 0;
    p.problems.forEach((v, file) => {
      if (isInside(file, path)) {
        errors += v.errors;
        warnings += v.warnings;
      }
    });
    return errors || warnings ? { errors, warnings } : null;
  };

  /** Letra de Git de un archivo; en carpetas, un punto si algo adentro cambió. */
  const gitOf = (path: string, isDir: boolean): string | null => {
    const m = p.gitDecorations;
    if (!m?.size) return null;
    if (!isDir) return m.get(path) ?? null;
    for (const [file, letter] of m) if (letter !== "D" && isInside(file, path)) return "•";
    return null;
  };

  // ---------- Render ----------

  if (!roots.length && !p.solution) {
    return (
      <div className="explorer">
        <div className="panel-title"><span>{t("EXPLORADOR")}</span></div>
        <div className="muted pad">{t("No hay ningún proyecto abierto.")}</div>
      </div>
    );
  }

  const renderRow = (entry: Entry, depth: number, isRoot = false) => {
    const isOpen = expanded.has(entry.path);
    const renaming = editing?.mode === "rename" && editing.path === entry.path;
    const prob = problemsIn(entry.path, entry.isDir);
    const gitLetter = isRoot ? null : gitOf(entry.path, entry.isDir);
    const dropDir = entry.isDir ? entry.path : dirname(entry.path);
    const proj = entry.isDir ? projectByDir.get(entry.path) : undefined;
    const isStartup = !!proj && proj.dir === p.startupDir;
    const cls = [
      "tree-row",
      isRoot && "root",
      selected === entry.path && "selected",
      p.activePath === entry.path && "active",
      dropTarget === entry.path && "drop",
      prob?.errors ? "has-errors" : prob?.warnings ? "has-warnings" : "",
      proj && "project",
      isStartup && "startup",
      gitLetter && "git-" + (gitLetter === "•" ? "dir" : gitLetter),
    ].filter(Boolean).join(" ");

    return (
      <div
        key={entry.path}
        data-path={entry.path}
        className={cls}
        style={{ paddingLeft: 6 + depth * 14 }}
        title={relative(rootOf(entry.path), entry.path) || entry.path}
        draggable={!isRoot && !renaming}
        onClick={() => {
          setSelected(entry.path);
          if (entry.isDir) toggle(entry.path);
          else p.onOpenFile(entry.path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setSelected(entry.path);
          setMenu({ x: e.clientX, y: e.clientY, entry, isRoot });
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, entry.path);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          setDropTarget(entry.isDir ? entry.path : dropDir);
        }}
        onDragLeave={() => setDropTarget((t) => (t === entry.path ? null : t))}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(null);
          const from = e.dataTransfer.getData(DRAG_TYPE);
          if (from) move(from, dropDir);
        }}
      >
        <span className="twisty">{entry.isDir && <Codicon name={isOpen ? "chevron-down" : "chevron-right"} />}</span>
        <span className="file-icon">
          <FileIcon name={entry.name} isDir={entry.isDir} open={isOpen} project={proj?.kind} />
        </span>
        {renaming ? (
          <InlineInput initial={entry.name} selectStem={!entry.isDir} onDone={commitEdit} onCancel={() => setEditing(null)} />
        ) : (
          <>
            <span className="label">{entry.name}</span>
            {isStartup && <Codicon name="play" className="startup-badge" title={t("Proyecto de inicio")} />}
            {prob && !entry.isDir && (
              <span className={"problem-count " + (prob.errors ? "err" : "warn")}>
                {prob.errors || prob.warnings}
              </span>
            )}
            {prob && entry.isDir && !isOpen && <Codicon name="circle-filled" className={"problem-dot " + (prob.errors ? "err" : "warn")} />}
            {gitLetter && !prob && <span className="git-deco">{gitLetter}</span>}
          </>
        )}
      </div>
    );
  };

  const renderDir = (dir: string, depth: number): React.ReactNode[] => {
    const rows: React.ReactNode[] = [];
    const creating = editing && editing.mode !== "rename" && editing.parent === dir ? editing : null;
    if (creating) {
      rows.push(
        <div key="__new" className="tree-row editing" style={{ paddingLeft: 6 + depth * 14 }}>
          <span className="twisty" />
          <span className="file-icon">
            <FileIcon name="" isDir={creating.mode === "new-folder"} />
          </span>
          <InlineInput initial="" onDone={commitEdit} onCancel={() => setEditing(null)} />
        </div>,
      );
    }
    for (const e of children[dir] ?? []) {
      rows.push(renderRow(e, depth));
      if (e.isDir && expanded.has(e.path)) rows.push(...renderDir(e.path, depth + 1));
    }
    return rows;
  };

  const menuEntry = menu?.entry;
  const menuProject = menuEntry?.isDir ? projectByDir.get(menuEntry.path) : undefined;
  const menuDir = menuEntry ? (menuEntry.isDir ? menuEntry.path : dirname(menuEntry.path)) : null;

  return (
    <div className="explorer">
      <div className="panel-title">
        <span>{t("EXPLORADOR")}</span>
        <span className="title-actions">
          <button className="icon-btn" title={t("Nuevo archivo")} onClick={() => startNew("new-file", targetDir(selected))}><Codicon name="new-file" /></button>
          <button className="icon-btn" title={t("Nueva carpeta")} onClick={() => startNew("new-folder", targetDir(selected))}><Codicon name="new-folder" /></button>
          <button className="icon-btn" title={t("Actualizar")} onClick={refreshAll}><Codicon name="refresh" /></button>
          <button className="icon-btn" title={t("Contraer todo")} onClick={collapseAll}><Codicon name="collapse-all" /></button>
        </span>
      </div>
      <div
        className="tree"
        ref={treeRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget || roots.length !== 1) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: { name: basename(roots[0]), path: roots[0], isDir: true }, isRoot: true });
        }}
        onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && e.target === e.currentTarget && e.preventDefault()}
        onDrop={(e) => {
          if (e.target !== e.currentTarget) return;
          const from = e.dataTransfer.getData(DRAG_TYPE);
          if (from && roots.length === 1) move(from, roots[0]);
        }}
      >
        {p.solution && (
          <div
            className="tree-row solution-row"
            title={p.solution.file}
            onContextMenu={(e) => {
              e.preventDefault();
              setSolutionMenu({ x: e.clientX, y: e.clientY });
            }}
            onDoubleClick={() => p.onSolution("edit-file")}
          >
            <span className="twisty" />
            <span className="file-icon"><Codicon name="layers" /></span>
            <span className="label">{t("Solución “")}{p.solution.name}”</span>
            <span className="muted small solution-count">{roots.length} {roots.length === 1 ? t("proyecto") : t("proyectos")}</span>
            <button className="icon-btn" title={t("Agregar proyecto nuevo")} onClick={(e) => { e.stopPropagation(); p.onSolution("new-project"); }}>
              <Codicon name="add" />
            </button>
            <button className="icon-btn" title={t("Agregar proyecto existente")} onClick={(e) => { e.stopPropagation(); p.onSolution("add-existing"); }}>
              <Codicon name="folder-library" />
            </button>
          </div>
        )}
        {p.solution && roots.length === 0 && (
          <div className="muted small pad">{t("La solución está vacía. Usa")}{" "}<Codicon name="add" /> {" "}{t("para agregar un proyecto.")}</div>
        )}
        {roots.map((root) => (
          <div key={root}>
            {renderRow({ name: basename(root), path: root, isDir: true }, p.solution ? 1 : 0, true)}
            {expanded.has(root) && renderDir(root, p.solution ? 2 : 1)}
          </div>
        ))}
      </div>

      {solutionMenu && p.solution && (
        <div
          className="context-menu"
          style={{ left: Math.min(solutionMenu.x, window.innerWidth - 250), top: Math.min(solutionMenu.y, window.innerHeight - 200) }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setSolutionMenu(null)}
        >
          <div className="menu-header">{t("Solución ·")}{" "}{p.solution.name}</div>
          <MenuItem icon="add" label={t("Agregar proyecto nuevo…")} onClick={() => p.onSolution("new-project")} />
          <MenuItem icon="folder-library" label={t("Agregar proyecto existente…")} onClick={() => p.onSolution("add-existing")} />
          <div className="menu-sep" />
          <MenuItem icon="go-to-file" label={t("Abrir el archivo .rxsln")} onClick={() => p.onSolution("edit-file")} />
          <MenuItem icon="folder-opened" label={revealLabel()} onClick={() => api.revealPath(p.solution!.file).catch(() => {})} />
        </div>
      )}

      {menu && menuEntry && menuDir && (
        <div
          className="context-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 300) }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setMenu(null)}
        >
          {!menuEntry.isDir && <MenuItem icon="go-to-file" label={t("Abrir")} onClick={() => p.onOpenFile(menuEntry.path)} />}
          {menuProject && (
            <>
              <div className="menu-header">{menuProject.kind === "bin" ? t("Aplicación") : t("Biblioteca")} · {menuProject.name}</div>
              {menuProject.dir !== p.startupDir && (
                <MenuItem icon="play" label={t("Establecer como proyecto de inicio")} onClick={() => p.onSetStartup(menuProject.dir)} />
              )}
              <MenuItem icon="references" label={t("Agregar referencia a proyecto…")} onClick={() => p.onAddReference(menuProject.dir)} />
              <MenuItem icon="package" label={t("Administrar paquetes…")} onClick={() => p.onManagePackages(menuProject.dir)} />
              <div className="menu-sep" />
            </>
          )}
          {menuEntry.isDir && (
            <>
              <MenuItem icon="new-file" label={t("Nuevo archivo…")} onClick={() => startNew("new-file", menuDir)} />
              <MenuItem icon="new-folder" label={t("Nueva carpeta…")} onClick={() => startNew("new-folder", menuDir)} />
            </>
          )}
          <div className="menu-sep" />
          <MenuItem icon="folder-opened" label={revealLabel()} onClick={() => api.revealPath(menuEntry.path).catch((e) => p.onError(tErr(e)))} />
          <MenuItem icon="copy" label={t("Copiar ruta")} onClick={() => copy(menuEntry.path)} />
          {!menu.isRoot && <MenuItem label={t("Copiar ruta relativa")} onClick={() => copy(relative(rootOf(menuEntry.path), menuEntry.path))} />}
          {!menu.isRoot && (
            <>
              <div className="menu-sep" />
              <MenuItem
                icon="edit"
                label={t("Renombrar")}
                shortcut="F2"
                onClick={() => setEditing({ mode: "rename", path: menuEntry.path, isDir: menuEntry.isDir })}
              />
              <MenuItem icon="trash" label={t("Eliminar")} shortcut="Supr" danger onClick={() => remove(menuEntry)} />
            </>
          )}
          {menu.isRoot && (
            <>
              <div className="menu-sep" />
              {p.solution ? (
                <MenuItem icon="close" label={t("Quitar de la solución")} onClick={() => p.onSolution("remove", menuEntry.path)} />
              ) : (
                <MenuItem icon="layers" label={t("Guardar como solución (.rxsln)…")} onClick={() => p.onSolution("save-as")} />
              )}
              <MenuItem icon="refresh" label={t("Actualizar")} onClick={refreshAll} />
              <MenuItem icon="collapse-all" label={t("Contraer todo")} onClick={collapseAll} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem(props: { icon?: string; label: string; shortcut?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button className={"menu-item" + (props.danger ? " danger" : "")} onClick={props.onClick}>
      <span className="menu-label">
        <Codicon name={props.icon ?? "blank"} />
        {props.label}
      </span>
      {props.shortcut && <span className="muted">{props.shortcut}</span>}
    </button>
  );
}

/** Campo de texto en línea para crear o renombrar (Enter confirma, Escape cancela). */
function InlineInput(props: { initial: string; selectStem?: boolean; onDone: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Al renombrar, seleccionar el nombre sin la extensión (como VS Code).
    const dot = props.initial.lastIndexOf(".");
    el.setSelectionRange(0, props.selectStem && dot > 0 ? dot : props.initial.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    commit ? props.onDone(ref.current?.value ?? "") : props.onCancel();
  };
  return (
    <input
      ref={ref}
      className="tree-input"
      defaultValue={props.initial}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

function revealLabel() {
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return t("Mostrar en Finder");
  if (ua.includes("Windows")) return t("Mostrar en el Explorador");
  return "Abrir carpeta contenedora";
}

