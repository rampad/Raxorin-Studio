mod crates;
mod dap;
mod fs_cmds;
mod lsp;
mod monitor;
mod projects;
mod runner;
mod solution;
mod toolchain;
mod watcher;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(runner::ProcState::default())
        .manage(lsp::LspState::default())
        .manage(watcher::WatchState::default())
        .manage(dap::DapState::default())
        .manage(monitor::MonitorState::default())
        .manage(solution::PendingOpen(std::sync::Mutex::new(solution::path_from_args())))
        .invoke_handler(tauri::generate_handler![
            fs_cmds::list_dir,
            fs_cmds::read_file,
            fs_cmds::write_file,
            fs_cmds::create_project,
            fs_cmds::create_file,
            fs_cmds::create_dir,
            fs_cmds::rename_path,
            fs_cmds::delete_path,
            fs_cmds::reveal_path,
            watcher::watch_project,
            projects::find_projects,
            solution::solution_read,
            solution::solution_create,
            solution::solution_add_project,
            solution::solution_remove_project,
            solution::solution_set_startup,
            solution::solution_find,
            solution::take_pending_open,
            dap::debugger_info,
            dap::dap_start,
            dap::dap_send,
            dap::dap_stop,
            dap::debug_stdin_create,
            dap::debug_stdin_write,
            projects::add_project_reference,
            runner::start_task,
            runner::stop_task,
            runner::send_stdin,
            toolchain::toolchain_status,
            toolchain::install_components,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            crates::crate_search,
            crates::crate_list,
            crates::crate_add,
            crates::crate_remove,
            crates::crate_details,
            crates::crate_readme,
            crates::crate_latest,
            crates::crate_set_features,
        ])
        .build(tauri::generate_context!())
        .expect("error al iniciar Raxorin Studio")
        .run(|app, event| {
            // Al cerrar la app, no dejar programas depurados huérfanos.
            match event {
                tauri::RunEvent::Exit => app.state::<dap::DapState>().shutdown(),
                // macOS: doble clic en un .rxsln (con la app cerrada o abierta).
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let paths: Vec<String> = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    if let Some(first) = paths.first() {
                        *app.state::<solution::PendingOpen>().0.lock().unwrap() = Some(first.clone());
                        let _ = tauri::Emitter::emit(app, "open-path", first.clone());
                    }
                }
                _ => {}
            }
        });
}
