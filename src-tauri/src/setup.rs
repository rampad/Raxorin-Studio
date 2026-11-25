// Herramientas que Raxorin Studio necesita en la computadora (Rust, compilador de C/C++,
// Git, depurador, GitHub CLI): detectarlas e instalarlas desde la app.
//
// Las instalaciones corren como tareas (ver runner.rs): su salida va al panel y se pueden
// detener. Lo que pide permisos de administrador lo pide el sistema con su propia ventana
// (UAC en Windows, la contraseña de polkit en Linux, el instalador de Apple en macOS).

use crate::runner::{out, run_child, Inner};
use crate::toolchain::{find_tool, new_command, rustup_tool};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    /// Sin esto no se puede compilar ni ejecutar.
    required: bool,
    installed: bool,
    version: Option<String>,
    /// Raxorin Studio puede instalarlo.
    can_install: bool,
    /// La instalación pide permiso de administrador (el sistema lo pregunta).
    needs_admin: bool,
    /// Si no se puede instalar desde la app: cómo hacerlo a mano.
    manual: Option<String>,
    /// No aplica a este sistema (p. ej. el depurador en Windows).
    unavailable: Option<&'static str>,
    /// Está instalado pero incompleto (p. ej. Visual Studio sin el SDK de Windows): se ofrece reparar.
    problem: Option<String>,
}

fn first_line(program: &Path, args: &[&str]) -> Option<String> {
    let o = new_command(program).args(args).output().ok()?;
    if !o.status.success() {
        return None;
    }
    let text = if o.stdout.is_empty() { o.stderr } else { o.stdout };
    String::from_utf8_lossy(&text).lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

// ---------- Linux: gestor de paquetes ----------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Pm {
    Apt,
    Dnf,
    Pacman,
    Zypper,
}

fn linux_pm() -> Option<Pm> {
    [("apt-get", Pm::Apt), ("dnf", Pm::Dnf), ("pacman", Pm::Pacman), ("zypper", Pm::Zypper)]
        .into_iter()
        .find(|(bin, _)| find_tool(bin).is_some())
        .map(|(_, pm)| pm)
}

/// Comando para instalar paquetes con el gestor de la distribución.
fn pm_command(pm: Pm, packages: &[&str]) -> Vec<String> {
    let mut cmd: Vec<String> = match pm {
        Pm::Apt => vec!["apt-get", "install", "-y"],
        Pm::Dnf => vec!["dnf", "install", "-y"],
        Pm::Pacman => vec!["pacman", "-S", "--needed", "--noconfirm"],
        Pm::Zypper => vec!["zypper", "--non-interactive", "install"],
    }
    .into_iter()
    .map(String::from)
    .collect();
    cmd.extend(packages.iter().map(|p| p.to_string()));
    cmd
}

fn linux_packages(pm: Pm, tool: &str) -> &'static [&'static str] {
    match (tool, pm) {
        ("cpp", Pm::Apt) => &["build-essential"],
        ("cpp", Pm::Pacman) => &["base-devel"],
        ("cpp", _) => &["gcc", "gcc-c++", "make"],
        ("git", _) => &["git"],
        ("debugger", _) => &["lldb"],
        _ => &[],
    }
}

fn linux_manual(tool: &str) -> String {
    match linux_pm() {
        Some(pm) => format!("sudo {}", pm_command(pm, linux_packages(pm, tool)).join(" ")),
        None => "Instálalo con el gestor de paquetes de tu distribución.".into(),
    }
}

// ---------- Windows: Visual Studio Build Tools ----------

fn vswhere() -> PathBuf {
    let base = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
    base.join(r"Microsoft Visual Studio\Installer\vswhere.exe")
}

/// Estado de las herramientas de C++ de Visual Studio: lo que Rust necesita para enlazar
/// es `link.exe` (MSVC) y las bibliotecas del SDK de Windows (p. ej. kernel32.lib).
#[derive(Debug, Default)]
struct Msvc {
    /// Arquitectura de los programas que se compilan ("arm64" o "x64").
    arch: &'static str,
    /// Carpeta de una instalación de Visual Studio / Build Tools (aunque esté incompleta).
    install_path: Option<PathBuf>,
    name: Option<String>,
    link: Option<PathBuf>,
    sdk: bool,
}

impl Msvc {
    fn complete(&self) -> bool {
        self.link.is_some() && self.sdk
    }
}

/// vswhere sin ventana de consola (si no, en Windows parpadea una terminal).
fn vswhere_prop(args: &[&str], prop: &str) -> Option<String> {
    let vs = vswhere();
    if !vs.exists() {
        return None;
    }
    let o = new_command(vs).args(args).args(["-property", prop]).output().ok()?;
    String::from_utf8_lossy(&o.stdout).lines().next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Arquitectura para la que compila Rust en este Windows: "arm64" o "x64".
/// Se toma de rustc (`host: aarch64-pc-windows-msvc`); si Rust no está, de la arquitectura real de
/// Windows. Ojo: Raxorin Studio x64 corre emulado en Windows ARM, así que no sirve
/// `std::env::consts::ARCH` (diría x86_64).
pub fn windows_target_arch() -> &'static str {
    if let Some(host) = first_line_matching(&rustup_tool("rustc"), &["-vV"], "host: ") {
        return if host.starts_with("aarch64") { "arm64" } else { "x64" };
    }
    if windows_native_arch() == "ARM64" { "arm64" } else { "x64" }
}

/// Arquitectura real del sistema (el registro no se ve afectado por la emulación).
fn windows_native_arch() -> String {
    new_command("reg")
        .args(["query", r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "/v", "PROCESSOR_ARCHITECTURE"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().last().map(String::from))
        .unwrap_or_default()
}

fn first_line_matching(program: &Path, args: &[&str], prefix: &str) -> Option<String> {
    let o = new_command(program).args(args).output().ok()?;
    String::from_utf8_lossy(&o.stdout).lines().find_map(|l| l.strip_prefix(prefix).map(|s| s.trim().to_string()))
}

/// `link.exe` que genera programas para `arch` (VC\Tools\MSVC\<versión>\bin\Host<cualquiera>\<arch>).
fn find_link(install: &Path, arch: &str) -> Option<PathBuf> {
    let tools = install.join(r"VC\Tools\MSVC");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(tools).ok()?.flatten().map(|e| e.path()).collect();
    versions.sort();
    let hosts = ["Hostarm64", "Hostx64", "Hostx86"];
    versions.into_iter().rev().flat_map(|v| hosts.map(|h| v.join("bin").join(h).join(arch).join("link.exe"))).find(|p| p.is_file())
}

/// El SDK de Windows tiene kernel32.lib en Windows Kits\10\Lib\<versión>\um\<arch>.
fn windows_sdk(arch: &str) -> bool {
    let base = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
    let lib = base.join(r"Windows Kits\10\Lib");
    std::fs::read_dir(lib).ok().is_some_and(|d| d.flatten().any(|e| e.path().join("um").join(arch).join("kernel32.lib").is_file()))
}

/// Componente de Visual Studio con las herramientas de C++ para `arch`.
fn vc_component(arch: &str) -> &'static str {
    if arch == "arm64" { "Microsoft.VisualStudio.Component.VC.Tools.ARM64" } else { "Microsoft.VisualStudio.Component.VC.Tools.x86.x64" }
}

fn msvc() -> Msvc {
    let arch = windows_target_arch();
    let all = ["-latest", "-products", "*"];
    let with_vc = ["-latest", "-products", "*", "-requires", vc_component(arch)];
    let install_path = vswhere_prop(&with_vc, "installationPath").or_else(|| vswhere_prop(&all, "installationPath")).map(PathBuf::from);
    Msvc {
        arch,
        name: vswhere_prop(&all, "displayName"),
        link: install_path.as_deref().and_then(|p| find_link(p, arch)),
        sdk: windows_sdk(arch),
        install_path,
    }
}

// ---------- Detección ----------

fn macos_clt() -> bool {
    new_command("xcode-select").arg("-p").output().is_ok_and(|o| o.status.success())
}

/// Plataforma de los paquetes de CodeLLDB (codelldb-<plataforma>.vsix).
fn codelldb_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("win32-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

/// Versión de CodeLLDB que se instala (probada con Raxorin Studio).
const CODELLDB_VERSION: &str = "v1.12.3";

pub fn status() -> Vec<Tool> {
    let mac = cfg!(target_os = "macos");
    let win = cfg!(windows);
    let mut tools = Vec::new();

    // Rust
    let cargo = first_line(&rustup_tool("cargo"), &["--version"]);
    tools.push(Tool {
        id: "rust",
        name: "Rust",
        description: "El lenguaje y sus herramientas (cargo, rustc, rustup).",
        required: true,
        installed: cargo.is_some(),
        version: cargo,
        can_install: true,
        needs_admin: false,
        manual: Some("https://rustup.rs".into()),
        unavailable: None,
        problem: None,
    });

    // Compilador de C/C++ (Rust lo usa para enlazar los programas)
    let mut cpp_problem: Option<String> = None;
    let (cpp_ok, cpp_version) = if win {
        let m = msvc();
        if m.install_path.is_some() && !m.complete() {
            let a = if m.arch == "arm64" { "ARM64" } else { "x64" };
            cpp_problem = Some(match (m.link.is_some(), m.sdk) {
                (false, false) => format!("Visual Studio está instalado pero faltan las herramientas de C++ para {a} (link.exe) y el SDK de Windows."),
                (false, true) => format!("Visual Studio está instalado pero falta el enlazador de C++ para {a} (link.exe)."),
                _ => format!("Falta el SDK de Windows para {a} (kernel32.lib): Rust no puede enlazar los programas."),
            });
        }
        let a = if m.arch == "arm64" { "ARM64" } else { "x64" };
        (m.complete(), m.name.map(|n| format!("{n} · C++ para {a} y SDK de Windows")))
    } else if mac {
        let ok = macos_clt();
        (ok, if ok { first_line(Path::new("clang"), &["--version"]) } else { None })
    } else {
        let v = find_tool("cc").and_then(|cc| first_line(&cc, &["--version"]));
        (v.is_some(), v)
    };
    tools.push(Tool {
        id: "cpp",
        name: if win { "Visual Studio Build Tools (C++)" } else if mac { "Herramientas de línea de comandos de Xcode" } else { "Compilador de C/C++" },
        description: "Rust lo necesita para crear los programas (enlazador). Incluye el compilador de C/C++.",
        problem: cpp_problem,
        required: true,
        installed: cpp_ok,
        version: cpp_version,
        can_install: win || mac || (linux_pm().is_some() && find_tool("pkexec").is_some()),
        needs_admin: true,
        manual: Some(if win {
            "https://visualstudio.microsoft.com/es/visual-cpp-build-tools/ → «Desarrollo para el escritorio con C++»".into()
        } else if mac {
            "xcode-select --install".into()
        } else {
            linux_manual("cpp")
        }),
        unavailable: None,
    });

    // Git
    let git = find_tool("git").and_then(|g| first_line(&g, &["--version"]));
    let winget = win && find_tool("winget").is_some();
    tools.push(Tool {
        id: "git",
        name: "Git",
        description: "Historial de cambios y GitHub (panel Git).",
        required: false,
        installed: git.is_some() && (!mac || macos_clt()),
        version: git,
        can_install: mac || winget || (!win && linux_pm().is_some() && find_tool("pkexec").is_some()),
        needs_admin: true,
        manual: Some(if win { "https://git-scm.com/download/win".into() } else if mac { "xcode-select --install".into() } else { linux_manual("git") }),
        unavailable: None,
        problem: None,
    });

    // Depurador: lldb-dap (macOS, con las herramientas de Apple) o CodeLLDB (Windows y Linux).
    let dbg = crate::dap::pick_adapter();
    tools.push(Tool {
        id: "debugger",
        name: if mac { "Depurador (lldb-dap)" } else { "Depurador (CodeLLDB)" },
        description: "Para depurar con puntos de interrupción (F5).",
        required: false,
        installed: dbg.is_some(),
        version: dbg.map(|(p, _)| p.to_string_lossy().into_owned()),
        can_install: mac || codelldb_platform().is_some(),
        needs_admin: mac,
        manual: Some(if mac { "xcode-select --install".into() } else { "https://github.com/vadimcn/codelldb/releases".into() }),
        unavailable: None,
        problem: None,
    });

    // GitHub CLI (opcional)
    let gh = find_tool("gh").and_then(|g| first_line(&g, &["--version"]));
    let brew = find_tool("brew").is_some();
    tools.push(Tool {
        id: "gh",
        name: "GitHub CLI (gh)",
        description: "Opcional: publicar proyectos en GitHub desde la app.",
        required: false,
        installed: gh.is_some(),
        version: gh,
        can_install: (mac && brew) || winget,
        needs_admin: false,
        manual: Some(if mac { "brew install gh".into() } else { "https://cli.github.com".into() }),
        unavailable: None,
        problem: None,
    });
    tools
}

#[tauri::command]
pub async fn setup_status() -> Result<Vec<Tool>, String> {
    tauri::async_runtime::spawn_blocking(status).await.map_err(|e| e.to_string())
}

// ---------- Instalación ----------

/// Plataforma de rustup para esta computadora.
fn host_triple() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", _) => "x86_64-apple-darwin",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        // Raxorin Studio x64 corre emulado en Windows ARM: instalar el Rust nativo (ARM64).
        ("windows", _) if windows_native_arch() == "ARM64" => "aarch64-pc-windows-msvc",
        ("windows", _) => "x86_64-pc-windows-msvc",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        _ => "x86_64-unknown-linux-gnu",
    }
}

fn download(app: &AppHandle, url: &str, dest: &Path) -> Result<(), String> {
    out(app, format!("> Descargando {url}\n"), "muted");
    let resp = ureq::get(url).set("User-Agent", "RaxorinStudio-setup").call().map_err(|e| format!("No se pudo descargar: {e}"))?;
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut resp.into_reader(), &mut file).map_err(|e| format!("Descarga interrumpida: {e}"))?;
    Ok(())
}

fn temp_dir() -> Result<PathBuf, String> {
    let d = std::env::temp_dir().join("raxorin-studio-setup");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn run(app: &AppHandle, inner: &Arc<Inner>, mut cmd: Command, label: &str) -> Result<bool, String> {
    out(app, format!("> {label}\n"), "info");
    cmd.env("DEBIAN_FRONTEND", "noninteractive");
    Ok(run_child(app, inner, cmd, false, "muted", None, None)?.map(|s| s.success()).unwrap_or(false))
}

/// Ejecuta un programa como administrador en Windows (el sistema muestra su ventana de UAC).
fn windows_elevated(program: &Path, args: &[&str]) -> Command {
    let quoted = args.iter().map(|a| format!("'{a}'")).collect::<Vec<_>>().join(",");
    let mut cmd = new_command("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        &format!("$p = Start-Process -FilePath '{}' -ArgumentList {quoted} -Verb RunAs -Wait -PassThru; exit $p.ExitCode", program.display()),
    ]);
    cmd
}

/// Instala Rust con rustup-init (sin permisos de administrador). `home`: para pruebas,
/// instala en otra carpeta (CARGO_HOME/RUSTUP_HOME) con el perfil mínimo.
pub fn install_rust(app: &AppHandle, inner: &Arc<Inner>, home: Option<&Path>) -> Result<bool, String> {
    let exe = if cfg!(windows) { "rustup-init.exe" } else { "rustup-init" };
    let dest = temp_dir()?.join(exe);
    download(app, &format!("https://static.rust-lang.org/rustup/dist/{}/{exe}", host_triple()), &dest)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    let mut cmd = new_command(&dest);
    cmd.arg("-y");
    match home {
        Some(h) => {
            cmd.env("CARGO_HOME", h.join("cargo")).env("RUSTUP_HOME", h.join("rustup"));
            cmd.args(["--profile", "minimal", "--no-modify-path"]);
        }
        None => {
            // Perfil por defecto (incluye clippy y rustfmt) + lo que usa el editor.
            cmd.args(["--component", "rust-analyzer", "--component", "rust-src"]);
        }
    }
    run(app, inner, cmd, "Instalando Rust (rustup)… puede tardar unos minutos")
}

fn install_inner(app: &AppHandle, inner: &Arc<Inner>, id: &str) -> Result<bool, String> {
    let mac = cfg!(target_os = "macos");
    let win = cfg!(windows);
    match id {
        "rust" => install_rust(app, inner, None),
        // macOS: el instalador de Apple trae compilador, Git y lldb-dap.
        "cpp" | "git" | "debugger" if mac => {
            new_command("xcode-select").arg("--install").spawn().map_err(|e| e.to_string())?;
            out(app, "Se abrió el instalador de Apple: pulsa «Instalar», espera a que termine y vuelve a revisar.\n", "warning");
            Ok(true)
        }
        // Windows y Linux: CodeLLDB, descargado en la carpeta de datos (sin permisos de administrador).
        "debugger" if !mac => install_codelldb(app),
        "cpp" if win => {
            let dest = temp_dir()?.join("vs_BuildTools.exe");
            download(app, "https://aka.ms/vs/17/release/vs_BuildTools.exe", &dest)?;
            out(app, "Windows pedirá permiso de administrador. La instalación tarda varios minutos.\n", "warning");
            // Si ya hay una instalación (incompleta), se modifica para agregar lo que falta.
            let existing = msvc().install_path;
            let path_arg = existing.as_ref().map(|p| p.to_string_lossy().into_owned());
            let mut args: Vec<&str> = Vec::new();
            if let Some(p) = &path_arg {
                args.extend(["modify", "--installPath", p.as_str()]);
            }
            args.extend([
                "--passive", "--wait", "--norestart",
                "--add", "Microsoft.VisualStudio.Workload.VCTools",
                "--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "--add", vc_component(windows_target_arch()),
                "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621",
                "--includeRecommended",
            ]);
            let cmd = windows_elevated(&dest, &args);
            let label = if existing.is_some() { "Completando Visual Studio Build Tools (C++ y SDK de Windows)…" } else { "Instalando Visual Studio Build Tools (C++)…" };
            let ok = run(app, inner, cmd, label)?;
            // Comprobar de verdad: el instalador puede terminar sin instalar todo.
            let m = msvc();
            if !m.complete() {
                out(app, format!("✖ Falta {}. Vuelve a intentarlo, o instálalo desde el Instalador de Visual Studio (carga de trabajo «Desarrollo para el escritorio con C++»).\n",
                    if m.link.is_none() { "link.exe" } else { "el SDK de Windows" }), "error");
                return Ok(false);
            }
            Ok(ok)
        }
        "git" if win => {
            let mut cmd = new_command("winget");
            cmd.args(["install", "--id", "Git.Git", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"]);
            run(app, inner, cmd, "Instalando Git con winget…")
        }
        "gh" if win => {
            let mut cmd = new_command("winget");
            cmd.args(["install", "--id", "GitHub.cli", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"]);
            run(app, inner, cmd, "Instalando GitHub CLI con winget…")
        }
        "gh" if mac => {
            let brew = find_tool("brew").ok_or("Falta Homebrew (https://brew.sh).")?;
            let mut cmd = new_command(brew);
            cmd.args(["install", "gh"]).env("HOMEBREW_NO_AUTO_UPDATE", "1");
            run(app, inner, cmd, "Instalando GitHub CLI con Homebrew…")
        }
        "cpp" | "git" | "debugger" => {
            let pm = linux_pm().ok_or("No se encontró el gestor de paquetes de la distribución.")?;
            let pkexec = find_tool("pkexec").ok_or_else(|| format!("Ejecuta en una terminal: {}", linux_manual(id)))?;
            out(app, "El sistema pedirá tu contraseña para instalar.\n", "warning");
            if pm == Pm::Apt {
                let mut update = Command::new(&pkexec);
                update.args(["apt-get", "update"]);
                run(app, inner, update, "Actualizando la lista de paquetes…")?;
            }
            let mut cmd = Command::new(pkexec);
            cmd.args(pm_command(pm, linux_packages(pm, id)));
            run(app, inner, cmd, &format!("Instalando {}…", linux_packages(pm, id).join(", ")))
        }
        other => Err(format!("No se puede instalar “{other}” desde la app en este sistema.")),
    }
}

/// Descarga el paquete oficial de CodeLLDB para esta plataforma y extrae su carpeta `extension/`.
pub fn install_codelldb(app: &AppHandle) -> Result<bool, String> {
    let platform = codelldb_platform().ok_or("CodeLLDB no está disponible para esta plataforma.")?;
    let url = format!("https://github.com/vadimcn/codelldb/releases/download/{CODELLDB_VERSION}/codelldb-{platform}.vsix");
    let vsix = temp_dir()?.join(format!("codelldb-{platform}.vsix"));
    download(app, &url, &vsix)?;
    out(app, "> Descomprimiendo el depurador…\n", "info");
    let dest = crate::dap::codelldb_dir();
    let staging = dest.with_extension("nuevo");
    let _ = std::fs::remove_dir_all(&staging);
    extract_extension(&vsix, &staging)?;
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&staging, &dest).map_err(|e| format!("No se pudo instalar el depurador: {e}"))?;
    let _ = std::fs::remove_file(&vsix);
    if crate::dap::find_codelldb().is_none() {
        return Err("El paquete de CodeLLDB no tiene el adaptador esperado.".into());
    }
    out(app, format!("Depurador instalado en {}\n", dest.display()), "muted");
    Ok(true)
}

/// Extrae `extension/…` del .vsix (un zip) en `dest`, conservando los permisos de ejecución.
fn extract_extension(vsix: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(vsix).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Paquete inválido: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let Ok(inner) = rel.strip_prefix("extension") else { continue };
        let out_path = dest.join(inner);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode & 0o777)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Tarea "setup:<id>" (la llama runner::run_task).
pub fn install(app: &AppHandle, inner: &Arc<Inner>, id: &str) -> Result<(bool, Option<i32>), String> {
    let ok = install_inner(app, inner, id)?;
    if ok {
        out(app, "✔ Listo.\n", "success");
    } else {
        out(app, "✖ La instalación no terminó bien. Revisa los mensajes de arriba.\n", "error");
    }
    Ok((ok, Some(if ok { 0 } else { 1 })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detecta_herramientas() {
        let tools = status();
        let ids: Vec<_> = tools.iter().map(|t| t.id).collect();
        assert_eq!(ids, ["rust", "cpp", "git", "debugger", "gh"]);
        assert!(tools.iter().filter(|t| t.required).count() == 2, "Rust y C/C++ son imprescindibles");
        // En la máquina de desarrollo Rust está instalado.
        let rust = &tools[0];
        assert!(rust.installed && rust.version.as_deref().unwrap_or("").starts_with("cargo "));
    }

    /// En las máquinas Windows de GitHub hay Visual Studio con C++ y el SDK: debe detectarse completo.
    #[cfg(windows)]
    #[test]
    fn detecta_visual_studio_completo() {
        let m = msvc();
        println!("{m:?}");
        assert!(m.install_path.is_some(), "no encontró Visual Studio");
        assert!(m.link.as_ref().is_some_and(|p| p.ends_with("link.exe")), "no encontró link.exe");
        assert!(m.link.as_ref().unwrap().parent().unwrap().ends_with(m.arch), "link.exe que genera programas para {}", m.arch);
        assert!(m.sdk, "no encontró el SDK de Windows (kernel32.lib)");
        let cpp = status().into_iter().find(|t| t.id == "cpp").unwrap();
        assert!(cpp.installed && cpp.problem.is_none(), "{cpp:?}");
    }

    #[test]
    fn comandos_de_linux() {
        assert_eq!(pm_command(Pm::Apt, linux_packages(Pm::Apt, "cpp")).join(" "), "apt-get install -y build-essential");
        assert_eq!(pm_command(Pm::Dnf, linux_packages(Pm::Dnf, "cpp")).join(" "), "dnf install -y gcc gcc-c++ make");
        assert_eq!(pm_command(Pm::Pacman, linux_packages(Pm::Pacman, "debugger")).join(" "), "pacman -S --needed --noconfirm lldb");
    }

    /// Extrae el paquete real de CodeLLDB (RAXORIN_CODELLDB_VSIX=/ruta.vsix) y comprueba el adaptador.
    #[test]
    #[ignore]
    fn extrae_codelldb() {
        let vsix = std::env::var("RAXORIN_CODELLDB_VSIX").expect("RAXORIN_CODELLDB_VSIX");
        let dest = std::env::temp_dir().join(format!("raxorin-codelldb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        extract_extension(Path::new(&vsix), &dest).unwrap();
        let exe = dest.join("adapter").join(if cfg!(windows) { "codelldb.exe" } else { "codelldb" });
        assert!(exe.is_file(), "falta {}", exe.display());
        let o = Command::new(&exe).arg("--help").output().unwrap();
        assert!(String::from_utf8_lossy(&o.stdout).contains("--liblldb"), "el adaptador se ejecuta");
        std::fs::remove_dir_all(&dest).ok();
    }

    #[test]
    fn plataforma_de_rustup() {
        let t = host_triple();
        assert!(t.contains(std::env::consts::ARCH) || (std::env::consts::ARCH == "x86_64" && t.starts_with("x86_64")));
    }
}
