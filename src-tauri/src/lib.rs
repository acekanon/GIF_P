mod commands;
pub mod compression_research;
mod core;
mod export_pipeline;
pub mod quality_lab;
mod quality_metrics;
mod release_trust;
mod webp_container;

pub fn run() {
    commands::initialize_application_process_job()
        .expect("failed to initialize GIFP process cleanup job");
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::project::render_edit_project,
            commands::project::save_edit_project,
            commands::project::open_edit_project,
            commands::select_videos,
            commands::select_output_dir,
            commands::select_screen_region,
            commands::list_encoder_capabilities,
            commands::get_runtime_resource_snapshot,
            commands::generate_cutout_preview,
            release_trust::get_release_trust,
            commands::convert_gif,
            commands::convert_animation,
            commands::cancel_conversion_task,
            commands::inspect_media,
            commands::evaluate_output_quality,
            commands::generate_media_thumbnails,
            commands::generate_frame_page,
            commands::track_media_region,
            commands::merge_gif,
            commands::render_dynamic_poster,
            commands::open_directory,
            commands::start_screen_recording,
            commands::stop_screen_recording
        ])
        .build(tauri::generate_context!())
        .expect("failed to build GIF_P");
    app.run(|_app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            commands::shutdown_screen_recording();
        }
    });
}
