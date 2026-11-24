//! Herramientas de diagnóstico: CPU y memoria del programa en ejecución
//! (al ejecutar o al depurar), como en Visual Studio.
//!
//! Eventos emitidos:
//! - `proc-stats-start` { pid, name, mode }
//! - `proc-stats`       { pid, t, cpu, cpuCore, memory }  cada 500 ms
//! - `proc-stats-end`   { pid }

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct MonitorState(Mutex<Option<Arc<AtomicBool>>>);

/// Qué proceso vigilar.
pub enum Target {
    Pid(u32),
    /// Programa lanzado en una terminal externa: se busca por su ejecutable.
    Exe(PathBuf),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsStart {
    pid: u32,
    name: String,
    mode: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    pid: u32,
    /// Milisegundos desde que empezó el monitoreo.
    t: u64,
    /// % del total de la CPU (todos los núcleos = 100 %).
    cpu: f32,
    /// % de un núcleo (puede pasar de 100 % con varios hilos).
    cpu_core: f32,
    /// Memoria residente en bytes.
    memory: u64,
}

#[derive(Clone, Serialize)]
struct StatsEnd {
    pid: u32,
}

const INTERVAL: Duration = Duration::from_millis(500);

/// Empieza a vigilar un proceso (detiene el monitoreo anterior).
pub fn start(app: &AppHandle, target: Target, mode: &'static str) {
    let state = app.state::<MonitorState>();
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(prev) = state.0.lock().unwrap().replace(stop.clone()) {
        prev.store(true, Ordering::SeqCst);
    }
    let app = app.clone();
    thread::spawn(move || {
        let Ok(mut sys) = System::new() else { return };
        let Some(pid) = resolve(&mut sys, target, &stop) else { return };
        let ncpu = thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
        let kind = ProcessRefreshKind::nothing().with_cpu().with_memory();
        let spid = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[spid]), true, kind);
        let name = sys.process(spid).map(|p| p.name().to_string_lossy().into_owned()).unwrap_or_default();
        let _ = app.emit("proc-stats-start", StatsStart { pid, name, mode });
        let started = Instant::now();
        loop {
            thread::sleep(INTERVAL);
            if stop.load(Ordering::SeqCst) {
                break;
            }
            sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[spid]), true, kind);
            let Some(p) = sys.process(spid) else { break };
            // Un proceso zombi ya terminó aunque siga en la tabla.
            if matches!(p.status(), sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead) {
                break;
            }
            let core = p.cpu_usage();
            let _ = app.emit(
                "proc-stats",
                Stats { pid, t: started.elapsed().as_millis() as u64, cpu: core / ncpu, cpu_core: core, memory: p.memory() },
            );
        }
        let _ = app.emit("proc-stats-end", StatsEnd { pid });
    });
}

/// Obtiene el PID; con `Exe` espera hasta 15 s a que aparezca el proceso.
fn resolve(sys: &mut System, target: Target, stop: &AtomicBool) -> Option<u32> {
    match target {
        Target::Pid(pid) => Some(pid),
        Target::Exe(exe) => {
            let wanted = std::fs::canonicalize(&exe).unwrap_or(exe);
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always));
                let found = sys.processes().iter().find(|(_, p)| {
                    p.exe().map(|e| std::fs::canonicalize(e).unwrap_or(e.to_path_buf()) == wanted).unwrap_or(false)
                });
                if let Some((pid, _)) = found {
                    return Some(pid.as_u32());
                }
                thread::sleep(Duration::from_millis(300));
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mide_cpu_y_memoria_de_un_proceso() {
        // Un proceso que consume CPU durante ~1,5 s.
        let mut child = std::process::Command::new("sh")
            .args(["-c", "i=0; while [ $i -lt 400000 ]; do i=$((i+1)); done"])
            .spawn()
            .unwrap();
        let spid = Pid::from_u32(child.id());
        let mut sys = System::new().unwrap();
        let kind = ProcessRefreshKind::nothing().with_cpu().with_memory();
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[spid]), true, kind);
        thread::sleep(Duration::from_millis(600));
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[spid]), true, kind);
        let p = sys.process(spid).expect("proceso");
        let (cpu, mem) = (p.cpu_usage(), p.memory());
        let _ = child.kill();
        let _ = child.wait();
        assert!(cpu > 20.0, "cpu {cpu}");
        assert!(mem > 100 * 1024, "memoria {mem}");
    }
}
