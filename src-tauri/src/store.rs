// src-tauri/src/store.rs
// 简单文件 KV 存储——每个键独立 JSON 文件，原子写（tmp + rename）。
// D0 范围：prefs / shelf / book 三个键。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const PREFS_FILE: &str = "prefs.json";
pub const SHELF_FILE: &str = "shelf.json";
pub const BOOK_FILE: &str = "book.json";

/// 划线/笔记默认存 <appdata>/notes/<fp>.json
pub fn notes_path(app: &AppHandle, fingerprint: &str) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("notes");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create notes dir: {e}"))?;
    }
    // fp 只用字母数字和下划线 (避免路径穿越)
    let safe: String = fingerprint.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    Ok(dir.join(format!("{safe}.json")))
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // T12 便携版: exe 同级 peidu.portable 文件存在 → 用 exe 旁目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let marker = parent.join("peidu.portable");
            if marker.exists() {
                let dir = parent.join("peidu-data");
                if !dir.exists() {
                    fs::create_dir_all(&dir).map_err(|e| format!("create portable dir: {e}"))?;
                }
                return Ok(dir);
            }
        }
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    }
    Ok(dir)
}

pub fn atomic_write(path: &PathBuf, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("sync: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

pub fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
    let v: T = serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
    Ok(Some(v))
}

pub fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(path, &json)
}

pub fn file_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(name))
}
