// Estado de Git del espacio de trabajo y sus operaciones (commit, ramas, pull, push…).
// Lo comparten el panel Git, el explorador (archivos modificados) y la barra de estado.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type GitStatus } from "../api";

type Log = (text: string, kind?: "info" | "error" | "warning" | "success" | "muted") => void;

/** Letra que se muestra junto al archivo: M modificado, A agregado, D borrado, R renombrado, U nuevo, C conflicto. */
export function gitLetter(f: { index: string; worktree: string; conflict: boolean }): string {
  if (f.conflict) return "C";
  if (f.index === "?") return "U";
  const s = f.worktree !== "." ? f.worktree : f.index;
  return s === "T" ? "M" : s;
}

const join = (repo: string, rel: string) => `${repo.replace(/[\\/]$/, "")}/${rel}`;

/**
 * `base`: carpeta de la solución (o la carpeta abierta). Si no hay repositorio, se crea ahí,
 * así una solución queda en un solo repositorio con todos sus proyectos.
 */
export function useGit(roots: string[], log: Log, base: string | null = null, isSolution = false) {
  const rootsKey = [base, isSolution, ...roots].join("|");
  const [repos, setRepos] = useState<string[]>([]);
  // Carpetas del espacio de trabajo que no están en ningún repositorio.
  const [untrackedRoots, setUntrackedRoots] = useState<string[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [repoOf, setRepoOf] = useState<Record<string, string>>({});
  /** Solución sin un repositorio propio (o con proyectos que traen el suyo): se ofrece unificar. */
  const [solutionSetup, setSolutionSetup] = useState<{ base: string; hasRepo: boolean; nested: { path: string; commits: number; dirty: boolean }[] } | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const repoRef = useRef(repo);
  repoRef.current = repo;

  // Repositorios de las carpetas abiertas (una solución puede tener varios).
  const discover = useCallback(async () => {
    const found: string[] = [];
    const none: string[] = [];
    const all = base ? [base, ...roots.filter((r) => r !== base)] : roots;
    const repoOf: Record<string, string> = {};
    for (const r of all) {
      const s = await api.gitStatus(r).catch(() => null);
      if (s?.repo) {
        repoOf[r] = s.repo;
        if (!found.includes(s.repo)) found.push(s.repo);
      } else none.push(r);
    }
    setRepos(found);
    // Si la carpeta base no tiene repositorio, se ofrece crearlo ahí (no en un proyecto suelto).
    setUntrackedRoots(base && none.includes(base) ? [base] : none);
    setRepoOf(repoOf);
    if (isSolution && base) {
      const nested = await api.gitNestedRepos(base, roots).catch(() => []);
      const hasRepo = !!repoOf[base];
      setSolutionSetup(!hasRepo || nested.length ? { base, hasRepo, nested } : null);
    } else setSolutionSetup(null);
    setRepo((cur) => (cur && found.includes(cur) ? cur : found[0] ?? null));
    if (!found.length) setStatus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey]);

  useEffect(() => {
    void discover();
  }, [discover]);

  const refresh = useCallback(async () => {
    const r = repoRef.current;
    if (!r) return;
    const s = await api.gitStatus(r).catch(() => null);
    if (repoRef.current === r) setStatus(s?.repo ? s : null);
  }, []);

  useEffect(() => {
    setStatus(null);
    void refresh();
  }, [repo, refresh]);

  // Actualizar cuando cambian archivos o se vuelve a la ventana (p. ej. tras usar git en una terminal).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 400);
    };
    const un = listen("fs-changed", soon);
    window.addEventListener("focus", soon);
    return () => {
      clearTimeout(timer);
      un.then((f) => f());
      window.removeEventListener("focus", soon);
    };
  }, [refresh]);

  /** Ejecuta una operación mostrando el progreso y el resultado. */
  const run = useCallback(
    async <T,>(label: string, op: (repo: string) => Promise<T>, done?: (r: T) => string | null): Promise<T | undefined> => {
      const r = repoRef.current;
      if (!r) return undefined;
      setBusy(label);
      setError(null);
      try {
        const res = await op(r);
        const msg = done?.(res);
        if (msg) log(msg, "success");
        return res;
      } catch (e) {
        const msg = String(e);
        setError(msg);
        log(`Git: ${msg}`, "error");
        return undefined;
      } finally {
        setBusy(null);
        void refresh();
      }
    },
    [log, refresh],
  );

  const ops = useMemo(
    () => ({
      stage: (paths: string[]) => run("Preparando…", (r) => api.gitStage(r, paths)),
      unstage: (paths: string[]) => run("Quitando…", (r) => api.gitUnstage(r, paths)),
      discard: (paths: string[], untracked: string[]) => run("Descartando…", (r) => api.gitDiscard(r, paths, untracked)),
      commit: (message: string, amend: boolean, all: boolean) =>
        run("Confirmando…", (r) => api.gitCommit(r, message, amend, all), (h) => `Commit ${h} creado.`),
      fetch: () => run("Trayendo cambios…", (r) => api.gitFetch(r), () => "Fetch completado."),
      pull: () => run("Pull…", (r) => api.gitPull(r), (out) => (out.includes("Already up to date") ? "Ya estás al día." : "Pull completado.")),
      push: () => run("Push…", (r) => api.gitPush(r), () => "Push completado."),
      checkout: (name: string, create = false, remote = false) =>
        run("Cambiando de rama…", (r) => api.gitCheckout(r, name, create, remote), () => (create ? `Rama “${name}” creada.` : `Ahora en “${name}”.`)),
      deleteBranch: (name: string, force = false) =>
        run("Borrando rama…", async (r) => {
          await api.gitDeleteBranch(r, name, force);
          return true; // undefined = falló
        }, () => `Rama “${name}” borrada.`),
      merge: (name: string) => run("Combinando…", (r) => api.gitMerge(r, name), () => `“${name}” combinada en la rama actual.`),
      stash: (pop: boolean) =>
        run(pop ? "Recuperando cambios…" : "Guardando cambios…", (r) => api.gitStash(r, pop), () =>
          pop ? "Cambios recuperados." : "Cambios guardados temporalmente (stash)."),
      init: async (dir: string) => {
        setBusy("Inicializando…");
        try {
          await api.gitInit(dir);
          log(`Repositorio de Git creado en ${dir}`, "success");
          await discover();
        } catch (e) {
          setError(String(e));
          log(`Git: ${e}`, "error");
        } finally {
          setBusy(null);
        }
      },
      publishGitHub: (name: string, priv: boolean, description: string) =>
        run("Publicando en GitHub…", (r) => api.ghRepoCreate(r, name, priv, description), (url) => `Publicado en GitHub: ${url}`),
      initSolution: async () => {
        if (!base) return;
        setBusy("Creando el repositorio de la solución…");
        setError(null);
        try {
          await api.gitInitSolution(base, roots);
          log(`Repositorio de la solución creado en ${base}`, "success");
          await discover();
        } catch (e) {
          setError(String(e));
          log(`Git: ${e}`, "error");
        } finally {
          setBusy(null);
        }
      },
      addRemote: (url: string) => run("Agregando remoto…", (r) => api.gitRemoteAdd(r, "origin", url), () => "Remoto “origin” agregado."),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, log, discover, base, rootsKey],
  );

  /** Ruta absoluta → letra de estado (para el explorador). */
  const decorations = useMemo(() => {
    const m = new Map<string, string>();
    if (status?.repo) for (const f of status.files) m.set(join(status.repo, f.path), gitLetter(f));
    return m;
  }, [status]);

  /** Proyectos abiertos que no están en el repositorio elegido (p. ej. de una solución). */
  const outside = useMemo(() => (repo ? roots.filter((r) => repoOf[r] !== repo) : []), [roots, repoOf, repo]);

  return { repos, untrackedRoots, outside, solutionSetup, repo, setRepo, status, busy, error, clearError: () => setError(null), refresh, ops, decorations };
}

export type GitState = ReturnType<typeof useGit>;
export { join as repoPath };
