// Integración con Git (y GitHub mediante `gh`). Usa el `git` del sistema, así respeta la
// configuración y las credenciales del usuario. Las operaciones corren fuera del hilo
// principal para no congelar la interfaz.

use crate::toolchain::{find_tool, new_command};
use serde::Serialize;
use std::path::{Path, PathBuf};

fn git_bin() -> PathBuf {
    find_tool("git").unwrap_or_else(|| PathBuf::from("git"))
}

/// Ejecuta git en `dir` y devuelve su salida estándar (o el error que explica git).
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = new_command(git_bin())
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .current_dir(dir)
        // Nunca quedarse esperando una contraseña en una terminal invisible.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| format!("No se pudo ejecutar git: {e}. ¿Está instalado?"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        Err(explain(&err))
    }
}

/// Agrega una explicación en español a los errores más comunes de git.
fn explain(err: &str) -> String {
    let hint = if err.contains("Please tell me who you are") || err.contains("empty ident") {
        Some("Configura tu nombre y correo para los commits (panel Git → Identidad).")
    } else if err.contains("could not read Username") || err.contains("Authentication failed") || err.contains("terminal prompts disabled") {
        Some("Git necesita iniciar sesión. Inicia sesión en GitHub desde el panel Git.")
    } else if err.contains("non-fast-forward") || err.contains("fetch first") || err.contains("rejected") {
        Some("El servidor tiene cambios que tú no tienes: haz Pull primero y luego Push.")
    } else if err.contains("Not possible to fast-forward") || err.contains("divergent branches") {
        Some("Tu rama y la del servidor tienen cambios distintos.")
    } else if err.contains("would be overwritten") {
        Some("Confirma o guarda temporalmente (stash) tus cambios antes de continuar.")
    } else if err.contains("CONFLICT") || err.contains("conflict") {
        Some("Hay conflictos: resuélvelos en los archivos marcados y confirma.")
    } else {
        None
    };
    match hint {
        Some(h) => format!("{err}\n\n{h}"),
        None => err.to_string(),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------- Estado ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Ruta relativa al repositorio (con /).
    pub path: String,
    /// Ruta anterior si se renombró.
    pub orig: Option<String>,
    /// Estado en el área de preparación (index) y en la copia de trabajo: M, A, D, R, C, U, ? o ".".
    pub index: String,
    pub worktree: String,
    pub conflict: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    name: String,
    url: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Carpeta raíz del repositorio; None si `dir` no está en un repositorio.
    repo: Option<String>,
    branch: Option<String>,
    detached: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    has_commits: bool,
    files: Vec<GitFile>,
    remotes: Vec<GitRemote>,
    /// Hay una operación a medias (merge, rebase…).
    in_progress: Option<String>,
}

/// Interpreta `git status --porcelain=v2 --branch -z`.
pub fn parse_status(raw: &str) -> (Option<String>, bool, Option<String>, u32, u32, bool, Vec<GitFile>) {
    let (mut branch, mut detached, mut upstream, mut ahead, mut behind, mut has_commits) = (None, false, None, 0, 0, true);
    let mut files = Vec::new();
    let mut parts = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(entry) = parts.next() {
        if let Some(h) = entry.strip_prefix("# branch.head ") {
            if h == "(detached)" {
                detached = true;
            } else {
                branch = Some(h.to_string());
            }
        } else if let Some(o) = entry.strip_prefix("# branch.oid ") {
            has_commits = o != "(initial)";
        } else if let Some(u) = entry.strip_prefix("# branch.upstream ") {
            upstream = Some(u.to_string());
        } else if let Some(ab) = entry.strip_prefix("# branch.ab ") {
            for t in ab.split(' ') {
                if let Some(n) = t.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = t.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(rest) = entry.strip_prefix("1 ") {
            // 1 XY sub mH mI mW hH hI path
            let f: Vec<&str> = rest.splitn(8, ' ').collect();
            if f.len() == 8 {
                files.push(file(f[0], f[7], None, false));
            }
        } else if let Some(rest) = entry.strip_prefix("2 ") {
            // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
            let f: Vec<&str> = rest.splitn(9, ' ').collect();
            if f.len() == 9 {
                let orig = parts.next().map(String::from);
                files.push(file(f[0], f[8], orig, false));
            }
        } else if let Some(rest) = entry.strip_prefix("u ") {
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            let f: Vec<&str> = rest.splitn(10, ' ').collect();
            if f.len() == 10 {
                files.push(file(f[0], f[9], None, true));
            }
        } else if let Some(path) = entry.strip_prefix("? ") {
            files.push(GitFile { path: path.into(), orig: None, index: "?".into(), worktree: "?".into(), conflict: false });
        }
    }
    (branch, detached, upstream, ahead, behind, has_commits, files)
}

fn file(xy: &str, path: &str, orig: Option<String>, conflict: bool) -> GitFile {
    let mut c = xy.chars();
    GitFile {
        path: path.to_string(),
        orig,
        index: c.next().unwrap_or('.').to_string(),
        worktree: c.next().unwrap_or('.').to_string(),
        conflict,
    }
}

fn repo_root(dir: &Path) -> Option<PathBuf> {
    git(dir, &["rev-parse", "--show-toplevel"]).ok().map(|s| PathBuf::from(s.trim()))
}

fn status_of(dir: &Path) -> Result<GitStatus, String> {
    let Some(root) = repo_root(dir) else { return Ok(GitStatus::default()) };
    let raw = git(&root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
    let (branch, detached, upstream, ahead, behind, has_commits, files) = parse_status(&raw);
    let remotes = git(&root, &["remote", "-v"])
        .unwrap_or_default()
        .lines()
        .filter(|l| l.ends_with("(fetch)"))
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some(GitRemote { name: it.next()?.into(), url: it.next()?.into() })
        })
        .collect();
    let git_dir = git(&root, &["rev-parse", "--git-dir"]).map(|s| root.join(s.trim())).unwrap_or_else(|_| root.join(".git"));
    let in_progress = [("MERGE_HEAD", "merge"), ("rebase-merge", "rebase"), ("rebase-apply", "rebase"), ("CHERRY_PICK_HEAD", "cherry-pick")]
        .iter()
        .find(|(f, _)| git_dir.join(f).exists())
        .map(|(_, n)| n.to_string());
    Ok(GitStatus {
        repo: Some(root.to_string_lossy().into_owned()),
        branch,
        detached,
        upstream,
        ahead,
        behind,
        has_commits,
        files,
        remotes,
        in_progress,
    })
}

#[tauri::command]
pub async fn git_status(dir: String) -> Result<GitStatus, String> {
    blocking(move || status_of(Path::new(&dir))).await
}

// ---------- Cambios ----------

/// Crea el repositorio y un .gitignore que excluye lo compilado (target/).
fn init_repo(dir: &Path) -> Result<(), String> {
    git(dir, &["init", "-b", "main"])?;
    ensure_gitignore(dir)
}

fn ensure_gitignore(dir: &Path) -> Result<(), String> {
    let path = dir.join(".gitignore");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.lines().any(|l| matches!(l.trim(), "target" | "target/" | "/target" | "/target/" | "**/target" | "**/target/")) {
        return Ok(());
    }
    let mut text = current;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("# Archivos compilados por cargo\ntarget/\n");
    std::fs::write(&path, text).map_err(|e| format!("No se pudo escribir .gitignore: {e}"))
}

#[tauri::command]
pub async fn git_init(dir: String) -> Result<(), String> {
    blocking(move || init_repo(Path::new(&dir))).await
}

/// Proyecto de una solución que tiene su propio repositorio (p. ej. creado por `cargo new`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedRepo {
    path: String,
    commits: u32,
    /// Tiene cambios sin confirmar.
    dirty: bool,
}

/// Repositorios propios de los proyectos que están dentro de `base`.
fn nested_repos(base: &Path, projects: &[String]) -> Vec<NestedRepo> {
    let base = base.canonicalize().unwrap_or(base.to_path_buf());
    projects
        .iter()
        .filter_map(|p| {
            let dir = Path::new(p).canonicalize().ok()?;
            if dir == base || !dir.starts_with(&base) || !dir.join(".git").exists() {
                return None;
            }
            let commits = git(&dir, &["rev-list", "--count", "HEAD"]).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
            let dirty = !git(&dir, &["status", "--porcelain"]).unwrap_or_default().trim().is_empty();
            Some(NestedRepo { path: p.clone(), commits, dirty })
        })
        .collect()
}

#[tauri::command]
pub async fn git_nested_repos(base: String, projects: Vec<String>) -> Result<Vec<NestedRepo>, String> {
    blocking(move || Ok(nested_repos(Path::new(&base), &projects))).await
}

/// Un solo repositorio para la solución: lo crea en `base` y mueve a la papelera el `.git`
/// propio de cada proyecto interno (si no, Git los trataría como repositorios aparte).
#[tauri::command]
pub async fn git_init_solution(base: String, projects: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = Path::new(&base);
        for n in nested_repos(root, &projects) {
            let dotgit = Path::new(&n.path).join(".git");
            trash::delete(&dotgit).map_err(|e| format!("No se pudo mover {} a la papelera: {e}", dotgit.display()))?;
        }
        if git(root, &["rev-parse", "--show-toplevel"]).map(|t| Path::new(t.trim()) == root.canonicalize().unwrap_or(root.to_path_buf())).unwrap_or(false) {
            ensure_gitignore(root)
        } else {
            init_repo(root)
        }
    })
    .await
}

/// Prepara archivos (vacío = todos).
#[tauri::command]
pub async fn git_stage(repo: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["add", "-A", "--"];
        args.extend(paths.iter().map(String::as_str));
        git(Path::new(&repo), &args).map(|_| ())
    })
    .await
}

/// Quita archivos del área de preparación (vacío = todos).
#[tauri::command]
pub async fn git_unstage(repo: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = Path::new(&repo);
        // Sin commits todavía no hay HEAD: se usa rm --cached.
        let has_head = git(root, &["rev-parse", "--verify", "HEAD"]).is_ok();
        let mut args: Vec<&str> = if has_head { vec!["reset", "-q", "HEAD", "--"] } else { vec!["rm", "-r", "-q", "--cached", "--"] };
        if paths.is_empty() {
            args.push(".");
        }
        args.extend(paths.iter().map(String::as_str));
        git(root, &args).map(|_| ())
    })
    .await
}

/// Descarta los cambios sin preparar. Los archivos nuevos (sin seguimiento) van a la papelera.
#[tauri::command]
pub async fn git_discard(repo: String, paths: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = Path::new(&repo);
        if !paths.is_empty() {
            let mut args = vec!["checkout", "--"];
            args.extend(paths.iter().map(String::as_str));
            git(root, &args)?;
        }
        for p in &untracked {
            trash::delete(root.join(p)).map_err(|e| format!("No se pudo mover {p} a la papelera: {e}"))?;
        }
        Ok(())
    })
    .await
}

/// Confirma (commit). Si no hay nada preparado y `all`, prepara todo antes.
#[tauri::command]
pub async fn git_commit(repo: String, message: String, amend: bool, all: bool) -> Result<String, String> {
    blocking(move || {
        let root = Path::new(&repo);
        if message.trim().is_empty() && !amend {
            return Err("Escribe un mensaje para el commit.".into());
        }
        if all {
            git(root, &["add", "-A"])?;
        }
        let mut args = vec!["commit", "-m", message.as_str()];
        if amend {
            args.push("--amend");
            if message.trim().is_empty() {
                args = vec!["commit", "--amend", "--no-edit"];
            }
        }
        git(root, &args)?;
        git(root, &["rev-parse", "--short", "HEAD"]).map(|s| s.trim().to_string())
    })
    .await
}

/// Contenido de un archivo en una revisión ("HEAD") o en el índice (""). Vacío si no existe.
#[tauri::command]
pub async fn git_show_file(repo: String, rev: String, path: String) -> Result<String, String> {
    blocking(move || Ok(git(Path::new(&repo), &["show", &format!("{rev}:{path}")]).unwrap_or_default())).await
}

// ---------- Ramas ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    name: String,
    current: bool,
    remote: bool,
    upstream: Option<String>,
}

pub fn parse_branches(raw: &str) -> Vec<GitBranch> {
    raw.lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let refname = f.next()?;
            let head = f.next().unwrap_or("");
            let upstream = f.next().filter(|s| !s.is_empty()).map(String::from);
            let (name, remote) = match refname.strip_prefix("refs/heads/") {
                Some(n) => (n, false),
                None => (refname.strip_prefix("refs/remotes/")?, true),
            };
            // origin/HEAD es un alias, no una rama.
            if remote && name.ends_with("/HEAD") {
                return None;
            }
            Some(GitBranch { name: name.into(), current: head == "*", remote, upstream })
        })
        .collect()
}

#[tauri::command]
pub async fn git_branches(repo: String) -> Result<Vec<GitBranch>, String> {
    blocking(move || {
        let raw = git(
            Path::new(&repo),
            &["for-each-ref", "--format=%(refname)%09%(HEAD)%09%(upstream:short)", "refs/heads", "refs/remotes"],
        )?;
        Ok(parse_branches(&raw))
    })
    .await
}

/// Cambia de rama. `create`: crea una rama nueva desde la actual. Una rama remota
/// ("origin/x") crea la local que la sigue.
#[tauri::command]
pub async fn git_checkout(repo: String, name: String, create: bool, remote: bool) -> Result<(), String> {
    blocking(move || {
        let root = Path::new(&repo);
        if create {
            git(root, &["check-ref-format", "--branch", &name]).map_err(|_| format!("“{name}” no es un nombre de rama válido (sin espacios ni caracteres especiales)."))?;
            git(root, &["checkout", "-b", &name]).map(|_| ())
        } else if remote {
            git(root, &["checkout", "--track", &name]).map(|_| ())
        } else {
            git(root, &["checkout", &name]).map(|_| ())
        }
    })
    .await
}

#[tauri::command]
pub async fn git_delete_branch(repo: String, name: String, force: bool) -> Result<(), String> {
    blocking(move || git(Path::new(&repo), &["branch", if force { "-D" } else { "-d" }, &name]).map(|_| ())).await
}

/// Combina (merge) otra rama en la actual.
#[tauri::command]
pub async fn git_merge(repo: String, name: String) -> Result<String, String> {
    blocking(move || git(Path::new(&repo), &["merge", "--no-edit", &name])).await
}

// ---------- Sincronizar ----------

#[tauri::command]
pub async fn git_fetch(repo: String) -> Result<(), String> {
    blocking(move || git(Path::new(&repo), &["fetch", "--all", "--prune"]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_pull(repo: String) -> Result<String, String> {
    blocking(move || git(Path::new(&repo), &["pull", "--no-rebase", "--no-edit"])).await
}

/// Push. Si la rama todavía no existe en el servidor, la publica (`-u origin HEAD`).
fn push(root: &Path) -> Result<String, String> {
    let has_upstream = git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
    if has_upstream {
        git(root, &["push"])
    } else {
        let remote = git(root, &["remote"])?.lines().next().map(String::from).ok_or(
            "Este repositorio no tiene un servidor remoto. Publícalo en GitHub o agrega un remoto.",
        )?;
        git(root, &["push", "-u", &remote, "HEAD"])
    }
}

#[tauri::command]
pub async fn git_push(repo: String) -> Result<String, String> {
    blocking(move || push(Path::new(&repo))).await
}

/// Guarda temporalmente los cambios (stash) o los recupera (`pop`).
#[tauri::command]
pub async fn git_stash(repo: String, pop: bool) -> Result<String, String> {
    blocking(move || {
        if pop {
            git(Path::new(&repo), &["stash", "pop"])
        } else {
            git(Path::new(&repo), &["stash", "push", "--include-untracked", "-m", "Raxorin Studio"])
        }
    })
    .await
}

#[tauri::command]
pub async fn git_stash_count(repo: String) -> Result<usize, String> {
    blocking(move || Ok(git(Path::new(&repo), &["stash", "list"]).unwrap_or_default().lines().count())).await
}

// ---------- Historial ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    hash: String,
    short: String,
    author: String,
    date: String,
    subject: String,
    refs: String,
}

pub fn parse_log(raw: &str) -> Vec<GitCommit> {
    raw.split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            if f.len() < 6 {
                return None;
            }
            Some(GitCommit {
                hash: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                date: f[3].into(),
                subject: f[4].into(),
                refs: f[5].trim().into(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_log(repo: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    blocking(move || {
        let root = Path::new(&repo);
        if git(root, &["rev-parse", "--verify", "HEAD"]).is_err() {
            return Ok(Vec::new());
        }
        let n = limit.to_string();
        let raw = git(root, &["log", "-n", &n, "--date=relative", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D%x1e"])?;
        Ok(parse_log(&raw))
    })
    .await
}

// ---------- Repositorios y remotos ----------

#[tauri::command]
pub async fn git_remote_add(repo: String, name: String, url: String) -> Result<(), String> {
    blocking(move || git(Path::new(&repo), &["remote", "add", &name, &url]).map(|_| ())).await
}

/// Clona `url` dentro de `parent` y devuelve la carpeta creada.
#[tauri::command]
pub async fn git_clone(url: String, parent: String) -> Result<String, String> {
    blocking(move || {
        let name = url.trim_end_matches('/').trim_end_matches(".git").rsplit(['/', ':']).next().unwrap_or("repositorio").to_string();
        let dest = Path::new(&parent).join(&name);
        if dest.exists() {
            return Err(format!("Ya existe la carpeta {}", dest.display()));
        }
        git(Path::new(&parent), &["clone", &url, &name])?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    name: String,
    email: String,
}

#[tauri::command]
pub async fn git_identity(repo: String) -> Result<GitIdentity, String> {
    blocking(move || {
        let root = Path::new(&repo);
        let get = |k: &str| git(root, &["config", k]).map(|s| s.trim().to_string()).unwrap_or_default();
        Ok(GitIdentity { name: get("user.name"), email: get("user.email") })
    })
    .await
}

/// Guarda nombre y correo para los commits (en la configuración global del usuario).
#[tauri::command]
pub async fn git_set_identity(repo: String, name: String, email: String) -> Result<(), String> {
    blocking(move || {
        let root = Path::new(&repo);
        git(root, &["config", "--global", "user.name", name.trim()])?;
        git(root, &["config", "--global", "user.email", email.trim()]).map(|_| ())
    })
    .await
}

// ---------- GitHub (gh) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    installed: bool,
    user: Option<String>,
}

fn gh(dir: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let bin = find_tool("gh").ok_or("Falta GitHub CLI (gh). Instálalo desde https://cli.github.com")?;
    let mut cmd = new_command(bin);
    cmd.args(args).env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1");
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    // gh llama a git: que lo encuentre aunque la app se abra desde Finder.
    if let Some(dir) = git_bin().parent() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        if let Ok(p) = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&path))) {
            cmd.env("PATH", p);
        }
    }
    let out = cmd.output().map_err(|e| format!("No se pudo ejecutar gh: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn gh_status() -> Result<GhStatus, String> {
    blocking(|| {
        if find_tool("gh").is_none() {
            return Ok(GhStatus { installed: false, user: None });
        }
        let user = gh(None, &["api", "user", "--jq", ".login"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        Ok(GhStatus { installed: true, user })
    })
    .await
}

/// Crea un repositorio en GitHub con el contenido de `repo` y sube la rama actual.
#[tauri::command]
pub async fn gh_repo_create(repo: String, name: String, private: bool, description: String) -> Result<String, String> {
    blocking(move || {
        let root = Path::new(&repo);
        if git(root, &["rev-parse", "--verify", "HEAD"]).is_err() {
            return Err("Haz al menos un commit antes de publicar en GitHub.".into());
        }
        let visibility = if private { "--private" } else { "--public" };
        let mut args = vec!["repo", "create", name.as_str(), visibility, "--source", ".", "--remote", "origin", "--push"];
        if !description.trim().is_empty() {
            args.extend(["--description", description.as_str()]);
        }
        gh(Some(root), &args)?;
        // URL del repositorio creado.
        gh(Some(root), &["repo", "view", "--json", "url", "--jq", ".url"]).map(|s| s.trim().to_string())
    })
    .await
}

/// Abre una terminal con `gh auth login` (el inicio de sesión de GitHub es interactivo).
#[tauri::command]
pub fn gh_login() -> Result<(), String> {
    let gh = find_tool("gh").ok_or("Falta GitHub CLI (gh). Instálalo desde https://cli.github.com")?;
    let cmd = format!("'{}' auth login --web --git-protocol https", gh.display());
    #[cfg(target_os = "macos")]
    {
        let script = format!("tell application \"Terminal\" to do script \"{}\"\ntell application \"Terminal\" to activate", cmd.replace('"', "\\\""));
        std::process::Command::new("osascript").args(["-e", &script]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd").args(["/C", "start", "cmd", "/K", &cmd.replace('\'', "\"")]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let ok = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"].iter().any(|t| {
            std::process::Command::new(t).args(["-e", "sh", "-c", &cmd]).spawn().is_ok()
        });
        if !ok {
            return Err("No se encontró una terminal. Ejecuta: gh auth login".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estado_porcelain_v2() {
        let raw = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/main.rs\0\
1 A. N... 000000 100644 100644 000 ccc nuevo archivo.rs\0\
2 R. N... 100644 100644 100644 ddd eee R100 src/nuevo.rs\0src/viejo.rs\0\
u UU N... 100644 100644 100644 100644 f1 f2 f3 conflicto.rs\0\
? sin seguir.txt\0";
        let (branch, detached, upstream, ahead, behind, has_commits, files) = parse_status(raw);
        assert_eq!(branch.as_deref(), Some("main"));
        assert!(!detached && has_commits);
        assert_eq!(upstream.as_deref(), Some("origin/main"));
        assert_eq!((ahead, behind), (2, 1));
        assert_eq!(files.len(), 5);
        assert_eq!((files[0].index.as_str(), files[0].worktree.as_str()), (".", "M"));
        assert_eq!(files[1].path, "nuevo archivo.rs", "rutas con espacios");
        assert_eq!(files[2].orig.as_deref(), Some("src/viejo.rs"));
        assert!(files[3].conflict);
        assert_eq!(files[4].index, "?");
    }

    #[test]
    fn estado_sin_commits_y_detached() {
        let (_, _, _, _, _, has_commits, _) = parse_status("# branch.oid (initial)\0# branch.head main\0");
        assert!(!has_commits);
        let (branch, detached, ..) = parse_status("# branch.oid abc\0# branch.head (detached)\0");
        assert!(branch.is_none() && detached);
    }

    #[test]
    fn ramas_y_historial() {
        let b = parse_branches("refs/heads/main\t*\torigin/main\nrefs/heads/nueva\t \t\nrefs/remotes/origin/HEAD\t \t\nrefs/remotes/origin/main\t \t\n");
        assert_eq!(b.len(), 3);
        assert!(b[0].current && b[0].upstream.as_deref() == Some("origin/main"));
        assert!(b[2].remote && b[2].name == "origin/main");
        let log = parse_log("a1\x1fa\x1fAna\x1fhace 2 horas\x1fPrimer commit\x1fHEAD -> main\x1e\nb2\x1fb\x1fBeto\x1fayer\x1fOtro\x1f\x1e\n");
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "Primer commit");
        assert_eq!(log[1].refs, "");
    }

    /// Flujo completo en un repositorio temporal: init, commit, rama, cambios, descartar.
    #[test]
    fn flujo_completo() {
        let dir = std::env::temp_dir().join(format!("raxorin-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g = |args: &[&str]| git(&dir, args).unwrap();
        init_repo(&dir).unwrap();
        assert!(std::fs::read_to_string(dir.join(".gitignore")).unwrap().contains("target/"), ".gitignore con target/");
        ensure_gitignore(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(".gitignore")).unwrap().matches("target/").count(), 1, "no se repite");
        g(&["config", "user.name", "Prueba"]);
        g(&["config", "user.email", "prueba@example.com"]);
        std::fs::write(dir.join("a.txt"), "uno\n").unwrap();
        let s = status_of(&dir).unwrap();
        assert!(!s.has_commits && s.files.len() == 2 && s.files.iter().all(|f| f.index == "?"), "a.txt y .gitignore");
        g(&["add", "-A"]);
        g(&["commit", "-m", "inicial"]);
        std::fs::write(dir.join("a.txt"), "dos\n").unwrap();
        let s = status_of(&dir).unwrap();
        assert_eq!(s.files[0].worktree, "M");
        // Contenido en HEAD (para ver diferencias).
        assert_eq!(git(&dir, &["show", "HEAD:a.txt"]).unwrap(), "uno\n");
        g(&["checkout", "--", "a.txt"]);
        assert!(status_of(&dir).unwrap().files.is_empty(), "descartar vuelve al último commit");
        g(&["checkout", "-b", "rama-nueva"]);
        assert_eq!(status_of(&dir).unwrap().branch.as_deref(), Some("rama-nueva"));
        let log = parse_log(&g(&["log", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D%x1e"]));
        assert_eq!(log[0].subject, "inicial");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Solución con proyectos que traen su propio repositorio → un solo repositorio.
    #[test]
    fn un_repositorio_para_la_solucion() {
        let base = std::env::temp_dir().join(format!("raxorin-gitsol-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (a, b) = (base.join("app"), base.join("lib"));
        for d in [&a, &b] {
            std::fs::create_dir_all(d.join("src")).unwrap();
            std::fs::write(d.join("src/main.rs"), "fn main() {}").unwrap();
            git(d, &["init", "-b", "main"]).unwrap();
        }
        git(&a, &["-c", "user.name=P", "-c", "user.email=p@e.com", "commit", "--allow-empty", "-m", "x"]).unwrap();
        std::fs::write(base.join("Sol.rxsln"), "[solucion]\nnombre = \"Sol\"\n").unwrap();
        let projects = vec![a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()];
        let nested = nested_repos(&base, &projects);
        assert_eq!(nested.len(), 2);
        assert_eq!(nested.iter().find(|n| n.path.ends_with("app")).unwrap().commits, 1);
        // Inicializar la solución (sin papelera en la prueba: se quitan los .git a mano).
        for n in &nested {
            std::fs::remove_dir_all(Path::new(&n.path).join(".git")).unwrap();
        }
        init_repo(&base).unwrap();
        let s = status_of(&a).unwrap();
        assert_eq!(Path::new(s.repo.as_deref().unwrap()).canonicalize().unwrap(), base.canonicalize().unwrap(), "el proyecto queda en el repositorio de la solución");
        let files: Vec<_> = s.files.iter().map(|f| f.path.as_str()).collect();
        assert!(files.contains(&"app/src/main.rs") && files.contains(&"lib/src/main.rs") && files.contains(&"Sol.rxsln"), "{files:?}");
        assert!(nested_repos(&base, &projects).is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    /// Push y pull contra un "servidor" local (repositorio bare), incluida una rama nueva sin upstream.
    #[test]
    fn push_y_pull() {
        let base = std::env::temp_dir().join(format!("raxorin-gitremote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let server = base.join("server.git");
        git(&base, &["init", "--bare", "-b", "main", server.to_str().unwrap()]).unwrap();
        let (a, b) = (base.join("a"), base.join("b"));
        for d in [&a, &b] {
            git(&base, &["clone", server.to_str().unwrap(), d.to_str().unwrap()]).unwrap();
            git(d, &["config", "user.name", "Prueba"]).unwrap();
            git(d, &["config", "user.email", "p@example.com"]).unwrap();
        }
        // a: primer commit y push (main todavía no existe en el servidor → -u).
        std::fs::write(a.join("x.txt"), "1").unwrap();
        git(&a, &["add", "-A"]).unwrap();
        git(&a, &["commit", "-m", "uno"]).unwrap();
        push(&a).unwrap();
        assert!(status_of(&a).unwrap().upstream.is_some(), "queda con upstream");
        // b: pull trae el commit.
        git(&b, &["pull", "--no-rebase", "--no-edit"]).unwrap();
        assert_eq!(std::fs::read_to_string(b.join("x.txt")).unwrap(), "1");
        // b: rama nueva y push → se publica.
        git(&b, &["checkout", "-b", "funcion"]).unwrap();
        std::fs::write(b.join("y.txt"), "2").unwrap();
        git(&b, &["add", "-A"]).unwrap();
        git(&b, &["commit", "-m", "dos"]).unwrap();
        push(&b).unwrap();
        git(&a, &["fetch", "--all", "--prune"]).unwrap();
        let branches = parse_branches(&git(&a, &["for-each-ref", "--format=%(refname)%09%(HEAD)%09%(upstream:short)", "refs/heads", "refs/remotes"]).unwrap());
        assert!(branches.iter().any(|x| x.remote && x.name == "origin/funcion"), "la rama nueva llegó al servidor");
        // a: commit sin pull → ahead 1; b sin hacer pull → behind tras fetch.
        std::fs::write(a.join("x.txt"), "3").unwrap();
        git(&a, &["commit", "-am", "tres"]).unwrap();
        assert_eq!(status_of(&a).unwrap().ahead, 1);
        std::fs::remove_dir_all(&base).ok();
    }
}

// ---------- Publicar con GitHub Actions ----------
// Un workflow compila uno o varios programas (todos los de una solución) en máquinas de
// GitHub con Windows, Linux y macOS, y deja un .zip por sistema en la versión (Release).

/// Datos de un programa para el workflow (de `cargo metadata`).
#[derive(Debug, PartialEq, Clone)]
struct CrateMeta {
    name: String,
    version: String,
    bin: String,
    uses_slint: bool,
    /// Carpeta target absoluta.
    target_dir: PathBuf,
}

fn crate_meta(project: &Path) -> Result<CrateMeta, String> {
    let out = new_command(crate::toolchain::cargo_bin())
        .args(["metadata", "--no-deps", "--format-version", "1"])
        .current_dir(project)
        .output()
        .map_err(|e| format!("No se pudo ejecutar cargo metadata: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let manifest = project.join("Cargo.toml").canonicalize().map_err(|e| e.to_string())?;
    let pkg = v["packages"]
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p["manifest_path"].as_str().and_then(|m| Path::new(m).canonicalize().ok()).as_deref() == Some(manifest.as_path())))
        .ok_or("No se encontró el paquete en cargo metadata")?;
    let name = pkg["name"].as_str().unwrap_or("programa").to_string();
    let bin = pkg["targets"]
        .as_array()
        .and_then(|ts| ts.iter().find(|t| t["kind"].as_array().is_some_and(|k| k.iter().any(|x| x == "bin"))))
        .and_then(|t| t["name"].as_str())
        .ok_or(format!("“{name}” no genera un ejecutable (¿es una biblioteca?)."))?
        .to_string();
    let uses_slint = pkg["dependencies"].as_array().is_some_and(|ds| ds.iter().any(|d| d["name"] == "slint"));
    let target_dir = PathBuf::from(v["target_directory"].as_str().unwrap_or("target"));
    Ok(CrateMeta {
        version: pkg["version"].as_str().unwrap_or("0.1.0").to_string(),
        name,
        bin,
        uses_slint,
        target_dir: target_dir.canonicalize().unwrap_or(target_dir),
    })
}

/// Ruta de `to` relativa a `from`, con "/" (p. ej. "../target").
fn relative_path(from: &Path, to: &Path) -> String {
    let f: Vec<_> = from.components().collect();
    let t: Vec<_> = to.components().collect();
    let common = f.iter().zip(&t).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); f.len() - common];
    parts.extend(t[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    if parts.is_empty() { ".".into() } else { parts.join("/") }
}

/// Un programa dentro del repositorio: carpeta y target relativos a la raíz del repositorio.
#[derive(Debug, Clone)]
struct WfProject {
    meta: CrateMeta,
    dir: String,
    target: String,
}

fn render_workflow(name: &str, projects: &[WfProject]) -> String {
    let mut y = String::new();
    y.push_str(&format!(
        "# Generado por Raxorin Studio: compila {name} para Windows, Linux y macOS.\n\
         # Se ejecuta al subir una etiqueta de versión (por ejemplo v1.0.0) o a mano desde la pestaña Actions.\n\
         # Cada sistema compila en su propia máquina de GitHub; los .zip quedan en la versión (Release).\n\
         name: Publicar {name}\n\n\
         on:\n  push:\n    tags: [\"v*\"]\n  workflow_dispatch:\n\n\
         permissions:\n  contents: write\n\n\
         jobs:\n  build:\n    name: ${{{{ matrix.label }}}}\n    strategy:\n      fail-fast: false\n      matrix:\n        include:\n\
         \x20         - {{ label: windows-x86_64, os: windows-latest, target: x86_64-pc-windows-msvc }}\n\
         \x20         - {{ label: linux-x86_64, os: ubuntu-22.04, target: x86_64-unknown-linux-gnu }}\n\
         \x20         - {{ label: macos-aarch64, os: macos-latest, target: aarch64-apple-darwin }}\n\
         \x20         - {{ label: macos-x86_64, os: macos-latest, target: x86_64-apple-darwin }}\n\
         \x20   runs-on: ${{{{ matrix.os }}}}\n\
         \x20   defaults:\n      run:\n        shell: bash\n\
         \x20   steps:\n      - uses: actions/checkout@v4\n"
    ));
    if projects.iter().any(|p| p.meta.uses_slint) {
        y.push_str(
            "\n      - name: Bibliotecas de Linux para la interfaz (Slint)\n        if: runner.os == 'Linux'\n        run: |\n          sudo apt-get update\n          sudo apt-get install -y libfontconfig1-dev libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev libx11-xcb-dev\n",
        );
    }
    y.push_str("\n      - uses: dtolnay/rust-toolchain@stable\n        with:\n          targets: ${{ matrix.target }}\n");
    y.push_str("\n      - uses: swatinem/rust-cache@v2\n        with:\n          workspaces: |\n");
    let mut seen = Vec::new();
    for p in projects {
        let line = format!("            {} -> {}\n", p.dir, relative_path(Path::new(&format!("/r/{}", p.dir)), Path::new(&format!("/r/{}", p.target))));
        if !seen.contains(&line) {
            y.push_str(&line);
            seen.push(line);
        }
    }
    for p in projects {
        y.push_str(&format!(
            "\n      - name: Compilar {}\n        working-directory: {}\n        run: cargo build --release --target ${{{{ matrix.target }}}}\n",
            p.meta.name, p.dir
        ));
    }
    y.push_str(&format!(
        "\n      - name: Empaquetar\n        run: |\n\
         \x20         VERSION=\"dev\"\n\
         \x20         if [ \"$GITHUB_REF_TYPE\" = \"tag\" ]; then VERSION=\"$GITHUB_REF_NAME\"; fi\n\
         \x20         EXT=\"\"\n\
         \x20         if [ \"$RUNNER_OS\" = \"Windows\" ]; then EXT=\".exe\"; fi\n\
         \x20         DIST=\"{name}-$VERSION-${{{{ matrix.label }}}}\"\n\
         \x20         mkdir -p \"dist/$DIST\"\n"
    ));
    for p in projects {
        y.push_str(&format!("          cp \"{}/${{{{ matrix.target }}}}/release/{}$EXT\" \"dist/$DIST/\"\n", p.target, p.meta.bin));
    }
    y.push_str(&format!(
        "          for f in README* LICENSE* LICENCIA*; do if [ -f \"$f\" ]; then cp \"$f\" \"dist/$DIST/\"; fi; done\n\
         \x20         cd dist\n\
         \x20         if [ \"$RUNNER_OS\" = \"Windows\" ]; then 7z a -tzip \"$DIST.zip\" \"$DIST\" > /dev/null; else zip -rq \"$DIST.zip\" \"$DIST\"; fi\n\
         \x20         echo \"ZIP=dist/$DIST.zip\" >> \"$GITHUB_ENV\"\n\
         \n      - uses: actions/upload-artifact@v4\n        with:\n          name: {name}-${{{{ matrix.label }}}}\n          path: ${{{{ env.ZIP }}}}\n\
         \n      - name: Subir a la versión (Release)\n        if: github.ref_type == 'tag'\n        uses: softprops/action-gh-release@v2\n        with:\n          name: {name} ${{{{ github.ref_name }}}}\n          files: ${{{{ env.ZIP }}}}\n"
    ));
    y
}

/// Nombre seguro para el archivo del workflow.
fn slug(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' }).collect();
    s.trim_matches('-').to_string()
}

fn workflow_file(name: &str) -> String {
    format!(".github/workflows/publicar-{}.yml", slug(name))
}

/// Proyectos ejecutables listos para el workflow, o un error que explica qué falta.
fn prepare(root: &Path, projects: &[String]) -> Result<Vec<WfProject>, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut outside = Vec::new();
    for p in projects {
        let dir = Path::new(p).canonicalize().map_err(|e| format!("{p}: {e}"))?;
        if !dir.starts_with(&root) {
            outside.push(p.clone());
            continue;
        }
        let meta = crate_meta(&dir)?;
        let target = if meta.target_dir.starts_with(&root) { relative_path(&root, &meta.target_dir) } else { format!("{}/target", relative_path(&root, &dir)) };
        out.push(WfProject { dir: relative_path(&root, &dir), target, meta });
    }
    if !outside.is_empty() {
        return Err(format!(
            "Estos proyectos están fuera del repositorio ({}) y GitHub no los vería:\n{}\nMuévelos dentro de la carpeta del repositorio.",
            root.display(),
            outside.join("\n")
        ));
    }
    if out.is_empty() {
        return Err("No hay programas ejecutables para publicar.".into());
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPublishInfo {
    repo: Option<String>,
    github_url: Option<String>,
    /// Versión sugerida (del primer programa).
    version: String,
    workflow: String,
    workflow_exists: bool,
    tags: Vec<String>,
    /// Programas que se compilarán (nombres) o el problema que lo impide.
    programs: Vec<String>,
    problem: Option<String>,
}

fn github_web_url(root: &Path) -> Option<String> {
    let url = git(root, &["remote", "get-url", "origin"]).ok()?;
    let rest = url.trim().split("github.com").nth(1)?.trim_start_matches([':', '/']);
    Some(format!("https://github.com/{}", rest.trim_end_matches('/').trim_end_matches(".git")))
}

/// `base`: carpeta de la solución o del proyecto (dónde está el repositorio).
#[tauri::command]
pub async fn github_publish_info(base: String, name: String, projects: Vec<String>) -> Result<GithubPublishInfo, String> {
    blocking(move || {
        let root = repo_root(Path::new(&base));
        let workflow = workflow_file(&name);
        let prepared = root.as_deref().map(|r| prepare(r, &projects));
        let (programs, problem, version) = match &prepared {
            Some(Ok(ps)) => (ps.iter().map(|p| p.meta.name.clone()).collect(), None, ps[0].meta.version.clone()),
            Some(Err(e)) => (Vec::new(), Some(e.clone()), "0.1.0".into()),
            None => (Vec::new(), None, "0.1.0".into()),
        };
        Ok(GithubPublishInfo {
            github_url: root.as_deref().and_then(github_web_url),
            workflow_exists: root.as_deref().is_some_and(|r| r.join(&workflow).exists()),
            tags: root.as_deref().map(|r| git(r, &["tag", "--list", "v*"]).unwrap_or_default().lines().map(String::from).collect()).unwrap_or_default(),
            repo: root.map(|r| r.to_string_lossy().into_owned()),
            version,
            workflow,
            programs,
            problem,
        })
    })
    .await
}

/// Escribe (o actualiza) el workflow. Con `tag`, además lo confirma, crea la etiqueta y sube
/// todo: eso dispara la compilación en GitHub. Devuelve la página de Actions (o el archivo).
#[tauri::command]
pub async fn github_publish(base: String, name: String, projects: Vec<String>, tag: Option<String>) -> Result<String, String> {
    blocking(move || {
        let root = repo_root(Path::new(&base)).ok_or("No está en un repositorio de Git. Inicialízalo en el panel Git.")?;
        let web = github_web_url(&root).ok_or("El repositorio no está en GitHub. Publícalo desde el panel Git.")?;
        let prepared = prepare(&root, &projects)?;
        let wf_rel = workflow_file(&name);
        let wf = root.join(&wf_rel);
        std::fs::create_dir_all(wf.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&wf, render_workflow(&name, &prepared)).map_err(|e| format!("No se pudo escribir el workflow: {e}"))?;
        let Some(tag) = tag else { return Ok(wf.to_string_lossy().into_owned()) };
        let tag = tag.trim().to_string();
        git(&root, &["check-ref-format", &format!("refs/tags/{tag}")]).map_err(|_| format!("“{tag}” no es una versión válida (usa algo como v1.0.0)."))?;
        if git(&root, &["rev-parse", "-q", "--verify", &format!("refs/tags/{tag}")]).is_ok() {
            return Err(format!("La versión {tag} ya existe. Usa un número nuevo (por ejemplo, súbele uno)."));
        }
        // Confirmar solo el workflow (no los demás cambios del usuario).
        git(&root, &["add", "--", &wf_rel])?;
        if !git(&root, &["diff", "--cached", "--name-only", "--", &wf_rel])?.trim().is_empty() {
            git(&root, &["commit", "-m", &format!("Publicar {name} con GitHub Actions"), "--", &wf_rel])?;
        }
        push(&root)?;
        git(&root, &["tag", "-a", &tag, "-m", &format!("{name} {tag}")])?;
        git(&root, &["push", "origin", &tag])?;
        Ok(format!("{web}/actions"))
    })
    .await
}

#[cfg(test)]
mod publish_tests {
    use super::*;

    fn meta(name: &str, slint: bool) -> CrateMeta {
        CrateMeta { name: name.into(), version: "0.1.0".into(), bin: name.into(), uses_slint: slint, target_dir: PathBuf::from("/x") }
    }

    #[test]
    fn rutas_relativas() {
        assert_eq!(relative_path(Path::new("/a/b"), Path::new("/a/b/target")), "target");
        assert_eq!(relative_path(Path::new("/a/b/app"), Path::new("/a/b/target")), "../target");
        assert_eq!(relative_path(Path::new("/a/b"), Path::new("/a/b")), ".");
        assert_eq!(slug("Mi Solución 2"), "mi-soluci-n-2");
    }

    #[test]
    fn workflow_de_una_solucion() {
        let y = render_workflow("MiSolucion", &[
            WfProject { meta: meta("ventana", true), dir: "ventana".into(), target: "ventana/target".into() },
            WfProject { meta: meta("consola", false), dir: "herramientas/consola".into(), target: "herramientas/consola/target".into() },
        ]);
        assert!(y.contains("working-directory: ventana") && y.contains("working-directory: herramientas/consola"), "compila cada programa");
        assert!(y.contains("cp \"ventana/target/${{ matrix.target }}/release/ventana$EXT\""));
        assert!(y.contains("cp \"herramientas/consola/target/${{ matrix.target }}/release/consola$EXT\""));
        assert!(y.contains("DIST=\"MiSolucion-$VERSION-${{ matrix.label }}\""), "un zip con todos");
        assert!(y.contains("libfontconfig1-dev"), "uno usa Slint → bibliotecas de Linux");
        assert!(y.contains("ventana -> target") && y.contains("herramientas/consola -> target"), "caché por proyecto");
        assert!(!y.contains("{{") || y.matches("${{").count() == y.matches("{{").count(), "solo expresiones de GitHub");
    }

    #[test]
    fn workflow_es_yaml_valido() {
        let y = render_workflow("app", &[WfProject { meta: meta("app", false), dir: ".".into(), target: "target".into() }]);
        assert!(!y.contains("libfontconfig"));
        assert!(y.contains("working-directory: .\n"));
        // Sin tabulaciones (YAML no las admite en la sangría).
        assert!(!y.contains('\t'));
    }

    /// RAXORIN_WF_OUT=/ruta.yml cargo test --lib -- --ignored escribe_workflow_de_ejemplo
    #[test]
    #[ignore]
    fn escribe_workflow_de_ejemplo() {
        let y = render_workflow("MiSolucion", &[
            WfProject { meta: meta("ventana", true), dir: "ventana".into(), target: "target".into() },
            WfProject { meta: meta("consola", false), dir: "consola".into(), target: "target".into() },
        ]);
        std::fs::write(std::env::var("RAXORIN_WF_OUT").unwrap(), y).unwrap();
    }

    #[test]
    fn metadata_de_un_proyecto_real() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let m = crate_meta(dir).unwrap();
        assert_eq!((m.name.as_str(), m.bin.as_str()), ("raxorin-studio", "raxorin-studio"));
        assert!(m.target_dir.ends_with("target") && !m.uses_slint);
    }
}
