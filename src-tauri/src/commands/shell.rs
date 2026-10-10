// src-tauri/src/commands/shell.rs
// 启动参数 / 剪贴板 / 预留 open_url。

use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[tauri::command]
pub fn get_startup_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

#[tauri::command]
pub fn read_clipboard_text(app: AppHandle) -> Result<String, String> {
    app.clipboard()
        .read_text()
        .map_err(|e| format!("clipboard read: {e}"))
}

#[tauri::command]
pub fn open_clipboard_doc(app: AppHandle, text: String) -> Result<String, String> {
    // 把剪贴板内容写到 appdata/clipboard/<ts>.md, 返回路径
    let dir = crate::store::data_dir(&app)?.join("clipboard");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("clip-{}.md", ts));
    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}
