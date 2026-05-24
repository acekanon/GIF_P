mod commands;
mod core;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::select_videos,
            commands::select_output_dir,
            commands::select_screen_region,
            commands::convert_gif,
            commands::start_screen_recording,
            commands::stop_screen_recording
        ])
        .run(tauri::generate_context!())
        .expect("failed to run GIF_P");
}
