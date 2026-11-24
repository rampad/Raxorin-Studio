mod fs_cmds;
mod runner;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(runner::ProcState::default())
        .invoke_handler(tauri::generate_handler![
            fs_cmds::list_dir,
            fs_cmds::read_file,
            fs_cmds::write_file,
            fs_cmds::create_project,
            runner::start_task,
            runner::stop_task,
            runner::send_stdin,
            runner::toolchain_info,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Rust Studio");
}
