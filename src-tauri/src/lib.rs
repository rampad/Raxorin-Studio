mod crates;
mod dap;
mod fs_cmds;
mod lsp;
mod projects;
mod runner;
mod toolchain;
mod watcher;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(runner::ProcState::default())
        .manage(lsp::LspState::default())
        .manage(watcher::WatchState::default())
        .manage(dap::DapState::default())
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
        .run(tauri::generate_context!())
        .expect("error al iniciar Oxide Studio");
}
