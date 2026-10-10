mod commands;
mod store;

use commands::{dialog, doc, shell, store as store_cmd, watch, inbox};

pub fn run() {
    tauri::Builder::default()
        // 单实例：暂时禁用（T5 留待 D2+ 实现，改用文件锁或 mutex 命名）
        // —— 暂时依靠 Tauri 2 deep-link 插件的 on_open_url 自行多开，由用户自行避免多开
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // D4-T8 托盘——prefs.trayEnabled=true 才启用 (实装见 v0.2+; 当前留 prefs 字段 + 占位)
            // Tauri 2 的 tray API 需要精确类型, 留作单独 PR。
            // 深链接：peidu://
            #[cfg(desktop)]
            {
                use tauri::Emitter;
                use tauri_plugin_deep_link::DeepLinkExt;
                // 深链接回调需要 `Fn + Send + Sync + 'static`。
                // `&mut App` 不满足 Sync，所以先克隆 AppHandle 再 move 进闭包。
                let handle = app.handle().clone();
                let _ = app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> =
                        event.urls().iter().map(|u| u.to_string()).collect();
                    let _ = handle.emit("deep_link", &urls);
                });
            }
            // CLI 启动参数
            let args: Vec<String> = std::env::args().skip(1).collect();
            use tauri::Emitter;
            let _ = app.emit("startup_args", &args);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dialog::pick_file,
            dialog::pick_folder,
            doc::read_document,
            doc::read_preview,
            doc::copy_preview,
            shell::get_startup_args,
            shell::read_clipboard_text,
            shell::open_clipboard_doc,
            store_cmd::read_prefs,
            store_cmd::write_prefs,
            store_cmd::read_shelf,
            store_cmd::write_shelf,
            store_cmd::read_book,
            store_cmd::write_book,
            store_cmd::read_notes,
            store_cmd::write_notes,
            watch::start_watch,
            watch::stop_watch,
            inbox::scan_inbox,
            inbox::search_documents,
            inbox::list_folder_tree,
            inbox::push_history,
            inbox::list_history,
            store_cmd::save_paste,
            store_cmd::list_pastes,
            store_cmd::delete_paste,
            store_cmd::add_bookmark,
            store_cmd::list_bookmarks,
            store_cmd::delete_bookmark,
            inbox::remove_history_entry,
            inbox::clear_history,
            store_cmd::list_all_notes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
