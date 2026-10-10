// src-tauri/src/commands/inbox.rs
// T4 收件箱（手动版）+ T7 跨库搜索 (FTS5 + trigram)

use rusqlite::Connection;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use crate::store::{data_dir, read_json, SHELF_FILE};
use serde::Deserialize;

// ---- T4 收件箱 ----

#[derive(Debug, Serialize)]
pub struct InboxItem {
    pub path: String,
    pub name: String,
    pub mtime: i64,
}

#[derive(Debug, Serialize)]
pub struct InboxScanResult {
    pub path: String,
    pub items: Vec<InboxItem>,
    pub ignored: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Shelf {
    items: Vec<ShelfItem>,
}

#[derive(Debug, Deserialize)]
struct ShelfItem {
    path: String,
    title: String,
}

#[tauri::command]
pub fn scan_inbox(app: AppHandle, prefs: serde_json::Value) -> Result<InboxScanResult, String> {
    let inbox_path = prefs.get("inboxPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let ignored: Vec<String> = prefs.get("inboxIgnored")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    if inbox_path.is_empty() {
        return Ok(InboxScanResult { path: String::new(), items: vec![], ignored });
    }

    let dir = data_dir(&app)?;
    let shelf_path = dir.join(SHELF_FILE);
    let shelf: Shelf = read_json::<Shelf>(&shelf_path)?.unwrap_or(Shelf { items: vec![] });
    let registered: std::collections::HashSet<String> = shelf.items.into_iter()
        .map(|x| normalize_path(&x.path))
        .collect();

    let mut items: Vec<InboxItem> = vec![];
    let p = Path::new(&inbox_path);
    if p.exists() && p.is_dir() {
        if let Ok(entries) = fs::read_dir(p) {
            for e in entries.flatten() {
                let path_str = e.path().to_string_lossy().into_owned();
                let norm = normalize_path(&path_str);
                if registered.contains(&norm) { continue; }
                if !is_md(&e.path()) { continue; }
                let mtime = e.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                items.push(InboxItem {
                    path: path_str,
                    name: e.file_name().to_string_lossy().into_owned(),
                    mtime,
                });
            }
        }
    }
    items.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(InboxScanResult { path: inbox_path, items, ignored })
}

fn normalize_path(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

fn is_md(p: &Path) -> bool {
    let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
    matches!(ext.as_str(), "md" | "markdown" | "txt")
}

// ---- T7 跨库搜索 ----

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub seg_index: i32,
    pub snippet: String,
}

// ---- T3 浏览记录 ----

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HistoryEntry {
    pub path: String,
    pub ts: i64,
    pub kind: String, // open / highlight / close
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct HistoryDoc {
    pub entries: Vec<HistoryEntry>,
}

#[tauri::command]
pub fn push_history(app: AppHandle, path: String, kind: String) -> Result<(), String> {
    use crate::store::{atomic_write, file_path, read_json};
    use std::time::{SystemTime, UNIX_EPOCH};
    let p = file_path(&app, "history.json")?;
    let mut doc: HistoryDoc = read_json(&p)?.unwrap_or_default();
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    // T5: 同文件去重 — 移除该 path 的旧条目
    doc.entries.retain(|x| x.path != path);
    doc.entries.push(HistoryEntry { path, ts, kind });
    // 限制最近 100 条
    if doc.entries.len() > 100 {
        let drop_n = doc.entries.len() - 100;
        doc.entries.drain(0..drop_n);
    }
    let s = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&p, &s)
}

#[tauri::command]
pub fn list_history(app: AppHandle) -> Result<Vec<HistoryEntry>, String> {
    use crate::store::{file_path, read_json};
    let p = file_path(&app, "history.json")?;
    let doc: HistoryDoc = read_json(&p)?.unwrap_or_default();
    Ok(doc.entries)
}

#[tauri::command]
pub fn remove_history_entry(app: AppHandle, path: String, ts: i64) -> Result<(), String> {
    use crate::store::{atomic_write, file_path, read_json};
    let p = file_path(&app, "history.json")?;
    let mut doc: HistoryDoc = read_json(&p)?.unwrap_or_default();
    doc.entries.retain(|x| !(x.path == path && x.ts == ts));
    let s = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&p, &s)
}

#[tauri::command]
pub fn clear_history(app: AppHandle) -> Result<(), String> {
    use crate::store::{atomic_write, file_path};
    let p = file_path(&app, "history.json")?;
    let doc = HistoryDoc::default();
    let s = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&p, &s)
}

// ---- T2 目录树递归 ----

#[derive(Debug, Serialize)]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub kind: String, // dir / file
    pub children: Vec<FolderNode>,
}

#[tauri::command]
pub fn list_folder_tree(path: String, max_depth: i32) -> Result<FolderNode, String> {
    // P1 性能: 限制子目录数量, 避免一次扫出几万个节点
    const MAX_CHILDREN_PER_DIR: usize = 500;
    // P1 性能: 限制总节点数, 超过就截断返回
    fn build(p: &Path, depth: i32) -> Option<(FolderNode, usize)> {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned());
        let md = p.is_dir();
        let kind = if md { "dir" } else if is_md(p) { "file" } else { return None };
        let mut children = vec![];
        let mut total = 1usize;
        if md && depth > 0 {
            if let Ok(entries) = fs::read_dir(p) {
                let mut sorted: Vec<_> = entries.flatten().take(MAX_CHILDREN_PER_DIR).collect();
                // P1: 用 entry.file_name() 而非 path(), 避免分配 String
                sorted.sort_by(|a, b| {
                    let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    b_is_dir.cmp(&a_is_dir) // 目录在前
                });
                for e in sorted {
                    if total > 3000 { break; } // 硬上限
                    if let Some((c, n)) = build(&e.path(), depth - 1) {
                        children.push(c);
                        total += n;
                    }
                }
            }
        }
        Some((
            FolderNode {
                name,
                path: p.to_string_lossy().into_owned(),
                kind: kind.to_string(),
                children,
            },
            total,
        ))
    }
    let (root, _) = build(Path::new(&path), max_depth).ok_or_else(|| "无效路径".to_string())?;
    Ok(root)
}

#[tauri::command]
pub fn search_documents(app: AppHandle, query: String, limit: i32) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() { return Ok(vec![]); }
    let db_path = data_dir(&app)?.join("search.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("open db: {e}"))?;

    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, title UNINDEXED, seg_index UNINDEXED, content, tokenize='trigram');"
    ).map_err(|e| format!("create fts: {e}"))?;

    // 从 shelf.json 加载所有文档到 FTS
    let dir = data_dir(&app)?;
    let shelf_path = dir.join(SHELF_FILE);
    let shelf: Shelf = read_json::<Shelf>(&shelf_path)?.unwrap_or(Shelf { items: vec![] });

    let already_count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT path) FROM docs", [], |r| r.get(0),
    ).unwrap_or(0);
    let need_mtime = (already_count as usize) < shelf.items.len();

    if need_mtime {
        for item in &shelf.items {
            let pb = PathBuf::from(&item.path);
            if !pb.exists() { continue; }
            // 检查是否已索引该 path
            let exists: bool = conn.query_row(
                "SELECT 1 FROM docs WHERE path = ? LIMIT 1",
                [&item.path], |_| Ok(true),
            ).unwrap_or(false);
            if exists { continue; }
            let text = match fs::read_to_string(&pb) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let mut seg_index = 0i32;
            let mut buf = String::new();
            for line in text.lines() {
                if line.is_empty() {
                    if !buf.is_empty() {
                        let _ = conn.execute(
                            "INSERT INTO docs(path, title, seg_index, content) VALUES (?, ?, ?, ?)",
                            rusqlite::params![&item.path, &item.title, seg_index, &buf],
                        );
                        buf.clear();
                        seg_index += 1;
                    }
                } else {
                    if !buf.is_empty() { buf.push(' '); }
                    buf.push_str(line);
                }
            }
            if !buf.is_empty() {
                let _ = conn.execute(
                    "INSERT INTO docs(path, title, seg_index, content) VALUES (?, ?, ?, ?)",
                    rusqlite::params![&item.path, &item.title, seg_index, &buf],
                );
            }
        }
    }

    let pattern = format!("\"{}\"", query.replace('"', "\"\""));
    let mut stmt = conn.prepare(
        "SELECT path, title, seg_index, snippet(docs, 3, '<mark>', '</mark>', '...', 12) FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?"
    ).map_err(|e| format!("prepare: {e}"))?;
    let hits = stmt.query_map(
        rusqlite::params![&pattern, limit],
        |row| {
            let path: String = row.get(0)?;
            let title: String = row.get(1)?;
            let seg_index: i32 = row.get(2)?;
            let snippet: String = row.get(3)?;
            Ok(SearchHit { path, title, seg_index, snippet })
        },
    ).map_err(|e| format!("query: {e}"))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(hits)
}