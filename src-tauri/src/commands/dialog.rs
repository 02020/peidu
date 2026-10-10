use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn pick_file(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Markdown 文档", &["md", "markdown", "txt"])
        .add_filter("Word 文档", &["doc", "docx"])
        .blocking_pick_file();

    match selected {
        Some(path) => path
            .into_path()
            .map(|p| Some(p.to_string_lossy().into_owned()))
            .map_err(|e| format!("打开文件对话框失败: {e}")),
        None => Ok(None),
    }
}

/// T2: pick_folder 空壳 — 由前端 plugin-dialog 处理。
/// 保留供 generate_handler 引用;避免 Rust 端编译报错。
#[tauri::command]
pub fn pick_folder(_app: AppHandle) -> Result<Option<String>, String> {
    Ok(None)
}
