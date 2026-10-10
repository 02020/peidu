// src-tauri/src/commands/doc.rs
// 文档读取：编码检测（encoding_rs + chardetng）+ 文件大小检查（3MB 软阈值标记）。
// 文件选择对话框走前端 @tauri-apps/plugin-dialog（本命令不参与）。

use serde::{Deserialize, Serialize};
use std::fs;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadDocumentResult {
    pub text: String,
    pub encoding: String,
    pub size: u64,
    pub oversized: bool,
}

const SOFT_LIMIT: u64 = 3 * 1024 * 1024; // 3MB

#[tauri::command]
pub fn read_document(path: String) -> Result<ReadDocumentResult, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read file: {e}"))?;
    let size = bytes.len() as u64;
    let (text, encoding) = decode_bytes(&bytes);
    Ok(ReadDocumentResult {
        text,
        encoding,
        size,
        oversized: size > SOFT_LIMIT,
    })
}

/// 编码识别：UTF-8 严格优先；失败则 chardetng 猜测。
fn decode_bytes(bytes: &[u8]) -> (String, String) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let body = &bytes[3..];
        if let Ok(s) = std::str::from_utf8(body) {
            return (s.to_string(), "utf-8-bom".into());
        }
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "utf-8".into());
    }
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let (s, _, _) = enc.decode(bytes);
    (s.into_owned(), enc.name().to_string())
}

/// T5: 读取文档前 N 字符做预览
#[tauri::command]
pub fn read_preview(path: String, limit: i32) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read file: {e}"))?;
    let (text, _) = decode_bytes(&bytes);
    // 取 limit 个字符(按字符切, 不按字节)
    Ok(text.chars().take(limit as usize).collect())
}

/// T5: 复制前 N 字符到剪贴板
#[tauri::command]
pub fn copy_preview(app: AppHandle, path: String, limit: i32) -> Result<(), String> {
    let bytes = fs::read(&path).map_err(|e| format!("read file: {e}"))?;
    let (text, _) = decode_bytes(&bytes);
    let preview: String = text.chars().take(limit as usize).collect();
    app.clipboard()
        .write_text(preview)
        .map_err(|e| format!("clipboard write: {e}"))
}
