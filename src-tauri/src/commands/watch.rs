// src-tauri/src/commands/watch.rs
// notify 监听 + 防抖 + 事件 emit。
// D3 完善：当前占位实现已可用（单文档实时同步）。

use notify::{Event, EventKind, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Clone)]
pub struct WatchEvent {
    pub path: String,
    pub kind: String,
    pub ts: i64,
}

static WATCHER: once_cell::sync::Lazy<Mutex<Option<notify::RecommendedWatcher>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

#[tauri::command]
pub fn start_watch(app: AppHandle, path: String) -> Result<(), String> {
    // 停掉旧 watcher
    stop_watch();

    let pb = PathBuf::from(&path);
    let parent = pb.parent().ok_or_else(|| "no parent dir".to_string())?.to_path_buf();
    let target = pb.file_name().ok_or_else(|| "no file name".to_string())?.to_os_string();

    let (tx, rx) = mpsc::channel::<Event>();
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                let _ = tx.send(ev);
            }
        })
        .map_err(|e| format!("watcher: {e}"))?;

    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch start: {e}"))?;

    *WATCHER.lock() = Some(watcher);

    // 事件循环：单线程后台任务，300ms 防抖
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<(PathBuf, Instant)> = None;
        let debounce = Duration::from_millis(300);
        while let Ok(ev) = rx.recv() {
            // 只关心目标文件
            if ev.paths.iter().any(|p| p.file_name() == Some(target.as_os_str())) {
                let kind = match ev.kind {
                    EventKind::Create(_) => "create",
                    EventKind::Modify(_) => "modify",
                    EventKind::Remove(_) => "remove",
                    _ => continue,
                };
                let now = Instant::now();
                if let Some((_, last_t)) = last {
                    if now.duration_since(last_t) < debounce {
                        last = Some((ev.paths[0].clone(), now));
                        continue;
                    }
                }
                last = Some((ev.paths[0].clone(), now));
                let payload = WatchEvent {
                    path: ev.paths[0].to_string_lossy().to_string(),
                    kind: kind.into(),
                    ts: now.elapsed().as_millis() as i64,
                };
                let _ = app_clone.emit("watch_event", &payload);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_watch() {
    *WATCHER.lock() = None;
}
