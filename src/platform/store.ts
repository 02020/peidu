// platform/store.ts
// prefs / shelf / notes / book 的读写——走 Tauri 命令（后端原子写 JSON 文件）。
// D0 只做 prefs + shelf；D2 加 notes。

import { invoke } from '@tauri-apps/api/core';

// ---- 类型 ----

export type Theme = 'light' | 'sepia' | 'dark';

export interface Prefs {
  version: 1;
  theme: Theme;
  fontSize: number;
  fontFamily: string; // Q4: 字体族 — lxgw | system | songti
  bigMode: boolean;
  animations: boolean;
  inboxPath: string | null;
  inboxIgnored: string[];
  fontBundled: boolean;
  trayEnabled: boolean;
  /** T3: 最近浏览的文件夹路径数组 (启动时自动加载最后一个) */
  lastFolderPaths: string[];
}

export interface ShelfItem {
  path: string;
  title: string;
  maxAnchor: number;
  totalSegs: number;
  dur: number;
  lastOpen: number;
}

export interface Shelf {
  version: 1;
  items: ShelfItem[];
}

export interface Book {
  path: string;
  text: string;
  cursor: number;
}

// ---- Notes / 划线 / 速记 ----

export interface Anchor {
  idx: number;
  hash: number;
}

/** T6: 划线/想法的精确位置 (在原始段中的字符偏移) */
export interface HighlightSegRange {
  segIdx: number;
  start: number;
  end: number;
}

export interface Highlight {
  id: string;
  anchor: Anchor;
  text: string;
  color: string;
  note: string | null;
  created_at: number;
  /** T6: 精确位置 — 老的 highlights 无此字段, wrap 时 fallback 文本搜索 */
  segRange?: HighlightSegRange[];
}

export interface NotesDoc {
  version: 1;
  fingerprint: string;
  highlights: Highlight[];
}

export const EMPTY_NOTES: NotesDoc = { version: 1, fingerprint: '', highlights: [] };

// ---- T3 粘贴预览 ----

export interface PasteItem {
  id: string;
  title: string;
  text: string;
  ts: number;
}

export async function savePaste(title: string, text: string): Promise<PasteItem> {
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<PasteItem>('save_paste', { title, text });
}

export async function listPastes(): Promise<PasteItem[]> {
  return await invoke<PasteItem[]>('list_pastes');
}

export async function deletePaste(id: string): Promise<void> {
  await invoke('delete_paste', { id });
}

// ---- 浏览记录操作 ----

export async function removeHistoryEntry(path: string, ts: number): Promise<void> {
  await invoke('remove_history_entry', { path, ts });
}

export async function clearHistory(): Promise<void> {
  await invoke('clear_history');
}

// ---- 书签 ----

export interface Bookmark {
  id: string;
  path: string;
  title: string;
  seg_index: number;
  ts: number;
  note: string | null;
}

export async function addBookmark(path: string, title: string, seg_index: number): Promise<Bookmark> {
  return await invoke<Bookmark>('add_bookmark', { path, title, seg_index });
}

export async function listBookmarks(): Promise<Bookmark[]> {
  return await invoke<Bookmark[]>('list_bookmarks');
}

export async function deleteBookmark(id: string): Promise<void> {
  await invoke('delete_bookmark', { id });
}

// ---- 默认值 ----

export const DEFAULT_PREFS: Prefs = {
  version: 1,
  theme: 'sepia',
  fontSize: 18,
  fontFamily: 'lxgw',
  bigMode: false,
  animations: true,
  inboxPath: null,
  inboxIgnored: [],
  fontBundled: true,
  trayEnabled: false,
  lastFolderPaths: [],
};

export const EMPTY_SHELF: Shelf = { version: 1, items: [] };

// ---- 读 ----

export async function readPrefs(): Promise<Prefs> {
  return await invoke<Prefs>('read_prefs');
}

export async function readShelf(): Promise<Shelf> {
  return await invoke<Shelf>('read_shelf');
}

export async function readBook(): Promise<Book | null> {
  return await invoke<Book | null>('read_book');
}

// ---- 写 ----

export async function writePrefs(prefs: Prefs): Promise<void> {
  await invoke('write_prefs', { prefs });
}

export async function writeShelf(shelf: Shelf): Promise<void> {
  await invoke('write_shelf', { shelf });
}

export async function writeBook(book: Book): Promise<void> {
  await invoke('write_book', { book });
}

export async function readNotes(fingerprint: string): Promise<NotesDoc> {
  return await invoke<NotesDoc>('read_notes', { fingerprint });
}

export async function writeNotes(fingerprint: string, notes: NotesDoc): Promise<void> {
  await invoke('write_notes', { fingerprint, notes });
}

// ---- 收件箱 ----

export interface InboxItem {
  path: string;
  name: string;
  mtime: number;
}

export interface InboxScanResult {
  path: string;
  items: InboxItem[];
  ignored: string[];
}

export async function scanInbox(prefs: { inboxPath: string | null; inboxIgnored: string[] }): Promise<InboxScanResult> {
  return await invoke<InboxScanResult>('scan_inbox', {
    prefs: { inboxPath: prefs.inboxPath, inboxIgnored: prefs.inboxIgnored },
  });
}

// ---- 搜索 ----

export interface SearchHit {
  path: string;
  title: string;
  seg_index: number;
  snippet: string;
}

export async function searchDocuments(query: string, limit = 50): Promise<SearchHit[]> {
  return await invoke<SearchHit[]>('search_documents', { query, limit });
}

// ---- 浏览记录 ----

export type HistoryKind = 'open' | 'highlight' | 'close';

export interface HistoryEntry {
  path: string;
  ts: number;
  kind: HistoryKind;
}

export async function pushHistory(path: string, kind: HistoryKind): Promise<void> {
  await invoke('push_history', { path, kind });
}

export async function listHistory(): Promise<HistoryEntry[]> {
  return await invoke<HistoryEntry[]>('list_history');
}

// ---- T5 预览 ----

export async function readPreview(path: string, limit = 200): Promise<string> {
  return await invoke<string>('read_preview', { path, limit });
}

export async function copyPreview(path: string, limit = 200): Promise<void> {
  await invoke('copy_preview', { path, limit });
}
