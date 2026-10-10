// src-tauri/src/commands/store.rs
// prefs / shelf / book 三个键的读写。

use crate::store::{file_path, notes_path, read_json, write_json, PREFS_FILE, SHELF_FILE, BOOK_FILE};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

// ---- Prefs ----

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Prefs {
    pub version: u32,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default)]
    pub big_mode: bool,
    #[serde(default = "default_true")]
    pub animations: bool,
    #[serde(default)]
    pub inbox_path: Option<String>,
    #[serde(default)]
    pub inbox_ignored: Vec<String>,
    #[serde(default = "default_true")]
    pub font_bundled: bool,
    #[serde(default)]
    pub tray_enabled: bool,
}

fn default_theme() -> String { "sepia".into() }
fn default_font_size() -> u32 { 18 }
fn default_true() -> bool { true }

impl Default for Prefs {
    fn default() -> Self {
        Self {
            version: 1,
            theme: default_theme(),
            font_size: default_font_size(),
            big_mode: false,
            animations: true,
            inbox_path: None,
            inbox_ignored: vec![],
            font_bundled: true,
            tray_enabled: false,
        }
    }
}

// ---- Shelf ----

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ShelfItem {
    pub path: String,
    pub title: String,
    pub max_anchor: i32,
    pub total_segs: i32,
    pub dur: i32,
    pub last_open: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Shelf {
    pub version: u32,
    pub items: Vec<ShelfItem>,
}

impl Default for Shelf {
    fn default() -> Self {
        Self { version: 1, items: vec![] }
    }
}

// ---- Book ----

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Book {
    pub path: String,
    pub text: String,
    pub cursor: i32,
}

// ---- Commands ----

#[tauri::command]
pub fn read_prefs(app: AppHandle) -> Result<Prefs, String> {
    let path = file_path(&app, PREFS_FILE)?;
    Ok(read_json::<Prefs>(&path)?.unwrap_or_default())
}

#[tauri::command]
pub fn write_prefs(app: AppHandle, prefs: Prefs) -> Result<(), String> {
    let path = file_path(&app, PREFS_FILE)?;
    write_json(&path, &prefs)
}

#[tauri::command]
pub fn read_shelf(app: AppHandle) -> Result<Shelf, String> {
    let path = file_path(&app, SHELF_FILE)?;
    Ok(read_json::<Shelf>(&path)?.unwrap_or_default())
}

#[tauri::command]
pub fn write_shelf(app: AppHandle, shelf: Shelf) -> Result<(), String> {
    let path = file_path(&app, SHELF_FILE)?;
    write_json(&path, &shelf)
}

#[tauri::command]
pub fn read_book(app: AppHandle) -> Result<Option<Book>, String> {
    let path = file_path(&app, BOOK_FILE)?;
    read_json::<Book>(&path)
}

#[tauri::command]
pub fn write_book(app: AppHandle, book: Book) -> Result<(), String> {
    let path = file_path(&app, BOOK_FILE)?;
    write_json(&path, &book)
}

// ---- Notes (划线 / 速记) ----

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Highlight {
    pub id: String,
    pub anchor: Anchor,
    pub text: String,
    pub color: String,
    pub note: Option<String>,
    pub created_at: i64,
    /// T6: 精确位置 — 老 JSON 无此字段时默认 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seg_range: Option<Vec<SegRange>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Anchor {
    pub idx: i32,
    pub hash: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SegRange {
    pub segIdx: i32,
    pub start: i32,
    pub end: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NotesDoc {
    pub version: u32,
    pub fingerprint: String,
    pub highlights: Vec<Highlight>,
}

impl Default for NotesDoc {
    fn default() -> Self {
        Self { version: 1, fingerprint: String::new(), highlights: vec![] }
    }
}

#[tauri::command]
pub fn read_notes(app: AppHandle, fingerprint: String) -> Result<NotesDoc, String> {
    let path = notes_path(&app, &fingerprint)?;
    let mut doc = read_json::<NotesDoc>(&path)?.unwrap_or_default();
    doc.fingerprint = fingerprint;
    Ok(doc)
}

#[tauri::command]
pub fn write_notes(app: AppHandle, fingerprint: String, notes: NotesDoc) -> Result<(), String> {
    let path = notes_path(&app, &fingerprint)?;
    write_json(&path, &notes)
}

// ---- T3 粘贴预览 ----

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PasteItem {
    pub id: String,
    pub title: String,
    pub text: String,
    pub ts: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct PasteDoc {
    pub items: Vec<PasteItem>,
}

fn paste_path(app: &AppHandle) -> Result<PathBuf, String> {
    use crate::store::file_path;
    Ok(file_path(app, "pastes.json")?)
}

#[tauri::command]
pub fn save_paste(app: AppHandle, title: String, text: String) -> Result<PasteItem, String> {
    use crate::store::{atomic_write, read_json};
    use std::time::{SystemTime, UNIX_EPOCH};
    let path = paste_path(&app)?;
    let mut doc: PasteDoc = read_json(&path)?.unwrap_or_default();
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let id = format!("paste-{}", ts);
    let safe_title = if title.trim().is_empty() {
        let preview: String = text.chars().take(20).collect();
        if preview.is_empty() { "未命名粘贴".into() } else { preview }
    } else {
        title.chars().take(50).collect()
    };
    let item = PasteItem { id: id.clone(), title: safe_title, text, ts };
    let ret = item.clone();
    doc.items.push(item);
    // 保留最近 100 条
    if doc.items.len() > 100 {
        let drop_n = doc.items.len() - 100;
        doc.items.drain(0..drop_n);
    }
    let s = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&path, &s)?;
    Ok(ret)
}

#[tauri::command]
pub fn list_pastes(app: AppHandle) -> Result<Vec<PasteItem>, String> {
    use crate::store::read_json;
    let path = paste_path(&app)?;
    let doc: PasteDoc = read_json(&path)?.unwrap_or_default();
    Ok(doc.items)
}

#[tauri::command]
pub fn delete_paste(app: AppHandle, id: String) -> Result<(), String> {
    use crate::store::{atomic_write, read_json};
    let path = paste_path(&app)?;
    let mut doc: PasteDoc = read_json(&path)?.unwrap_or_default();
    doc.items.retain(|x| x.id != id);
    let s = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&path, &s)
}

// ---- T6 笔记库 — 聚合所有 notes-*.json ----

#[derive(Debug, Serialize, Clone)]
pub struct NoteLibItem {
    pub path: String,
    pub title: String,
    pub text: String,
    pub note: Option<String>,
    pub ts: i64,
    pub color: String,
}

#[tauri::command]
pub fn list_all_notes(app: AppHandle) -> Result<Vec<NoteLibItem>, String> {
    use crate::store::data_dir;
    let dir = data_dir(&app)?;
    let mut out: Vec<NoteLibItem> = vec![];
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if let Some(rest) = name.strip_prefix("notes-").and_then(|s| s.strip_suffix(".json")) {
                    if let Ok(doc) = read_json::<NotesDoc>(&p) {
                        if let Some(d) = doc {
                            for h in d.highlights {
                                out.push(NoteLibItem {
                                    path: h.anchor.idx.to_string(), // fingerprint 不能逆出 path
                                    title: d.fingerprint.clone(),
                                    text: h.text,
                                    note: h.note,
                                    ts: h.created_at,
                                    color: h.color,
                                });
                            }
                        }
                    }
                    let _ = rest;
                }
            }
        }
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

// ---- T3 书签 (与划线分离) ----

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Bookmark {
    pub id: String,
    pub path: String,
    pub title: String,
    pub seg_index: i32,
    pub ts: i64,
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct BookmarkDoc {
    pub items: Vec<Bookmark>,
}

fn bookmark_path(app: &AppHandle) -> Result<PathBuf, String> {
    use crate::store::file_path;
    Ok(file_path(app, "bookmarks.json")?)
}

#[tauri::command]
pub fn add_bookmark(app: AppHandle, path: String, title: String, seg_index: i32) -> Result<Bookmark, String> {
    use crate::store::{atomic_write, read_json};
    use std::time::{SystemTime, UNIX_EPOCH};
    let p = bookmark_path(&app)?;
    let mut doc: BookmarkDoc = read_json(&p)?.unwrap_or_default();
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let id = format!("bm-{}", ts);
    let bm = Bookmark { id: id.clone(), path, title, seg_index, ts, note: None };
    let ret = bm.clone();
    doc.items.push(bm);
    // 保留最近 200 条
    if doc.items.len() > 200 {
        let drop_n = doc.items.len() - 200;
        doc.items.drain(0..drop_n);
    }
    let s = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&p, &s)?;
    Ok(ret)
}

#[tauri::command]
pub fn list_bookmarks(app: AppHandle) -> Result<Vec<Bookmark>, String> {
    use crate::store::read_json;
    let p = bookmark_path(&app)?;
    let doc: BookmarkDoc = read_json(&p)?.unwrap_or_default();
    Ok(doc.items)
}

#[tauri::command]
pub fn delete_bookmark(app: AppHandle, id: String) -> Result<(), String> {
    use crate::store::{atomic_write, read_json};
    let p = bookmark_path(&app)?;
    let mut doc: BookmarkDoc = read_json(&p)?.unwrap_or_default();
    doc.items.retain(|x| x.id != id);
    let s = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&p, &s)
}
