mod crates;
mod dap;
mod fs_cmds;
mod git;
mod lsp;
mod monitor;
mod projects;
mod runner;
mod solution;
mod samples;
mod setup;
mod toolchain;
mod update;
mod watcher;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(update::PendingUpdate::default())
        .setup(|app| {
            // `raxorin-studio --actualizar`: actualizar sin abrir la ventana.
            if let Some(channel) = update::cli_requested() {
                if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                    let _ = w.hide();
                }
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let code = update::cli_update(handle.clone(), channel).await;
                    handle.exit(code);
                });
            }
            Ok(())
        })
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
            fs_cmds::write_file_base64,
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
            runner::rust_targets,
            runner::cross_status,
            samples::samples_list,
            samples::sample_create,
            setup::setup_status,
            update::update_check,
            update::update_install,
            update::update_restart,
            git::git_status,
            git::git_init,
            git::git_nested_repos,
            git::git_init_solution,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_show_file,
            git::git_branches,
            git::git_checkout,
            git::git_delete_branch,
            git::git_merge,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_stash,
            git::git_stash_count,
            git::git_log,
            git::git_remote_add,
            git::git_clone,
            git::git_identity,
            git::git_set_identity,
            git::gh_status,
            git::gh_repo_create,
            git::gh_login,
            git::github_publish_info,
            git::github_publish,
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
